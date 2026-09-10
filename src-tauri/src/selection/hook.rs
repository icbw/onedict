//! 全局输入钩子线程：`WH_MOUSE_LL`（划词触发 + 浮标隐藏）+ `WH_KEYBOARD_LL`（浮标隐藏）。
//!
//! 纪律（全局鼠标钩子回调阻塞会拖慢整机鼠标）：
//! - 回调内只做：状态机更新（Mutex 短临界区）+ `try_send`（有界通道，满了即丢陈旧事件）；
//! - 回调内**禁止** UIA / Tauri emit / 大分配 / 阻塞调用，一切移交 capture worker；
//! - 注入事件（LLMHF/LLKHF_INJECTED）忽略，为后续剪贴板兜底（模拟 Ctrl+C）留出回路。
//!
//! LL 钩子收不到 `WM_LBUTTONDBLCLK`，双击按「时间 + 位移矩形」自行判定（系统双击参数）。

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, GetSystemMetrics, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, KBDLLHOOKSTRUCT_FLAGS, LLKHF_INJECTED,
    LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, SM_CXDOUBLECLK, SM_CYDOUBLECLK, WH_KEYBOARD_LL,
    WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
    WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONDOWN, WM_SYSKEYDOWN,
};

use super::layout::Point;
use super::{TriggerMode, SHARED, WorkerMsg};

/// 拖拽判定：释放点距按下点 ≥ 6px（物理）视为拖拽选区
const DRAG_THRESHOLD_PX: i32 = 6;

/// ctrlkey 触发模式的按住时长下限（pickdict 基线 350ms）：区分「按住 Ctrl 触发」
/// 与 Ctrl+C 等组合（按下到松开通常 <350ms，且组合键的另一半按下时已置无效）
const CTRL_HOLD_MS: u128 = 350;

/// 拖拽判定（纯函数 提出可测）：距按下点阈值内为点击。
fn is_drag(start: Point, end: Point) -> bool {
    let dx = (end.x - start.x).abs();
    let dy = (end.y - start.y).abs();
    dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX
}

/// 双击判定（纯函数 提出可测）：与上一次按下比时间与位移矩形，
/// 两轴独立比对、边界含（系统 GetDoubleClickTime / SM_CXDOUBLECLK 语义）。
fn is_double_click(
    prev: Option<(Point, Instant)>,
    now: Instant,
    pt: Point,
    double_time_ms: u32,
    double_tol_px: i32,
) -> bool {
    prev.is_some_and(|(p, t)| {
        now.duration_since(t).as_millis() as u32 <= double_time_ms
            && (p.x - pt.x).abs() <= double_tol_px
            && (p.y - pt.y).abs() <= double_tol_px
    })
}

// VK 修饰键（pickdict 过滤表）：L/R shift = 160/161，L/R alt = 164/165——用于扩展选区，按下不隐藏浮标
const VK_SHIFT_L: u32 = 160;
const VK_SHIFT_R: u32 = 161;
const VK_ALT_L: u32 = 164;
const VK_ALT_R: u32 = 165;
// L/R control = 162/163——ctrlkey 触发模式的触发键（非 ctrlkey 模式按下照常隐藏浮标）
const VK_CTRL_L: u32 = 162;
const VK_CTRL_R: u32 = 163;

static SENDER: OnceLock<SyncSender<WorkerMsg>> = OnceLock::new();
/// 钩子线程 id（0 = 未运行；restart 需可写 → AtomicU32）
static THREAD_ID: AtomicU32 = AtomicU32::new(0);
/// 钩子线程 join handle（stop 必须 join——原实现只投递 WM_QUIT
/// 不等待，快速「关→开→关」时 THREAD_ID 尚未登记会漏投递，漏卸载的旧钩子与
/// 新钩子并存 → 划词重复触发）
static HOOK_JOIN: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

struct ClickState {
    last_down: Option<Point>,
    down_was_double: bool,
    prev_down: Option<(Point, Instant)>,
    double_time_ms: u32,
    double_tol_px: i32,
}

impl ClickState {
    fn new() -> Self {
        // SAFETY: 无参数 Win32 查询
        let (double_time_ms, double_tol_px) = unsafe {
            (
                GetDoubleClickTime(),
                GetSystemMetrics(SM_CXDOUBLECLK).max(GetSystemMetrics(SM_CYDOUBLECLK)) / 2,
            )
        };
        Self {
            last_down: None,
            down_was_double: false,
            prev_down: None,
            double_time_ms: double_time_ms.max(1),
            double_tol_px: double_tol_px.max(2),
        }
    }
}

static CLICK: OnceLock<Mutex<ClickState>> = OnceLock::new();

// ── ctrlkey 触发模式状态─────────────────────────────────────────
//
// 语义（pickdict handleKeyDownCtrlkeyMode 基线）：按住 Ctrl 达 CTRL_HOLD_MS
// （键盘自动重复的 down 事件为时钟）→ 捕获当前选区；期间出现以下任一干扰即置
// 无效，防组合键（Ctrl+C）/缩放（Ctrl+滚轮）/多选（Ctrl+点击）误触发：
// - 按下任何其他键
// - 鼠标按下（多选）/滚轮（缩放）
// 触发一次后置无效，长按不重复弹；松开 Ctrl 复位。

struct CtrlState {
    /// Ctrl 按下时刻（None = 未按住）
    down_at: Option<Instant>,
    /// 按住期间出现干扰/已触发 → 无效
    invalidated: bool,
}

static CTRL: OnceLock<Mutex<CtrlState>> = OnceLock::new();

fn ctrl_state() -> &'static Mutex<CtrlState> {
    CTRL.get_or_init(|| Mutex::new(CtrlState { down_at: None, invalidated: false }))
}

/// 触发判定（纯函数，可测）：距按下时长达限 → 触发
fn should_trigger_hold(elapsed_ms: u128) -> bool {
    elapsed_ms >= CTRL_HOLD_MS
}

/// Ctrl key-down 处理（钩子回调内：状态机 + try_send，遵守回调纪律）。
/// 双触发路径：①按住中经键盘自动重复 down 判定 ≥350ms → 立即触发（长按中途弹）；
/// ②松开时（handle_ctrl_up）按住时长 ≥350ms 且未被置无效 → 触发——**必须保留**：
/// Windows 键盘 RepeatDelay 默认 500ms，短于它的按住不会产生重复 down，只靠①
/// 会漏掉 350–500ms 区间的按住（用户实测「ctrl 查词不生效」根因）。
fn handle_ctrl_down() {
    let Ok(mut st) = ctrl_state().lock() else { return };
    let Some(t0) = st.down_at else {
        st.down_at = Some(Instant::now());
        st.invalidated = false;
        return;
    };
    if st.invalidated {
        return;
    }
    let elapsed = t0.elapsed().as_millis();
    if !should_trigger_hold(elapsed) {
        return; // 自动重复 down，未达时长
    }
    st.invalidated = true; // 触发一次，长按不重复
    drop(st);
    if let Some(tx) = SENDER.get() {
        let _ = tx.try_send(WorkerMsg::LookupCaret);
    }
}

/// Ctrl 释放：按住达时长且未被置无效（组合键/滚轮/多选）→ 触发后复位。
fn handle_ctrl_up() {
    let fire = {
        let Ok(mut st) = ctrl_state().lock() else { return };
        let Some(t0) = st.down_at else { return };
        let elapsed = t0.elapsed().as_millis();
        st.down_at = None;
        let held = !st.invalidated && should_trigger_hold(elapsed);
        st.invalidated = false;
        held
    };
    if fire {
        if let Some(tx) = SENDER.get() {
            let _ = tx.try_send(WorkerMsg::LookupCaret);
        }
    }
}

/// 非 Ctrl 键按下 / 鼠标按下 / 滚轮：按住置无效（Ctrl+C、缩放、多选防误触）
fn invalidate_ctrl_hold() {
    if let Ok(mut st) = ctrl_state().lock() {
        if st.down_at.is_some() {
            st.invalidated = true;
        }
    }
}

/// 安装钩子线程（非阻塞）。重复调用安全（sender/CLICK 仅首次生效）。
pub fn start(sender: SyncSender<WorkerMsg>) {
    let _ = SENDER.set(sender);
    let _ = CLICK.set(Mutex::new(ClickState::new()));
    restart();
}

/// 启钩子线程。先 stop（幂等：防未经 stop 的重复 restart
/// 叠加多套 LL 钩子）；新线程登记 THREAD_ID 后才返回，保证后续 stop 必能投递。
pub fn restart() {
    stop();
    match std::thread::Builder::new()
        .name("selection-hook".into())
        .spawn(|| unsafe { hook_thread() })
    {
        Ok(handle) => {
            *HOOK_JOIN.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
        }
        Err(e) => {
            tracing::error!("selection: failed to spawn hook thread: {e}");
            return;
        }
    }
    // 等待新线程登记 thread id（线程入口第一行即 store，纳秒级；2s 超时防系统
    // 异常时挂死调用方——stop 的 join 只在 id 有效时有投递保障）
    let deadline = Instant::now() + std::time::Duration::from_secs(2);
    while THREAD_ID.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    if THREAD_ID.load(Ordering::SeqCst) == 0 {
        tracing::error!("selection: hook thread did not register id within 2s");
    }
}

/// 停止钩子线程：投递 WM_QUIT + join（线程退出前自行 Unhook + 清零 THREAD_ID）。
pub fn stop() {
    let id = THREAD_ID.load(Ordering::SeqCst);
    if id != 0 {
        // SAFETY: PostThreadMessageW 仅向本进程线程投递 WM_QUIT
        unsafe {
            let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    if let Some(handle) = HOOK_JOIN.lock().unwrap_or_else(|e| e.into_inner()).take() {
        // 消息泵收到 WM_QUIT 立即退出，join 毫秒级返回；保证 Unhook 完成后才返回
        let _ = handle.join();
    }
    THREAD_ID.store(0, Ordering::SeqCst);
}

/// 通知 capture worker 隐藏浮标（disable 路径；sender 为静态通道，钩子线程死后仍可用）
pub fn send_disable() {
    if let Some(tx) = SENDER.get() {
        let _ = tx.try_send(WorkerMsg::Disable);
    }
}

/// 划词查词触发（快捷键路径，tray.rs 调用）：worker 自取前台 caret 定位捕获
pub fn send_lookup_caret() {
    if let Some(tx) = SENDER.get() {
        let _ = tx.try_send(WorkerMsg::LookupCaret);
    }
}

/// 通用消息投递（clipmon 剪贴板监听线程复用；静态通道，钩子线程死后仍可用）
pub(super) fn send_worker(msg: WorkerMsg) {
    if let Some(tx) = SENDER.get() {
        let _ = tx.try_send(msg);
    }
}

unsafe fn hook_thread() {
    THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

    let mouse_hook: Result<HHOOK, windows::core::Error> =
        SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0);
    let kbd_hook: Result<HHOOK, windows::core::Error> =
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(kbd_proc), None, 0);

    match (&mouse_hook, &kbd_hook) {
        (Ok(_), Ok(_)) => tracing::info!("selection: LL hooks installed (mouse + keyboard)"),
        (Err(e), _) | (_, Err(e)) => {
            tracing::error!("selection: failed to install LL hook: {e}");
        }
    }

    // 消息泵：WM_QUIT → 退出循环
    let mut msg = MSG::default();
    loop {
        let r = GetMessageW(&mut msg, None, 0, 0);
        if r.0 <= 0 {
            break;
        }
    }

    if let Ok(h) = mouse_hook {
        let _ = UnhookWindowsHookEx(h);
    }
    if let Ok(h) = kbd_hook {
        let _ = UnhookWindowsHookEx(h);
    }
    // 线程退出前清零（stop 的防御性 store 之外，这里保证「线程已死 ⇒ id 已清」）
    THREAD_ID.store(0, Ordering::SeqCst);
    tracing::info!("selection: LL hooks uninstalled");
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: 系统保证 lParam 指向 MSLLHOOKSTRUCT
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        if info.flags & LLMHF_INJECTED == 0 {
            let pt = Point {
                x: info.pt.x,
                y: info.pt.y,
            };
            handle_mouse(wparam.0 as u32, pt);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn kbd_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: 系统保证 lParam 指向 KBDLLHOOKSTRUCT
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if info.flags & LLKHF_INJECTED == KBDLLHOOKSTRUCT_FLAGS(0) {
            let msg = wparam.0 as u32;
            let vk = info.vkCode;
            let is_ctrl = vk == VK_CTRL_L || vk == VK_CTRL_R;
            let ctrlkey_mode = super::trigger_mode() == TriggerMode::Ctrlkey;
            match msg {
                WM_KEYDOWN | WM_SYSKEYDOWN => {
                    // ctrlkey 模式下 Ctrl 是触发键：按下不隐藏浮标（pickdict 基线）；
                    // 其他模式 Ctrl 照旧隐藏。非修饰键照旧隐藏。
                    let is_selection_modifier = vk == VK_SHIFT_L
                        || vk == VK_SHIFT_R
                        || vk == VK_ALT_L
                        || vk == VK_ALT_R;
                    if !is_selection_modifier && !(ctrlkey_mode && is_ctrl) {
                        hide_if_visible();
                    }
                    if ctrlkey_mode {
                        if is_ctrl {
                            handle_ctrl_down();
                        } else {
                            invalidate_ctrl_hold(); // 组合键另一半按下 → 本轮无效
                        }
                    }
                }
                WM_KEYUP => {
                    if is_ctrl {
                        handle_ctrl_up();
                    }
                }
                _ => {}
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn handle_mouse(msg: u32, pt: Point) {
    // ctrlkey 模式：按住 Ctrl 期间的鼠标按下（多选）/滚轮（缩放）→ 无效
    let ctrlkey_mode = super::trigger_mode() == TriggerMode::Ctrlkey;
    match msg {
        WM_LBUTTONDOWN => {
            if ctrlkey_mode {
                invalidate_ctrl_hold();
            }
            // 双击判定：与上一次按下比时间与位移（系统双击参数）
            let now = Instant::now();
            if let Some(cl) = CLICK.get() {
                if let Ok(mut st) = cl.lock() {
                    let is_double = is_double_click(
                        st.prev_down,
                        now,
                        pt,
                        st.double_time_ms,
                        st.double_tol_px,
                    );
                    st.prev_down = Some((pt, now));
                    st.last_down = Some(pt);
                    st.down_was_double = is_double;
                }
            }
            send_hide_if_outside(pt);
        }
        WM_RBUTTONDOWN | WM_MBUTTONDOWN => {
            if ctrlkey_mode {
                invalidate_ctrl_hold();
            }
            send_hide_if_outside(pt);
        }
        WM_LBUTTONUP => {
            // 仅 selected 触发方式由拖选/双击弹浮标；ctrlkey/shortcut 是显式动作
            // 触发，拖选本身不弹（pickdict setSelectionPassiveMode 语义）
            if super::trigger_mode() != TriggerMode::Selected {
                return;
            }
            let Some(cl) = CLICK.get() else { return };
            let Ok(mut st) = cl.lock() else { return };
            let Some(start) = st.last_down.take() else { return };
            let drag = is_drag(start, pt);
            if drag || st.down_was_double {
                if let Some(tx) = SENDER.get() {
                    // t0 = 钩子回调收到鼠标 up 的时刻（性能链起点）
                    let _ = tx.try_send(WorkerMsg::Trigger(super::TriggerInfo {
                        start,
                        end: pt,
                        is_double_click: st.down_was_double,
                        t0: Instant::now(),
                    }));
                }
            }
        }
        WM_MOUSEWHEEL => {
            if ctrlkey_mode {
                invalidate_ctrl_hold();
            }
            hide_if_visible();
        }
        _ => {}
    }
}

/// 浮标可见且点击在其外 → 请求隐藏（pickdict：外部 mouse-down 隐藏）
fn send_hide_if_outside(pt: Point) {
    if let Ok(st) = SHARED.lock() {
        if st.toolbar_visible {
            let outside = match st.toolbar {
                Some(r) => pt.x < r.x || pt.x >= r.x + r.w || pt.y < r.y || pt.y >= r.y + r.h,
                None => true,
            };
            if outside {
                if let Some(tx) = SENDER.get() {
                    let _ = tx.try_send(WorkerMsg::Hide);
                }
            }
        }
    }
}

fn hide_if_visible() {
    if let Ok(st) = SHARED.lock() {
        if st.toolbar_visible {
            if let Some(tx) = SENDER.get() {
                let _ = tx.try_send(WorkerMsg::Hide);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const DT_MS: u32 = 500;
    const TOL: i32 = 4;

    #[test]
    fn double_click_within_time_and_tolerance() {
        let t0 = Instant::now();
        std::thread::sleep(Duration::from_millis(5));
        assert!(is_double_click(
            Some((Point { x: 100, y: 100 }, t0)),
            Instant::now(),
            Point { x: 104, y: 100 },
            DT_MS,
            TOL,
        ));
    }

    #[test]
    fn beyond_time_is_not_double() {
        // 系统时钟回拨防护：past 直接用 now 往前推（进程 uptime 远大于偏移，安全）
        let t0 = Instant::now() - Duration::from_millis(600);
        assert!(!is_double_click(
            Some((Point { x: 100, y: 100 }, t0)),
            Instant::now(),
            Point { x: 100, y: 100 },
            DT_MS,
            TOL,
        ));
    }

    #[test]
    fn beyond_tolerance_on_either_axis_is_not_double() {
        let t0 = Instant::now();
        // x 轴超容差（5 > 4）
        assert!(!is_double_click(
            Some((Point { x: 100, y: 100 }, t0)),
            Instant::now(),
            Point { x: 105, y: 100 },
            DT_MS,
            TOL,
        ));
        // y 轴独立判定：x 合规 y 超容差同样不成立
        assert!(!is_double_click(
            Some((Point { x: 100, y: 100 }, t0)),
            Instant::now(),
            Point { x: 100, y: 105 },
            DT_MS,
            TOL,
        ));
    }

    #[test]
    fn tolerance_boundary_is_inclusive() {
        let t0 = Instant::now();
        // 位移恰为容差→ 仍判双击
        assert!(is_double_click(
            Some((Point { x: 100, y: 100 }, t0)),
            Instant::now(),
            Point { x: 96, y: 104 },
            DT_MS,
            TOL,
        ));
    }

    #[test]
    fn no_prev_down_is_never_double() {
        assert!(!is_double_click(
            None,
            Instant::now(),
            Point { x: 0, y: 0 },
            DT_MS,
            TOL,
        ));
    }

    #[test]
    fn drag_threshold_matrix() {
        // 3-4-5 三角：位移 (3,4) 距离恰 5 ≥ 6？否——(6,0) 与 (4,5) 才越阈
        assert!(!is_drag(Point { x: 0, y: 0 }, Point { x: 5, y: 2 })); // √29 ≈ 5.39 < 6
        assert!(is_drag(Point { x: 0, y: 0 }, Point { x: 6, y: 0 })); // 恰为阈值（含）
        assert!(is_drag(Point { x: 0, y: 0 }, Point { x: 4, y: 5 })); // √41 > 6
        assert!(!is_drag(Point { x: 10, y: 10 }, Point { x: 10, y: 10 })); // 原地
    }

    #[test]
    fn ctrl_hold_threshold() {
        // 350ms 下限：恰达阈值即触发；未达不触发
        assert!(!should_trigger_hold(0));
        assert!(!should_trigger_hold(349));
        assert!(should_trigger_hold(350));
        assert!(should_trigger_hold(10_000));
    }
}
