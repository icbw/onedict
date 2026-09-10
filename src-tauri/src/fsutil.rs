//! 通用文件能力：原子落盘（数据稳定）。
//!
//! 背景：prefs / vocabulary / history / translate-history 四处 JSON 此前全是
//! `fs::write`（truncate 后写）——崩溃/断电留下半截文件，启动判损坏改名 `.corrupt`
//! 回退默认（偏好与 API Key 全丢）。vendor opendict 的 idxcache 早已 temp+rename，
//! 应用侧对齐之。

use std::io::Write;
use std::path::Path;

/// 原子写文本：同目录 `<name>.tmp` → rename。
/// `std::fs::rename` 在 Windows 上带 `MOVEFILE_REPLACE_EXISTING` 语义，可直接覆盖
/// 既有目标；同卷 rename 原子。临时文件残留（写入中途崩溃）不影响主文件。
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);

    let write_tmp = || -> Result<(), String> {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("创建临时文件失败: {e}"))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("写入临时文件失败: {e}"))?;
        f.sync_all().map_err(|e| format!("刷盘失败: {e}"))?;
        Ok(())
    };
    write_tmp()?;

    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            // 回退直写（保可用性优先于原子性；目标被杀毒/备份工具短暂占用等场景）
            std::fs::write(path, text).map_err(|e| {
                format!("写入失败（rename: {rename_err}；直写: {e}）")
            })
        }
    }
}

/// 提权创建目录（UAC 依赖数据目录）：安装位于系统目录
/// （Program Files 等）时普通权限 `create_dir_all` 失败，经 ShellExecuteW
/// `runas` 弹 UAC，由提权 cmd 完成两步——`mkdir` + `icacls` 授 Users 组
/// 修改权（*S-1-5-32-545 SID 免本地化组名；OI/CI 继承到缓存文件）。
/// **ACL 是关键**：仅提权建目录，普通权限进程对继承只读 ACL 的子目录
/// 依旧写不进。同步等待 cmd 结束（UAC 用户交互路径，本就在用户打开词典
/// 时触发）；用户拒绝/失败返回 false（调用方降级为无缓存冷解析）。
#[cfg(windows)]
pub fn create_dir_elevated(dir: &Path) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let d = dir.to_string_lossy();
    let args = format!(
        "/c mkdir \"{d}\" & icacls \"{d}\" /grant *S-1-5-32-545:(OI)(CI)M"
    );
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = "cmd.exe\0".encode_utf16().collect();
    let params: Vec<u16> = args.encode_utf16().chain([0]).collect();
    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    let launched = unsafe { ShellExecuteExW(&mut sei) }.is_ok();
    if launched && !sei.hProcess.is_invalid() {
        unsafe {
            let _ = WaitForSingleObject(sei.hProcess, INFINITE);
        }
    }
    dir.is_dir()
}

#[cfg(not(windows))]
pub fn create_dir_elevated(_dir: &Path) -> bool {
    false
}
