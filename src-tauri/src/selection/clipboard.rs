//! 剪贴板兜底捕获：UIA 路径失败（无 TextPattern / 焦点元素不可达，如 Acrobat 保护模式、
//! Gecko、微信等自绘 UI）时，模拟 Ctrl+Insert → Ctrl+C 读选区文本。
//!
//! 行为参照 selection-hook（MIT）`src/windows/selection_hook.cc` GetTextViaClipboard，
//! Rust 重写。spike 简化：剪贴板备份/恢复仅 CF_UNICODETEXT（全格式备份见其 clipboard.cc）。
//!
//! 安全护栏（照抄源码语义）：
//! - 意图检查：用户正按 Ctrl+C/X/V 时放弃（不干扰用户自己的复制/剪切/粘贴）
//! - 鼠标按下后剪贴板序列号已变 → 用户刚复制过，直接读，不注入
//! - 全程备份原剪贴板文本并在读取后恢复
//! - 键盘钩子忽略注入事件（LLKHF_INJECTED），自身 SendInput 不会误触发隐藏

use std::time::Duration;

use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Ole::{CF_DIB, CF_UNICODETEXT};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_KEYBOARD, INPUT_0, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL,
};

/// 序列号变化后仍需额外等待的应用（selection-hook delay-read 清单；Acrobat 为实证项）
const DELAY_READ_PROGRAMS: &[&str] = &["acrobat.exe", "acrord32.exe"];

const VK_C: u16 = 0x43;
const VK_X: u16 = 0x58;
const VK_V: u16 = 0x56;
const VK_INSERT: u16 = 0x2D;

pub fn sequence() -> u32 {
    // SAFETY: 无参数剪贴板查询
    unsafe { GetClipboardSequenceNumber() }
}

fn in_delay_list(program: Option<&str>) -> bool {
    program.is_some_and(|p| DELAY_READ_PROGRAMS.contains(&p))
}

fn pressed(vk: u16) -> bool {
    // SAFETY: 异步按键状态查询
    unsafe { GetAsyncKeyState(vk as i32) & 0x8000u16 as i16 != 0 }
}

/// 读剪贴板文本（失败/无文本 → None）
pub fn read_text() -> Option<String> {
    // SAFETY: 标准剪贴板读取；句柄内存由系统所有，仅加锁拷贝不释放
    unsafe {
        for _ in 0..5 {
            if OpenClipboard(None).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let result = (|| {
            if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_err() {
                return None;
            }
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
            let hglobal = HGLOBAL(handle.0);
            let size = GlobalSize(hglobal);
            if size == 0 {
                return None;
            }
            let ptr = GlobalLock(hglobal);
            if ptr.is_null() {
                return None;
            }
            let len = size / 2;
            let slice = std::slice::from_raw_parts(ptr as *const u16, len);
            // 去掉结尾 NUL
            let end = slice.iter().position(|&c| c == 0).unwrap_or(len);
            let text = String::from_utf16_lossy(&slice[..end]);
            let _ = GlobalUnlock(hglobal);
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        })();
        let _ = CloseClipboard();
        result
    }
}

/// 备份当前剪贴板文本（spike 仅文本；EmptyClipboard 由调用方执行）
fn backup_text() -> Option<String> {
    read_text()
}

/// 写文本到剪贴板（划词栏「复制」动作；同恢复语义，系统接管内存无需释放）
pub fn write_text(text: &str) {
    restore_text(text);
}

/// 写图片到剪贴板（截图「复制截图」动作）：入参 = 前端组装好的 CF_DIB 字节
/// （BITMAPINFOHEADER + 32bpp BGRA 自底向上像素，BMP 去 14 字节文件头部分）的
/// base64。像素组装在前端（canvas 已解码快照 PNG，Rust 免图片解码依赖）；
/// 系统接管 SetClipboardData 内存，无需释放。
pub fn write_image_dib(dib_b64: &str) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(dib_b64)
        .map_err(|e| format!("dib base64 decode: {e}"))?;
    if bytes.len() <= 40 {
        return Err("dib too small (no BITMAPINFOHEADER?)".into());
    }
    // SAFETY: 标准剪贴板写入（write_text 同款重试 + 收尾关闭）
    unsafe {
        for _ in 0..5 {
            if OpenClipboard(None).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if OpenClipboard(None).is_err() {
            return Err("OpenClipboard failed".into());
        }
        let result = (|| {
            let _ = EmptyClipboard();
            if let Ok(hglobal) = GlobalAlloc(GMEM_MOVEABLE, bytes.len()) {
                let ptr = GlobalLock(hglobal);
                if !ptr.is_null() {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
                    let _ = GlobalUnlock(hglobal);
                    if SetClipboardData(CF_DIB.0 as u32, Some(HANDLE(hglobal.0))).is_ok() {
                        return Ok(());
                    }
                }
            }
            Err("SetClipboardData(CF_DIB) failed".into())
        })();
        let _ = CloseClipboard();
        result
    }
}

/// 恢复文本到剪贴板（系统接管 SetClipboardData 内存，无需释放）
fn restore_text(text: &str) {
    // SAFETY: 标准剪贴板写入
    unsafe {
        if OpenClipboard(None).is_err() {
            return;
        }
        let mut wrote = false;
        let _ = EmptyClipboard();
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        if let Ok(hglobal) = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2) {
            let ptr = GlobalLock(hglobal);
            if !ptr.is_null() {
                std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr as *mut u16, wide.len());
                let _ = GlobalUnlock(hglobal);
                wrote = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(hglobal.0))).is_ok();
            }
        }
        let _ = CloseClipboard();
        // 剪贴板监听自写识别：仅成功写入后标记——失败时序列号未变，
        // 误标会把用户刚复制的内容当作我方写入而丢弃触发
        if wrote {
            super::clipmon::mark_own_write();
        }
    }
}

fn send_key(vk: u16, up: bool) {
    // SAFETY: 标准输入注入（键盘钩子已忽略注入事件，不会误触隐藏）
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
            wVk: VIRTUAL_KEY(vk),
            wScan: 0,
            dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
            time: 0,
            dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

/// Ctrl+Insert（多数场景更安全，部分应用不支持）或 Ctrl+C
fn send_copy(ctrl_c: bool) {
    let letter = if ctrl_c { VK_C } else { VK_INSERT };
    send_key(VK_CONTROL.0, false);
    send_key(letter, false);
    send_key(letter, true);
    send_key(VK_CONTROL.0, true);
}

fn wait_for_change(baseline: u32, polls: usize, interval_ms: u64) -> bool {
    for _ in 0..polls {
        if sequence() != baseline {
            return true;
        }
        std::thread::sleep(Duration::from_millis(interval_ms));
    }
    false
}

/// 兜底捕获主流程。返回选区文本；None = 放弃（用户在复制/注入无响应等）。
/// 耗时上限约：意图检查 ≤200ms + Ctrl+Insert 100ms + Ctrl+C 180ms + delay 135ms。
pub fn capture_via_clipboard(program: Option<&str>) -> Option<String> {
    let seq0 = sequence();

    // 意图检查：轮询 ~200ms；期间若序列号已变（用户刚复制）直接读
    let mut saw_ctrl = false;
    let mut saw_copy_key = false;
    let mut checks = 0;
    while checks < 5 {
        if sequence() != seq0 {
            return read_text();
        }
        let ctrl = pressed(VK_CONTROL.0);
        let c = pressed(VK_C);
        let x = pressed(VK_X);
        let v = pressed(VK_V);
        if !ctrl && !c && !x && !v {
            break;
        }
        saw_ctrl |= ctrl;
        saw_copy_key |= c || x || v;
        checks += 1;
        std::thread::sleep(Duration::from_millis(40));
    }
    if checks >= 5 || (saw_ctrl && saw_copy_key) {
        return None; // 用户在复制/剪切/粘贴，不干扰
    }

    let backup = backup_text();
    // 备份失败（剪贴板当前是非文本格式：图片/文件/RTF）→ 放弃恢复：
    // restore_text 内部必 EmptyClipboard，无备份可回写时会把用户非文本剪贴板
    // 抹成空文本。兜底默认开启，每次 UIA 失败的划词都会走到这里。
    let restore_backup = || {
        if let Some(text) = backup.as_deref() {
            restore_text(text);
        }
    };

    // ① Ctrl+Insert（更安全）
    let seq1 = sequence();
    send_copy(false);
    if wait_for_change(seq1, 20, 5) {
        std::thread::sleep(Duration::from_millis(10));
        let text = read_text();
        restore_backup();
        if text.is_some() {
            return text;
        }
        // 读失败/为空：继续下一跳 Ctrl+C（备份仍保留）
    }

    // ② Ctrl+C
    let seq2 = sequence();
    send_copy(true);
    if wait_for_change(seq2, 36, 5) {
        if in_delay_list(program) {
            std::thread::sleep(Duration::from_millis(135));
        }
        std::thread::sleep(Duration::from_millis(10));
        let text = read_text();
        restore_backup();
        return text;
    }

    restore_backup();
    None
}
