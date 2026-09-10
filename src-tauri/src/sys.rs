//! 通用系统能力（划词栏动作）：外部链接打开。
//! 剪贴板写入在 `selection::clipboard::write_text`（复用兜底捕获的写入语义）。
//! 词典外链走向（浏览器 / 转内部查词）由偏好 `web_external` 决定，分流在前端
//! DictionaryPanel（内置网页查看器形态因 WebView2 卡死实测废弃）。

/// 用系统默认程序打开目标（http(s) URL → 浏览器；目录路径 → 资源管理器）。
/// ShellExecuteW 直调，不经 cmd——安全修复 原 `cmd /c start` 下 cmd
/// 会解释 `& | ^ < > %` 等元字符，Rust 参数转义不覆盖 cmd 解析规则。
#[cfg(windows)]
fn open_in_shell(target: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    const OPEN: [u16; 5] = [0x6F, 0x70, 0x65, 0x6E, 0]; // "open\0"
    let mut wide: Vec<u16> = target.encode_utf16().collect();
    wide.push(0); // NUL 结尾
    // SAFETY: ShellExecuteW 打开 URL/目录；输入已限定 http(s) 或本应用数据子目录，
    // 不经过命令行解释器，无注入面。返回值 > 32 = 成功（Win32 约定）。
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(OPEN.as_ptr()),
            PCWSTR(wide.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if (result.0 as isize) <= 32 {
        return Err(format!("打开失败（ShellExecute SE_ERR={}）", result.0 as isize));
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_in_shell(_target: &str) -> Result<(), String> {
    Err("仅支持 Windows".into())
}

/// 用系统默认浏览器打开 http(s) 链接（划词栏「搜索」/ 词典外链 / 在线词典错误态入口）。
/// 仅放行 http/https，杜绝参数注入面。
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("仅支持 http(s) 链接: {url}"));
    }
    open_in_shell(&url)
}

/// 打开日志目录（收尾）：固定 `数据根/logs`，命令不收路径
/// 参数（无注入面）；目录不存在则先创建。
#[tauri::command]
pub fn open_logs_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::paths::data_root(&app)?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    open_in_shell(&dir.to_string_lossy())
}

/// 应用重启（数据位置迁移后由设置页触发；tauri restart = 退出并拉起自身）
#[tauri::command]
pub fn app_restart(app: tauri::AppHandle) {
    tracing::info!(target: "app", "应用重启（用户触发）");
    app.restart();
}

/// 划词栏「复制」动作：写文本到剪贴板（复用兜底捕获的写入实现）
#[tauri::command]
pub fn clipboard_write(text: String) -> Result<(), String> {
    crate::selection::clipboard::write_text(&text);
    Ok(())
}

/// 截图「复制截图」：前端 canvas 组装好的 CF_DIB 字节（base64）写入剪贴板
#[tauri::command]
pub fn clipboard_write_image(dib: String) -> Result<(), String> {
    crate::selection::clipboard::write_image_dib(&dib)
}
