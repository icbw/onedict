//!  划词 spike 模块组装。
//!
//! 线程模型：
//! - hook 线程（hook.rs）：LL 鼠标/键盘钩子 + 消息泵，回调内仅状态机 + try_send；
//! - capture worker（capture.rs）：COM MTA + UIA 捕获 + 窗口操作 + emit + 埋点；
//! - 二者经有界通道（cap 32）单向通信：Trigger / Hide / Disable，满则丢弃陈旧事件。

pub mod capture;
pub mod clipmon;
pub mod clipboard;
pub mod filter;
pub mod hook;
pub mod layout;
pub mod perf;
pub mod uia;

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Position};

use layout::PhysRect;

/// 动作面板逻辑尺寸（与 tauri.conf.json 中 action-panel 配置一致）
pub const PANEL_LOGICAL_W: f64 = 480.0;
pub const PANEL_LOGICAL_H: f64 = 600.0;

/// 划词触发方式（pickdict SelectionTriggerMode 语义基线）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerMode {
    /// 拖选/双击即触发（默认）
    Selected,
    /// 按住 Ctrl ≥350ms（期间无其他键/滚轮/鼠标按下）捕获当前选区
    Ctrlkey,
    /// 全局快捷键触发（hotkeys.trigger_lookup 槽位）
    Shortcut,
}

impl TriggerMode {
    pub fn from_pref(s: &str) -> Self {
        match s {
            "ctrlkey" => Self::Ctrlkey,
            "shortcut" => Self::Shortcut,
            _ => Self::Selected,
        }
    }

    fn to_u8(self) -> u8 {
        match self {
            Self::Selected => 0,
            Self::Ctrlkey => 1,
            Self::Shortcut => 2,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Ctrlkey,
            2 => Self::Shortcut,
            _ => Self::Selected,
        }
    }
}

/// 当前触发方式（钩子回调高频读 → AtomicU8；写方 = 偏好命令/恢复）
static TRIGGER: AtomicU8 = AtomicU8::new(0);

pub fn trigger_mode() -> TriggerMode {
    TriggerMode::from_u8(TRIGGER.load(Ordering::Relaxed))
}

/// 偏好 → static 同步（prefs_set_selection_capture / restore_from_prefs 调用）。
/// filter::apply 与本函数必须同批调用（blacklist 并入预定义依赖 trigger 判定）。
pub fn apply_capture_prefs(trigger: &str, filter_mode: &str, filter_list: &[String]) {
    TRIGGER.store(TriggerMode::from_pref(trigger).to_u8(), Ordering::Relaxed);
    filter::apply(trigger, filter_mode, filter_list);
}

/// 钩子回调与 worker 间通信
#[derive(Debug)]
pub enum WorkerMsg {
    /// 左键 up：拖拽或双击触发捕获（t0 = 回调收到 up 的时刻）
    Trigger(TriggerInfo),
    /// ctrlkey/shortcut 触发：无鼠标坐标，worker 自取前台 caret/窗口中心定位
    LookupCaret,
    /// 剪贴板监听触发：文本已就绪，直接显示浮标；anchor = 通知时刻鼠标位置
    Clipboard { text: String, anchor: Point },
    /// 外部 mouse-down / 滚轮 / 非修饰键 key-down → 隐藏浮标
    Hide,
    /// 功能关闭 → 隐藏浮标
    Disable,
}

#[derive(Debug)]
pub struct TriggerInfo {
    pub start: Point,
    pub end: Point,
    pub is_double_click: bool,
    pub t0: Instant,
}

pub use layout::Point;

/// 钩子回调读取的共享状态（浮标物理 bounds + 可见性）。
/// 写方：capture worker；读方：hook 回调（短临界区）。
pub struct SharedState {
    pub toolbar: Option<PhysRect>,
    pub toolbar_visible: bool,
    /// 最近一次成功捕获的文本（动作面板取词来源）
    pub last_text: String,
    /// 动作面板 pin 常驻（pinned 时不随失焦隐藏）
    pub panel_pinned: bool,
    /// 动作隐藏后的短暂抑制窗（动作点击的 mouse up 可能晚于 hide
    /// 到达捕获链 → 浮标「关闭后又出现」；仅动作隐藏路径记录，700ms 内不重弹）
    pub suppress_until: Option<std::time::Instant>,
}

pub static SHARED: Mutex<SharedState> = Mutex::new(SharedState {
    toolbar: None,
    toolbar_visible: false,
    last_text: String::new(),
    panel_pinned: false,
    suppress_until: None,
});

static ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 剪贴板兜底开关
static CLIPBOARD_FALLBACK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

pub fn clipboard_fallback_enabled() -> bool {
    CLIPBOARD_FALLBACK.load(std::sync::atomic::Ordering::SeqCst)
}

/// 模块初始化：启动 capture worker + 安装钩子（默认启用，spike 阶段省偏好持久化）。
pub fn init(app: AppHandle) {
    let (tx, rx) = std::sync::mpsc::sync_channel::<WorkerMsg>(32);
    capture::spawn(app.clone(), rx);
    hook::start(tx);
    clipmon::spawn(); // 剪贴板监听（默认关，restore_from_prefs 按偏好开启）
    ENABLED.store(true, std::sync::atomic::Ordering::SeqCst);
    #[cfg(debug_assertions)]
    selftest_emit(app.clone());
    tracing::info!("selection: module initialized (enabled)");
}

/// 调试自检：启动 3 秒后广播一条合成捕获事件。
/// 用于在不依赖划词的情况下验证 emit → 前端监听 → 调试台表格全链路；
/// 若终端打出本日志而调试台无 selftest 行，则问题确定在前端监听侧。
#[cfg(debug_assertions)]
fn selftest_emit(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let log = capture::CaptureLog {
            ok: true,
            reason: None,
            mode: "uia",
            program_name: Some("selftest".into()),
            text_len: Some(0),
            double_click: false,
            timings: Some(perf::StageTimings {
                queue_wait_ms: 0.0,
                uia_access_ms: 0.0,
                text_ms: 0.0,
                rects_ms: 0.0,
                layout_show_ms: 0.0,
                total_ms: 0.0,
            }),
        };
        let r = app.emit("selection://capture-log", &log);
        tracing::info!(
            target: "selection::emit",
            ok = r.is_ok(),
            "selftest: selection://capture-log emitted (调试台应出现 selftest 行)"
        );
    });
}

/// 当前划词开关状态（托盘菜单勾选态 / 切换动作取用）
pub fn enabled() -> bool {
    ENABLED.load(std::sync::atomic::Ordering::SeqCst)
}

/// 开关实现（命令 / 托盘菜单 / 全局快捷键三方共用）：钩子启停 + 落盘 +
/// 广播 `prefs-changed`（设置页开关、浮标等监听方即时同步）。
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    let was = ENABLED.swap(enabled, std::sync::atomic::Ordering::SeqCst);
    if was == enabled {
        return;
    }
    if enabled {
        hook::restart();
        tracing::info!("selection: enabled");
    } else {
        hook::stop();
        // 通知 worker 隐藏浮标
        // （worker 通道由 init 持有；此处经 hook 的静态通道补发一条 Disable）
        hook::send_disable();
        tracing::info!("selection: disabled");
    }
    crate::prefs::set_selection_enabled(enabled); // 开关落盘，重启恢复
    use tauri::Emitter;
    if let Err(e) = app.emit("prefs-changed", ()) {
        tracing::warn!(target: "selection", error = %e, "prefs-changed 广播失败");
    }
    // 直推通道：携带新状态广播，设置页直接 setEnabled——
    // 不经 prefs_get 往返、不依赖 prefs-changed 的间链条路，异步同步必达。
    if let Err(e) = app.emit("selection://enabled-changed", enabled) {
        tracing::warn!(target: "selection", error = %e, "enabled-changed 广播失败");
    }
    // 托盘菜单勾选态同步。刷新统一收口在此（命令/托盘/快捷键
    // 三方路径全覆盖）；状态未变化时已在上方 early return，不会白刷。
    crate::tray::refresh_menu(app);
}

#[tauri::command]
pub fn selection_set_enabled(app: AppHandle, enabled: bool) {
    set_enabled(&app, enabled);
}

#[tauri::command]
pub fn selection_get_perf() -> perf::PerfStats {
    perf::stats()
}

#[tauri::command]
pub fn selection_set_clipboard_fallback(enabled: bool) {
    CLIPBOARD_FALLBACK.store(enabled, std::sync::atomic::Ordering::SeqCst);
    crate::prefs::set_clipboard_fallback(enabled); // 开关落盘，重启恢复
    tracing::info!("selection: clipboard fallback {}", if enabled { "enabled" } else { "disabled" });
}

/// 剪贴板监听查词开关：static 同步 + 落盘
#[tauri::command]
pub fn selection_set_clipboard_lookup(enabled: bool) {
    clipmon::set_enabled(enabled);
    crate::prefs::set_clipboard_lookup(enabled);
    tracing::info!("selection: clipboard lookup {}", if enabled { "enabled" } else { "disabled" });
}

/// setup：按偏好恢复开关状态（init 默认全开；偏好里关掉的在此停掉）
pub fn restore_from_prefs() {
    let p = crate::prefs::get();
    if !p.selection_enabled {
        let was = ENABLED.swap(false, std::sync::atomic::Ordering::SeqCst);
        if was {
            hook::stop();
            hook::send_disable();
        }
    }
    CLIPBOARD_FALLBACK.store(p.clipboard_fallback, std::sync::atomic::Ordering::SeqCst);
    // 剪贴板监听查词
    clipmon::set_enabled(p.clipboard_lookup);
    // 触发方式 + 进程过滤 static 同步
    apply_capture_prefs(
        &p.selection_trigger,
        &p.selection_filter_mode,
        &p.selection_filter_list,
    );
    tracing::info!(
        target: "selection",
        enabled = p.selection_enabled,
        clipboard_fallback = p.clipboard_fallback,
        clipboard_lookup = p.clipboard_lookup,
        trigger = %p.selection_trigger,
        filter = %p.selection_filter_mode,
        "selection state restored from prefs"
    );
}

/// 划词查词触发入口（全局快捷键回调；仅 shortcut 触发方式下生效——
/// pickdict processSelectTextByShortcut 同款判定，selected 模式误按不弹浮标）
pub fn trigger_lookup() {
    if trigger_mode() != TriggerMode::Shortcut {
        return;
    }
    hook::send_lookup_caret();
}

// ──  动作面板窗口 ──

/// selection://panel-text payload（广播；仅 action-panel 监听）。
/// action_id：触发动作（面板泛化多动作；dict = 查词，其余为 AI 动作 id）
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PanelTextEvent {
    pub text: String,
    pub action_id: String,
}

#[tauri::command]
pub fn selection_open_panel(app: AppHandle, x: i32, y: i32, action_id: Option<String>) {
    let action_id = action_id.unwrap_or_else(|| "dict".to_string());
    let (text, toolbar) = {
        let st = SHARED.lock().unwrap_or_else(|e| e.into_inner());
        (st.last_text.clone(), st.toolbar)
    };
    open_panel_with_text(&app, x, y, action_id, text, toolbar);
}

/// 面板打开共用实现（OCR 等外部入口）：文本显式给定（不依赖划词
/// last_text）；toolbar = Some 时复用「浮标下方展开」布局（正常划词路径），
/// None = 锚点直开（OCR 选区/词位置）。
pub fn open_panel_with_text(
    app: &AppHandle,
    x: i32,
    y: i32,
    action_id: String,
    text: String,
    toolbar: Option<crate::selection::layout::PhysRect>,
) {
    // 浮标隐藏（动作触发后浮标消失，pickdict 行为）
    if let Some(w) = app.get_webview_window("selection-toolbar") {
        let _ = w.hide();
    }
    if let Ok(mut st) = SHARED.lock() {
        st.toolbar_visible = false;
    }

    let Some(panel) = app.get_webview_window("action-panel") else {
        tracing::warn!("selection: action-panel window missing");
        return;
    };
    let anchor = Point { x, y };
    let (scale, work) = capture::monitor_metrics_at(anchor, &panel);
    let panel_phys = (
        (PANEL_LOGICAL_W * scale).round() as i32,
        (PANEL_LOGICAL_H * scale).round() as i32,
    );
    let pos = layout::place_panel(anchor, panel_phys, toolbar, work);
    if let Err(e) = panel.set_position(Position::Physical(PhysicalPosition::new(pos.x, pos.y))) {
        tracing::error!(target: "selection::panel", error = %e, "panel set-position failed");
        return;
    }
    let _ = panel.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(panel_phys.0 as u32, panel_phys.1 as u32)));
    let _ = panel.set_always_on_top(false); // 新会话重置 pin
    if let Ok(mut st) = SHARED.lock() {
        st.panel_pinned = false;
    }
    // OS 窗口标题随动作（任务栏/窗口管理器展示；面板内标题栏由前端渲染动作名）
    let title = match action_id.as_str() {
        "dict" => "查词",
        "translate" => "翻译",
        "explain" => "解释",
        "summary" => "总结",
        "refine" => "润色",
        _ => "AI 动作",
    };
    let _ = panel.set_title(title);
    if let Err(e) = panel.show() {
        tracing::error!(target: "selection::panel", error = %e, "panel show failed");
        return;
    }
    let _ = panel.set_focus();

    // 广播（结论：emit_to 的 target 匹配在部分 2.x 版本不可靠；只有面板监听本事件）
    if let Err(e) = app.emit(
        "selection://panel-text",
        PanelTextEvent { text, action_id },
    ) {
        tracing::error!(target: "selection::emit", error = %e, "panel-text emit failed");
    }
    tracing::info!(target: "selection::panel", pos = ?(pos.x, pos.y), "action-panel opened");
}

/// 面板 pin 常驻切换（pinned 时窗口置顶且失焦不隐藏）
#[tauri::command]
pub fn selection_set_panel_pinned(app: AppHandle, pinned: bool) {
    if let Ok(mut st) = SHARED.lock() {
        st.panel_pinned = pinned;
    }
    if let Some(panel) = app.get_webview_window("action-panel") {
        let _ = panel.set_always_on_top(pinned);
    }
}

/// 面板手动关闭（✕ 按钮）：走 Rust 隐藏而非前端 hide()——后者需要
/// core:window:allow-hide 权限，capabilities 未授予时静默失败（实测踩坑）
#[tauri::command]
pub fn selection_hide_panel(app: AppHandle) {
    if let Some(panel) = app.get_webview_window("action-panel") {
        let _ = panel.hide();
    }
}

/// 划词栏隐藏（动作后处理：动作完成即收起浮标）。记录 700ms 抑制窗——
/// 动作点击的 mouse up 可能晚于 hide 到达捕获链，防止浮标「关闭后又出现」。
#[tauri::command]
pub fn selection_hide_toolbar(app: AppHandle) {
    if let Some(toolbar) = app.get_webview_window("selection-toolbar") {
        let _ = toolbar.hide();
    }
    if let Ok(mut st) = SHARED.lock() {
        st.toolbar_visible = false;
        st.suppress_until =
            Some(std::time::Instant::now() + std::time::Duration::from_millis(700));
    }
}

/// 划词栏尺寸自适应（动作系统）：前端量内容尺寸后上报，窗口随之调整
/// （LogicalSize 由 Tauri 按 DPI 换算物理尺寸）。debug 日志供实测量尺值。
/// 记忆上次量尺值：capture 显示前直接用（消除「先按默认 320 宽弹出、量尺后再
/// 扩展」的两段式闪烁——；动作集变化时首帧旧尺寸、量尺即修）。
#[tauri::command]
pub fn selection_set_toolbar_size(app: AppHandle, width: f64, height: f64) {
    tracing::debug!(target: "selection::toolbar", width, height, "toolbar size reported");
    *TOOLBAR_LAST_SIZE
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some((width, height));
    if let Some(toolbar) = app.get_webview_window("selection-toolbar") {
        let _ = toolbar.set_size(tauri::LogicalSize::new(width, height));
    }
}

/// 上次量尺逻辑尺寸（None = 会话内从未量过，用 conf 默认 320×48）
static TOOLBAR_LAST_SIZE: Mutex<Option<(f64, f64)>> = Mutex::new(None);

/// conf 默认逻辑高（与 tauri.conf.json selection-toolbar 一致）
const TOOLBAR_LOGICAL_H: f64 = 48.0;

fn last_toolbar_size() -> (f64, f64) {
    TOOLBAR_LAST_SIZE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .unwrap_or((PANEL_DEFAULT_TOOLBAR_W, TOOLBAR_LOGICAL_H))
}

/// conf 默认逻辑宽（与 tauri.conf.json selection-toolbar 一致；量尺记忆缺失时兜底）
const PANEL_DEFAULT_TOOLBAR_W: f64 = 320.0;

/// 面板失焦 → 延迟隐藏（pickdict auto_close 语义；pinned 时常驻）。
///
/// 去抖：窗口激活序列（show/set_focus 竞态、点击未激活面板）会产生
/// Focused(false)→(true) 抖动——立即隐藏会把「用户正在点击/拖动面板」误杀
/// （实测：点击面板直接消失）。延迟 250ms 后复查 is_focused，重新获焦则取消。
pub fn hide_panel_on_blur(app: &AppHandle) {
    let pinned = SHARED.lock().map(|st| st.panel_pinned).unwrap_or(false);
    if pinned {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let pinned = SHARED.lock().map(|st| st.panel_pinned).unwrap_or(false);
        if pinned {
            return;
        }
        let Some(panel) = app.get_webview_window("action-panel") else {
            return;
        };
        match panel.is_focused() {
            Ok(true) => {
                tracing::debug!(target: "selection::panel", "blur debounce cancelled (panel refocused)");
            }
            Ok(false) => {
                tracing::debug!(target: "selection::panel", "panel blurred, hiding");
                let _ = panel.hide();
            }
            Err(e) => {
                tracing::debug!(target: "selection::panel", error = %e, "panel is_focused query failed");
            }
        }
    });
}

// Arc 引用预留（避免未使用告警的显式占位说明：SharedState 未来可能升级为 Arc 共享）
#[allow(dead_code)]
type SharedStateRef = Arc<Mutex<SharedState>>;
