//! 系统托盘 + 全局快捷键。
//!
//! 托盘行为基线（pickdict TrayService，MIT 原创）：左键点击显示主窗口；右键菜单
//! 显示主窗口 / 划词开关 / 退出。主窗口关闭 = 隐藏到托盘；常驻进程显式可见
//! （图标在即进程在），「退出」是唯一且明确的退出路径，与 pickdict 语义对齐，
//! 划词钩子在主窗口隐藏后继续服务（划词应用的常驻本意）。
//!
//! 全局快捷键（可配置化）：
//! - 划词开关（与托盘菜单/设置页同一 set_enabled 实现）
//! - 查词呼出（显示并聚焦主窗口）
//! 组合键读偏好 `hotkeys`（槽位 None/空串回内置默认，常量在 prefs::HotkeysPref）；
//! 注册失败（热键被其他程序占用）降级为日志告警，不阻断启动；设置页改键经
//! `prefs_set_hotkeys` → `apply_hotkeys` 参数化重注册（冲突保留旧键）。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// 托盘图标 id（状态变更后经 tray_by_id 取回刷新菜单）
const TRAY_ID: &str = "onedict-tray";

/// 快捷键槽位（动作绑定与偏好字段一一对应）
#[derive(Clone, Copy, PartialEq, Eq)]
enum HotkeySlot {
    ToggleSelection,
    ShowMain,
    /// 划词查词（触发方式 = shortcut 时捕获当前选区；可空 = 未注册）
    TriggerLookup,
    /// OCR 取词（框选屏幕区域识别）
    OcrLookup,
}

impl HotkeySlot {
    /// 注册组合键并绑定动作（on_shortcut；格式错误/注册失败统一转 Err 字符串）
    fn register(self, app: &AppHandle, hotkey: &str) -> Result<(), String> {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        let gs = app.global_shortcut();
        let result = match self {
            HotkeySlot::ToggleSelection => gs.on_shortcut(hotkey, |app, _s, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_selection(app);
                }
            }),
            HotkeySlot::ShowMain => gs.on_shortcut(hotkey, |app, _s, event| {
                if event.state == ShortcutState::Pressed {
                    show_main(app);
                }
            }),
            HotkeySlot::TriggerLookup => gs.on_shortcut(hotkey, |_app, _s, event| {
                if event.state == ShortcutState::Pressed {
                    crate::selection::trigger_lookup();
                }
            }),
            // OCR 独立显式入口，不走 selection 触发模式门。
            // **必须 Released 触发**（实测）：global-hotkey Windows
            // 在 WM_HOTKEY（主键按下匹配成功）即投递 Pressed——主键（如 Q）仍物理
            // 按住时 show+focus 覆盖层，WebView2 接管到不完整键盘状态；modifier
            // （Alt/Ctrl）先于主键松开时 100% 卡死放大镜（输入+合成全停，Esc 才
            // 解锁），**先松主键则一切正常**（modifier 按着无关）。Released =
            // global-hotkey 开线程轮询主键 GetAsyncKeyState 的松开时刻，正是
            // 实测的安全点。托盘路径无键盘状态问题，不受影响
            HotkeySlot::OcrLookup => gs.on_shortcut(hotkey, |app, _s, event| {
                if event.state == ShortcutState::Released {
                    crate::ocr::launch_capture(app);
                }
            }),
        };
        result.map_err(|e| e.to_string())
    }
}

/// 托盘初始化（setup 调用，须在 selection::init 之后——菜单勾选态读划词状态）。
/// 图标 = 应用默认图标（tauri.conf bundle.icon 构建期嵌入，无需额外 image feature）。
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("onedict")
        .menu(&menu)
        // 右键弹菜单；左键留给「显示主窗口」（on_tray_icon_event）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show-main" => show_main(app),
            "toggle-selection" => toggle_selection(app),
            "ocr-lookup" => crate::ocr::launch_capture(app),
            "quit" => {
                tracing::info!(target: "tray", "托盘退出");
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // pickdict 行为：左键单击显示主窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    tracing::info!(target: "tray", "托盘已创建");
    Ok(())
}

/// 按当前划词状态组装托盘菜单（勾选态来自 selection::enabled()；
/// 状态变更后整体重建——菜单规模小，重建代价可忽略）
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show-main", "显示主窗口", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let toggle = CheckMenuItem::with_id(
        app,
        "toggle-selection",
        "划词",
        true,
        crate::selection::enabled(),
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let ocr = MenuItem::with_id(app, "ocr-lookup", "截图翻译", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &sep1, &toggle, &sep2, &ocr, &sep3, &quit])
}

/// 划词状态变化后刷新托盘勾选态（整体重建菜单）
pub fn refresh_menu(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match build_menu(app) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                tracing::warn!(target: "tray", error = %e, "托盘菜单刷新失败");
            }
        }
        Err(e) => tracing::warn!(target: "tray", error = %e, "托盘菜单重建失败"),
    }
}

/// 显示并聚焦主窗口（托盘左键 / 快捷键「查词呼出」/ 划词「引用」动作共用）。
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        force_focus(&w);
    }
}

/// Windows 前台权：从划词浮标（focusable:false，非前台进程）经 IPC 触发的
/// set_focus 会被系统前台锁拒绝——主窗口 show 了却被当前前台窗口盖住
/// （「引用不生效」的根因；托盘/快捷键路径因携带用户输入上下文而正常）。
/// 单一手段均不稳定（ALT 瞬按 / AttachThreadInput 各有失效场景），终版**组合拳**：
/// 附加前台输入线程 → BringWindowToTop 抢 Z 序 → **按住 ALT 的同时**
/// SetForegroundWindow（经典解锁顺序）→ 分离；仍失败则任务栏图标闪烁提示
/// （FlashWindowEx）+ tao set_focus 兜底。
#[cfg(target_os = "windows")]
pub(crate) fn force_focus(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, FlashWindowEx, GetForegroundWindow, GetWindowThreadProcessId,
        SetForegroundWindow, FLASHW_ALL, FLASHWINFO, FLASHW_TIMERNOFG,
    };

    let hwnd = match window.hwnd() {
        Ok(h) => HWND(h.0),
        Err(e) => {
            tracing::warn!(target: "tray", error = %e, "取主窗口 HWND 失败，回退 set_focus");
            let _ = window.set_focus();
            return;
        }
    };
    unsafe {
        let this_thread = GetCurrentThreadId();
        let fg = GetForegroundWindow();
        let fg_thread = if fg.is_invalid() {
            0
        } else {
            GetWindowThreadProcessId(fg, None)
        };
        // 与自己同线程/无前台窗口时无需附加（允许直接置前）
        let attached = fg_thread != 0 && fg_thread != this_thread;
        if attached {
            let attach_ok = AttachThreadInput(this_thread, fg_thread, true).as_bool();
            if !attach_ok {
                tracing::warn!(target: "tray", "AttachThreadInput 失败（仍尝试置前）");
            }
        }
        let _ = BringWindowToTop(hwnd);
        // 经典 ALT 顺序：按住 ALT 期间调用 SetForegroundWindow（系统视为用户输入响应）
        keybd_event(VK_MENU.0 as u8, 0, KEYBD_EVENT_FLAGS(0), 0);
        let ok = SetForegroundWindow(hwnd).as_bool();
        keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        if attached {
            let _ = AttachThreadInput(this_thread, fg_thread, false);
        }
        if ok {
            tracing::debug!(target: "tray", "主窗口已置前");
        } else {
            // 兜底：任务栏图标闪烁提示（至少有可见反馈）+ tao set_focus
            tracing::warn!(target: "tray", "SetForegroundWindow 失败，任务栏闪烁提示");
            let mut flash = FLASHWINFO {
                cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                hwnd,
                dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
                uCount: 3,
                dwTimeout: 0,
            };
            let _ = FlashWindowEx(&mut flash);
            let _ = window.set_focus();
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn force_focus(window: &tauri::WebviewWindow) {
    let _ = window.set_focus();
}

/// 无条件把窗口升到 topmost 段顶端（**显示之后**调用；Windows 专用）。
///
/// 不能只依赖 `set_always_on_top(true)`：tao 的窗口标志位是**差量应用**
/// （`WindowState::set_window_flags` → `apply_diff`，空 diff 直接 return），
/// 标志位已是 topmost 时那次调用是彻底的 no-op，窗口不会被重新升到段顶。而
/// Windows 会把 topmost 窗口排到「覆盖整个显示器的前台窗口」之下——实测现场：
/// 浮标窗口 `WS_VISIBLE` 成立、内容也已渲染（PrintWindow 抓得到 pill），却被
/// 最大化窗口整块盖住，用户侧表现为「任何触发方式都不弹 bar」；补一次外部
/// SetWindowPos(HWND_TOPMOST) 立即恢复显示。
///
/// 本应用里「非焦点窗口」没有别的重升路径（激活会顺带升 z 序，但浮标
/// focusable:false、OCR 覆盖层刻意零焦点），故这两处显示后必须显式调用。
#[cfg(target_os = "windows")]
pub(crate) fn raise_topmost(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    // SAFETY: 仅传本进程窗口句柄调整 z 序，不改尺寸/位置、不抢焦点
    unsafe {
        let _ = SetWindowPos(
            HWND(hwnd.0),
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn raise_topmost(_window: &tauri::WebviewWindow) {}

/// 划词开关切换（托盘菜单 / 全局快捷键共用；命令侧走同一 selection::set_enabled）。
/// 菜单刷新统一在 set_enabled 内做（覆盖命令/托盘/快捷键全路径）。
pub fn toggle_selection(app: &AppHandle) {
    let next = !crate::selection::enabled();
    crate::selection::set_enabled(app, next);
    // 开关的可视反馈只有托盘菜单勾选态（屏幕上看不到）——实际反馈缺失会让用户
    // 把「按了没反应」读成功能坏了，切换后在光标旁给一条短暂提示
    crate::selection::show_toggle_notice(app, next);
}

/// 全局快捷键注册（setup 调用；组合键读偏好 hotkeys，前两槽缺省回内置默认，
/// trigger_lookup 缺省 = 不注册；失败降级为告警，不阻断启动）
pub fn register_hotkeys(app: &AppHandle) {
    let prefs = crate::prefs::hotkeys();
    let slots = [
        (HotkeySlot::ToggleSelection, Some(prefs.toggle_selection().to_string())),
        (HotkeySlot::ShowMain, Some(prefs.show_main().to_string())),
        (HotkeySlot::TriggerLookup, prefs.trigger_lookup().map(str::to_string)),
        (HotkeySlot::OcrLookup, Some(prefs.ocr_lookup().to_string())),
    ];
    for (slot, hotkey) in slots {
        let Some(hotkey) = hotkey else { continue };
        if let Err(e) = slot.register(app, &hotkey) {
            tracing::warn!(target: "tray", hotkey = %hotkey, error = %e, "全局快捷键注册失败（可能被其他程序占用）");
        }
    }
}

/// 应用新快捷键配置（设置页保存路径，prefs_set_hotkeys 调用）：
/// ①格式校验（global-hotkey 解析失败即拒绝，不触达注册状态；空槽跳过）；
/// ②非空槽两两互斥校验；③先整体注销变更槽位的旧键（互换/清除等键位重排场景——
/// 同一组合键不能同时挂两槽），再逐槽注册新键（空槽 = 只注销不注册）；任一注册
/// 失败（通常 = 被其他程序占用）→ 回滚到旧配置并返回 Err（前端降级告警，保留旧键）。
pub fn apply_hotkeys(app: &AppHandle, next: &crate::prefs::HotkeysPref) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let cur = crate::prefs::hotkeys();
    let slots = [
        (HotkeySlot::ToggleSelection, Some(next.toggle_selection().to_string())),
        (HotkeySlot::ShowMain, Some(next.show_main().to_string())),
        (HotkeySlot::TriggerLookup, next.trigger_lookup().map(str::to_string)),
        (HotkeySlot::OcrLookup, Some(next.ocr_lookup().to_string())),
    ];

    // ①格式校验（global-hotkey FromStr，大小写不敏感；None 槽跳过）
    for (_, hotkey) in &slots {
        if let Some(h) = hotkey {
            h.parse::<Shortcut>()
                .map_err(|e| format!("快捷键格式无效「{h}」: {e}"))?;
        }
    }
    // ②非空槽互斥
    for i in 0..slots.len() {
        for j in i + 1..slots.len() {
            if let (Some(a), Some(b)) = (slots[i].1.as_deref(), slots[j].1.as_deref()) {
                if a.eq_ignore_ascii_case(b) {
                    return Err("不同槽位的快捷键不能相同".into());
                }
            }
        }
    }

    // ③收集变更槽位（与当前注册态比较；None ↔ Some 判等按值；未变更跳过 = 幂等）
    let old_of = |slot: HotkeySlot| -> Option<String> {
        match slot {
            HotkeySlot::ToggleSelection => Some(cur.toggle_selection().to_string()),
            HotkeySlot::ShowMain => Some(cur.show_main().to_string()),
            HotkeySlot::TriggerLookup => cur.trigger_lookup().map(str::to_string),
            HotkeySlot::OcrLookup => Some(cur.ocr_lookup().to_string()),
        }
    };
    let changed: Vec<(HotkeySlot, Option<String>, Option<String>)> = slots
        .into_iter()
        .filter_map(|(slot, new)| {
            let old = old_of(slot);
            let differs = match (&old, &new) {
                (Some(o), Some(n)) => !o.eq_ignore_ascii_case(n),
                (None, None) => false,
                _ => true,
            };
            differs.then_some((slot, old, new))
        })
        .collect();
    if changed.is_empty() {
        return Ok(());
    }

    // 先注销全部变更槽旧键（重排/清除场景必需），再逐槽注册新键（None 槽 = 仅注销）
    for (_, old, _) in &changed {
        if let Some(old) = old {
            let _ = app.global_shortcut().unregister(old.as_str());
        }
    }
    let mut registered: Vec<String> = Vec::new();
    for (slot, _, new) in &changed {
        let Some(new) = new else { continue };
        match slot.register(app, new) {
            Ok(()) => registered.push(new.clone()),
            Err(e) => {
                // 回滚：撤掉已注册的新键 + 尽力恢复旧键（失败仅告警——极小窗口内
                // 占用者变动，此时以日志为准，偏好未落盘旧配置仍是事实源）
                for r in &registered {
                    let _ = app.global_shortcut().unregister(r.as_str());
                }
                for (slot, old, _) in &changed {
                    if let Some(old) = old {
                        if let Err(re) = slot.register(app, old) {
                            tracing::error!(target: "tray", hotkey = %old, error = %re, "快捷键回滚注册失败");
                        }
                    }
                }
                return Err(format!("注册失败（可能被其他程序占用）：{e}"));
            }
        }
    }
    tracing::info!(target: "tray", "全局快捷键已重注册");
    Ok(())
}
