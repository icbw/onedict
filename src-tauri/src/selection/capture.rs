//! 捕获 worker 线程：消费钩子消息 → UIA 抓选区（失败走剪贴板兜底）→ 布局 → 浮标定位/显示
//! → event 推送 → 埋点采样。
//!
//! 捕获链（对照 selection-hook（MIT）五层链， 实装 ①⑤，②③④ 视矩阵缺口再补）：
//! ① UIA TextPattern（本文件 try_capture_via_uia，含前台窗口兜底）
//! ⑤ 剪贴板兜底（clipboard.rs：Ctrl+Insert → Ctrl+C，含意图检查与恢复）
//!
//! 性能链（UIA 路径，与 perf.rs 对应）：
//! ```text
//! t0 钩子回调鼠标 up（TriggerInfo.t0）
//!   → t1 worker 出队（queue_wait）
//!   → t2 前台进程名 + focused element + text pattern（uia_access）
//!   → t3 选区 range + 文本（text）
//!   → t4 行包围盒（rects）
//!   → t5 布局 + 定位 + show（layout_show；事件入队在其后，亚毫秒级）
//! ```
//! 决策门 = UIA 路径 total p95 < 30ms；剪贴板兜底样本单独统计（含注入与轮询等待，
//! 天然高耗时，不计入门限分布）。

use std::sync::mpsc::Receiver;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use super::filter;
use super::layout::{self, Orientation, PhysRect, Point};
use super::perf::{self, StageTimings};
use super::uia;
use super::{SHARED, WorkerMsg};

/// 推送到前端的文本上限（划词场景为词/短语，防长选段撑爆 payload）
const MAX_TEXT_LEN: usize = 2000;

pub fn spawn(app: AppHandle, rx: Receiver<WorkerMsg>) {
    let spawned = std::thread::Builder::new()
        .name("selection-capture".into())
        .spawn(move || worker(app, rx));
    if let Err(e) = spawned {
        tracing::error!("selection: failed to spawn capture worker: {e}");
    }
}

fn worker(app: AppHandle, rx: Receiver<WorkerMsg>) {
    // SAFETY: 专用线程 COM 初始化（MTA，UIA 推荐）；S_FALSE（已初始化）视为成功
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() {
        tracing::error!("selection: CoInitializeEx failed: {hr:?}; capture disabled");
        return;
    }

    let uia = match uia::Uia::new() {
        Ok(u) => Some(u),
        Err(e) => {
            tracing::error!("selection: UIA init failed: {e}; capture disabled");
            None
        }
    };

    tracing::info!("selection: capture worker ready");
    // 连续 UIA 失败的程序跳过计数（≥2 次直接走兜底，省掉每次 40–76ms 的无效 UIA 探测；
    // UIA 成功即清除——瞬时失败不受影响）
    let mut uia_skip: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    while let Ok(msg) = rx.recv() {
        // 单条消息 catch_unwind：UIA/COM 链路 panic 原会杀死 worker
        // 线程，此后钩子 try_send 全部静默丢弃 → 划词永久失效且无告警。恢复后循环
        // 继续（当前消息丢弃，后续划词不受影响）。
        // SAFETY: AssertUnwindSafe——app/uia 跨 unwind 复用在本场景安全（COM/UIA
        // 对象 panic 后仍可调用；最坏情况下次再 panic 再恢复）。
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match msg {
            WorkerMsg::Hide | WorkerMsg::Disable => hide_toolbar(&app),
            WorkerMsg::Trigger(info) => {
                if let Some(uia) = &uia {
                    handle_trigger(&app, uia, info, &mut uia_skip, true);
                }
            }
            // ctrlkey/shortcut 触发：无鼠标坐标，自取前台 caret 定位；
            // 显式动作不经进程过滤（pickdict 基线：过滤在鼠标事件层）
            WorkerMsg::LookupCaret => {
                if let Some(uia) = &uia {
                    match uia::foreground_caret() {
                        Some(pt) => handle_trigger(
                            &app,
                            uia,
                            super::TriggerInfo {
                                start: pt,
                                end: pt,
                                is_double_click: false,
                                t0: Instant::now(),
                            },
                            &mut uia_skip,
                            false,
                        ),
                        None => tracing::debug!(target: "selection::capture", "lookup-caret: no foreground caret"),
                    }
                }
            }
            // 剪贴板监听触发：文本已就绪，直接显示浮标
            WorkerMsg::Clipboard { text, anchor } => handle_clipboard(&app, text, anchor),
        }));
        if outcome.is_err() {
            tracing::error!("selection: capture worker panic recovered (message dropped)");
        }
    }
}

fn hide_toolbar(app: &AppHandle) {
    // 提示条显示期间不抢着关窗：关闭划词时会补发一条 Disable，若在提示条之后
    // 到达会把「划词已关闭」刚亮出的提示立刻抹掉（提示条自己到点隐藏）
    let notice_showing = SHARED.lock().map(|st| st.notice.is_some()).unwrap_or(false);
    if !notice_showing {
        if let Some(win) = app.get_webview_window("selection-toolbar") {
            let _ = win.hide();
        }
    }
    if let Ok(mut st) = SHARED.lock() {
        st.toolbar_visible = false;
    }
}

/// 剪贴板监听触发：文本已就绪，直接显示浮标（不走 UIA 捕获链）。
/// 与划词共享浮标抑制窗/可见性检查（handle_trigger 开头同款）；不做进程过滤
/// （复制 = 用户显式动作，同 ctrlkey/shortcut 语义）；锚点 = 通知时刻鼠标位置。
fn handle_clipboard(app: &AppHandle, text: String, anchor: Point) {
    let t0 = Instant::now();
    if let Ok(st) = SHARED.lock() {
        if st
            .suppress_until
            .is_some_and(|t| Instant::now() < t)
            || st.toolbar_visible
        {
            return;
        }
    }
    let Some(window) = app.get_webview_window("selection-toolbar") else {
        tracing::warn!("selection: toolbar window missing (clipmon)");
        return;
    };
    let program_name = uia::foreground_process_name();
    tracing::info!(
        target: "selection::capture",
        program = program_name.as_deref().unwrap_or("?"),
        "clipboard monitor hit"
    );
    finish_capture(
        app,
        &window,
        super::TriggerInfo { start: anchor, end: anchor, is_double_click: false, t0 },
        program_name,
        text,
        vec![],
        "clipmon",
        t0,
        UiaStages { uia_access_ms: 0.0, text_ms: 0.0, rects_ms: 0.0 },
        0.0,
    );
}

/// UIA 捕获成功时的分阶段耗时（t2/t3/t4 段）
struct UiaStages {
    uia_access_ms: f64,
    text_ms: f64,
    rects_ms: f64,
}

fn handle_trigger(
    app: &AppHandle,
    uia: &uia::Uia,
    info: super::TriggerInfo,
    uia_skip: &mut std::collections::HashMap<String, u32>,
    enforce_filter: bool,
) {
    let t1 = Instant::now();

    // 抑制窗（动作隐藏后 700ms）→ 不重弹：动作点击的 mouse up 晚于 hide 到达捕获链时
    // 会造成浮标「关闭后又出现」（实测）；浮标已可见 → 不重复弹（pickdict 基线）
    if let Ok(st) = SHARED.lock() {
        if st
            .suppress_until
            .is_some_and(|t| Instant::now() < t)
            || st.toolbar_visible
        {
            return;
        }
    }
    let Some(window) = app.get_webview_window("selection-toolbar") else {
        tracing::warn!("selection: toolbar window missing");
        return;
    };

    let program_name = uia::foreground_process_name();

    // 进程过滤：仅鼠标触发路径（拖选/双击）受过滤——ctrlkey/shortcut
    // 是用户显式动作，不被静默拦截（pickdict：过滤在 mouse 事件层，快捷键绕过）
    if enforce_filter && !filter::allowed(program_name.as_deref()) {
        tracing::debug!(
            target: "selection::capture",
            program = program_name.as_deref().unwrap_or("?"),
            "selection skipped by process filter"
        );
        return;
    }

    // 连续 ≥2 次 uia-access 失败的程序直接走兜底
    // （注意：探测必须在此分支内条件调用——放进 match 元组会无条件先求值）
    let skip_uia = program_name
        .as_deref()
        .is_some_and(|p| uia_skip.get(p).copied().unwrap_or(0) >= 2);

    let attempted = if skip_uia {
        Err(("uia-access", "skipped (repeat uia-null program)".into(), 0.0))
    } else {
        try_capture_via_uia(uia)
    };

    match attempted {
        Ok((text, rects, stages)) => {
            if let Some(p) = &program_name {
                uia_skip.remove(p);
            }
            finish_capture(
                app,
                &window,
                info,
                program_name,
                text,
                rects,
                "uia",
                t1,
                stages,
                0.0,
            );
        }
        Err((stage, err, elapsed_ms)) => {
            if stage == "uia-access" {
                if let Some(p) = &program_name {
                    *uia_skip.entry(p.clone()).or_insert(0) += 1;
                }
            }
            if super::clipboard_fallback_enabled() {
                let cb_start = Instant::now();
                // 剪贴板监听循环防护：注入复制会让目标程序写剪贴板 →
                // clipmon 轮询会看到变化；捕获全程抑制 + 退出再压 400ms 覆盖恢复写。
                super::clipmon::suppress(1500);
                match super::clipboard::capture_via_clipboard(program_name.as_deref()) {
                    Some(text) if !text.trim().is_empty() => {
                        tracing::info!(
                            target: "selection::capture",
                            program = program_name.as_deref().unwrap_or("?"),
                            "clipboard fallback hit (uia {stage} failed)"
                        );
                        finish_capture(
                            app,
                            &window,
                            info,
                            program_name,
                            text,
                            vec![],
                            "clipboard",
                            t1,
                            UiaStages { uia_access_ms: elapsed_ms, text_ms: 0.0, rects_ms: 0.0 },
                            ms(Instant::now(), cb_start),
                        );
                    }
                    _ => {
                        report_failure(
                            app,
                            program_name.as_deref(),
                            format!("clipboard: no-update (uia {stage}: {err})"),
                            t1,
                            info.t0,
                        );
                    }
                }
                super::clipmon::suppress(400);
                return;
            }
            report_failure(app, program_name.as_deref(), format!("{stage}: {err}"), t1, info.t0);
        }
    }
}

/// 捕获链 ①：UIA TextPattern（focused element，null 时前台窗口元素兜底）
#[allow(clippy::type_complexity)]
fn try_capture_via_uia(
    uia: &uia::Uia,
) -> Result<(String, Vec<PhysRect>, UiaStages), (&'static str, String, f64)> {
    let start = Instant::now();
    let fail = |stage: &'static str,
                err: String|
     -> Result<(String, Vec<PhysRect>, UiaStages), (&'static str, String, f64)> {
        Err((stage, err, ms(Instant::now(), start)))
    };

    // ── t2：focused element + text pattern ──
    let pattern = match uia.focused().and_then(|el| uia.text_pattern(&el)) {
        Ok(p) => p,
        Err(focused_err) => {
            // GetFocusedElement 对部分 provider 返回 S_OK + null（windows-rs 显示为
            // 0x00000000 假错误）：Acrobat 保护模式 / Gecko 等 → 前台窗口元素兜底
            match uia.element_from_foreground().and_then(|el| uia.text_pattern(&el)) {
                Ok(p) => {
                    tracing::debug!(target: "selection::capture", "focused-element null, foreground fallback hit");
                    p
                }
                Err(foreground_err) => {
                    return fail(
                        "uia-access",
                        format!("focused={} foreground={}", describe(&focused_err), describe(&foreground_err)),
                    );
                }
            }
        }
    };
    let t2 = Instant::now();

    // ── t3：选区 range + 文本 ──
    let range = match uia.first_nonempty_range(&pattern) {
        Ok(Some(r)) => r,
        // 无选区也走兜底（部分应用 UIA 在但 GetSelection 不可用）
        Ok(None) => return fail("uia-selection", "no-selection".into()),
        Err(e) => return fail("get-selection", describe(&e)),
    };
    let mut text = uia::Uia::range_text(&range);
    // String::truncate 的 debug 断言要求 char boundary——中文等多字节文本撞边界会 panic
    // （实测 workbuddy.exe 大段中文划词触发），按 floor boundary 安全截断
    if text.len() > MAX_TEXT_LEN {
        let mut end = MAX_TEXT_LEN;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    if text.trim().is_empty() {
        return fail("uia-selection", "empty-text".into());
    }
    let t3 = Instant::now();

    // ── t4：行包围盒（失败不致命：布局退回鼠标坐标路径）──
    let rects = match uia::Uia::range_rects(&range) {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!(target: "selection::capture", "get-rects failed, fallback to mouse anchor: {}", describe(&e));
            Vec::new()
        }
    };
    let t4 = Instant::now();

    Ok((
        text,
        rects,
        UiaStages {
            uia_access_ms: ms(t2, start),
            text_ms: ms(t3, t2),
            rects_ms: ms(t4, t3),
        },
    ))
}

/// 布局 + 定位 + show + emit + 埋点（UIA 与剪贴板路径共用尾部）
fn finish_capture(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    info: super::TriggerInfo,
    program_name: Option<String>,
    text: String,
    rects: Vec<PhysRect>,
    mode: &'static str,
    t1: Instant,
    stages: UiaStages,
    clipboard_ms: f64,
) {
    // ── 布局 + 定位 + show（打点后仅剩事件入队，亚毫秒级）──
    let anchor = layout::pick_anchor(info.start, info.end, &rects, info.is_double_click);
    let (scale, work_area) = monitor_metrics_at(anchor.point, window);
    // 用上次量尺逻辑尺寸（首帧即正确宽，消除两段式展开闪烁）；会话首次用 conf 默认
    let (logical_w, logical_h) = super::last_toolbar_size();
    let phys_size = (
        (logical_w * scale).round() as i32,
        (logical_h * scale).round() as i32,
    );
    let pos = layout::place(anchor, phys_size, work_area);

    if let Err(e) = window.set_position(Position::Physical(PhysicalPosition::new(pos.x, pos.y))) {
        report_failure(app, program_name.as_deref(), format!("set-position: {e}"), t1, info.t0);
        return;
    }
    let _ = window.set_size(Size::Physical(PhysicalSize::new(
        phys_size.0 as u32,
        phys_size.1 as u32,
    )));
    // 每次显示重申 topmost（pickdict：防第三方 topmost 窗口压住）
    let _ = window.set_always_on_top(true);
    if let Err(e) = window.show() {
        report_failure(app, program_name.as_deref(), format!("show: {e}"), t1, info.t0);
        return;
    }
    // show 之后必须**无条件**再重升一次 z 序：上面的 set_always_on_top 在标志位
    // 已是 topmost 时是彻底的 no-op（tao 差量应用），被压住后永不恢复（见
    // tray::raise_topmost 的现场说明）
    crate::tray::raise_topmost(window);
    if let Ok(mut st) = SHARED.lock() {
        st.toolbar = Some(PhysRect {
            x: pos.x,
            y: pos.y,
            w: phys_size.0,
            h: phys_size.1,
        });
        st.toolbar_visible = true;
        st.last_text = text.clone(); // 动作面板取词来源
        st.notice = None; // 真实划词顶掉可能还在显示的开关提示条（定时隐藏随之失效）
    }

    let t5 = Instant::now();
    let timings = StageTimings {
        queue_wait_ms: ms(t1, info.t0),
        uia_access_ms: stages.uia_access_ms,
        text_ms: if mode == "clipboard" { clipboard_ms } else { stages.text_ms },
        rects_ms: stages.rects_ms,
        layout_show_ms: ms(t5, t1) - stages.uia_access_ms - stages.text_ms - stages.rects_ms - clipboard_ms,
        total_ms: ms(t5, info.t0),
    };

    // 非 UIA 链（clipboard 兜底 / clipmon 监听）天然高耗时（含注入/轮询等待），
    // 不入 UIA 分布门限统计（perf.rs 决策门 = UIA 路径 total p95 < 30ms）
    if mode == "uia" {
        perf::record_success(timings.total_ms);
    } else {
        perf::record_clipboard(timings.total_ms);
    }

    // 广播 emit（前端按事件名过滤；emit_to 的 target 匹配在部分 2.x 版本不可靠）
    let event = SelectionEvent {
        text: text.clone(),
        program_name: program_name.clone(),
        rects: rects
            .iter()
            .map(|r| [r.x as f64, r.y as f64, r.w as f64, r.h as f64])
            .collect(),
        ref_point: [anchor.point.x, anchor.point.y],
        orientation: orientation_str(anchor.orientation),
        timings: Some(timings.clone()),
    };
    emit_logged(app, "selection://text-selected", &event);

    // 调试台日志 + 统计推送到主窗口
    let log = CaptureLog {
        ok: true,
        reason: None,
        mode,
        program_name,
        text_len: Some(text.chars().count()),
        double_click: info.is_double_click,
        timings: Some(timings.clone()),
    };
    emit_logged(app, "selection://capture-log", &log);
    emit_logged(app, "selection://perf", &perf::stats());

    tracing::info!(
        target: "selection::capture",
        program = log.program_name.as_deref().unwrap_or("?"),
        mode = mode,
        total_ms = timings.total_ms,
        uia_ms = timings.uia_access_ms,
        text_ms = timings.text_ms,
        rects_ms = timings.rects_ms,
        layout_ms = timings.layout_show_ms,
        queue_ms = timings.queue_wait_ms,
        "captured"
    );
}

fn report_failure(app: &AppHandle, program: Option<&str>, reason: String, t1: Instant, t0: Instant) {
    perf::record_failure();
    let log = CaptureLog {
        ok: false,
        reason: Some(reason),
        mode: "uia",
        program_name: program.map(str::to_string),
        text_len: None,
        double_click: false,
        timings: Some(StageTimings {
            queue_wait_ms: ms(t1, t0),
            uia_access_ms: 0.0,
            text_ms: 0.0,
            rects_ms: 0.0,
            layout_show_ms: 0.0,
            total_ms: ms(Instant::now(), t0),
        }),
    };
    emit_logged(app, "selection://capture-log", &log);
    emit_logged(app, "selection://perf", &perf::stats());
    tracing::warn!(
        target: "selection::capture",
        program = program.unwrap_or("?"),
        reason = log.reason.as_deref().unwrap_or("?"),
        "capture failed"
    );
}

/// 锚点所在显示器：DPI 缩放系数 + 工作区（物理，排除任务栏）。
///  起供动作面板定位复用（浮标物理尺寸 = 逻辑尺寸 × scale 由调用方自算）。
pub(crate) fn monitor_metrics_at(pt: Point, window: &tauri::WebviewWindow) -> (f64, PhysRect) {
    // SAFETY: Win32 显示器查询
    unsafe {
        let hmon = MonitorFromPoint(POINT { x: pt.x, y: pt.y }, MONITOR_DEFAULTTONEAREST);
        if hmon.is_invalid() {
            return fallback(window);
        }
        // DPI → 物理尺寸
        let mut dpi_x = 0u32;
        let mut dpi_y = 0u32;
        let scale = match GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) {
            Ok(()) if dpi_x > 0 => dpi_x as f64 / 96.0,
            _ => window.scale_factor().unwrap_or(1.0),
        };

        // 工作区
        let mut info = MONITORINFO::default();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(hmon, &mut info).as_bool() {
            let rc = info.rcWork;
            (
                scale,
                PhysRect {
                    x: rc.left,
                    y: rc.top,
                    w: rc.right - rc.left,
                    h: rc.bottom - rc.top,
                },
            )
        } else {
            fallback(window)
        }
    }
}

fn fallback(window: &tauri::WebviewWindow) -> (f64, PhysRect) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let work = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| PhysRect {
            x: m.position().x,
            y: m.position().y,
            w: m.size().width as i32,
            h: m.size().height as i32,
        })
        .unwrap_or(PhysRect { x: 0, y: 0, w: 1920, h: 1080 });
    (scale, work)
}

fn ms(later: Instant, earlier: Instant) -> f64 {
    later.duration_since(earlier).as_secs_f64() * 1000.0
}

/// windows-rs 对「S_OK + null 元素」报 0x00000000 假错误——还原为可读原因
fn describe(e: &windows::core::Error) -> String {
    if e.code().is_ok() {
        "element-null".into()
    } else {
        e.to_string()
    }
}

/// emit 结果显式落日志：序列化/投递失败绝不静默（排查事件丢失的关键证据）
fn emit_logged<T: serde::Serialize + ?Sized>(app: &AppHandle, event: &str, payload: &T) {
    if let Err(e) = app.emit(event, payload) {
        tracing::error!(target: "selection::emit", event, error = %e, "emit failed");
    }
}

fn orientation_str(o: Orientation) -> &'static str {
    match o {
        Orientation::TopLeft => "topLeft",
        Orientation::TopRight => "topRight",
        Orientation::TopMiddle => "topMiddle",
        Orientation::BottomLeft => "bottomLeft",
        Orientation::BottomRight => "bottomRight",
        Orientation::BottomMiddle => "bottomMiddle",
        Orientation::MiddleLeft => "middleLeft",
        Orientation::MiddleRight => "middleRight",
        Orientation::Center => "center",
    }
}

// ── 事件 payload（camelCase 给前端）──

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SelectionEvent {
    pub text: String,
    pub program_name: Option<String>,
    /// 行包围盒（物理）：[x, y, w, h]
    pub rects: Vec<[f64; 4]>,
    pub ref_point: [i32; 2],
    pub orientation: &'static str,
    pub timings: Option<StageTimings>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLog {
    pub ok: bool,
    pub reason: Option<String>,
    /// "uia" | "clipboard"
    pub mode: &'static str,
    pub program_name: Option<String>,
    pub text_len: Option<usize>,
    pub double_click: bool,
    pub timings: Option<StageTimings>,
}
