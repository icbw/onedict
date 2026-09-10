//! 剪贴板监听查词：任意程序复制文本 → 自动弹出划词浮标。
//!
//! 实现取轮询 `GetClipboardSequenceNumber`（200ms）而非剪贴板监听窗口（message-only
//! 窗口 + AddClipboardFormatListener + WM_CLIPBOARDUPDATE）：序列号查询近乎零开销，
//! 轮询天然合批一次复制的多格式写通知，且免去窗口类注册/消息泵的平台耦合；
//! 「复制即查」对延迟不敏感（≤200ms 弹出完全可接受）。
//!
//! 循环/自触发防护（hardening-plan §6「剪贴板监听查词」项要求）：
//! 1. 兜底捕获注入复制（Ctrl+Insert/Ctrl+C 让目标程序写剪贴板）→ 抑制窗：
//!    capture.rs 兜底分支进入时 suppress(1.5s)、退出时 suppress(400ms) 覆盖恢复写；
//! 2. 我方写剪贴板（restore_text 恢复 / 浮标复制动作 write_text）→ 写后记录序列号
//!    （OWN_SEQS，FIFO），轮询命中 → 丢弃；
//! 3. 前台窗口是本应用（词条/AI 输出内复制）→ 丢弃；
//! 4. 同文本 1s 去重（程序连写/连按 Ctrl+C 合并）+ 长度上限（查词语义 = 词/短语）。
//!
//! 文本读取复用 clipboard::read_text（OpenClipboard 重试 + CF_UNICODETEXT）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

use super::layout::Point;
use super::WorkerMsg;

/// 轮询周期 = 弹出延迟上限（序列号查询耗时可忽略）
const POLL_MS: u64 = 200;
/// 单文本长度上限（字符数）：长段落/代码/URL 列表不属于「复制即查」语义
const MAX_TEXT_CHARS: usize = 500;
/// 同文本去重窗：一次复制常产生多条序列号变化，连按 Ctrl+C 视为一次触发
const DUPLICATE_WINDOW_MS: u128 = 1000;
/// 我方写入序列号记录容量（FIFO；单次写入 = 序列号 +1~2，8 足以覆盖并发写）
const OWN_SEQ_CAP: usize = 8;

static ENABLED: AtomicBool = AtomicBool::new(false);
/// 兜底捕获期间的抑制窗终点（capture.rs 兜底分支标记）
static SUPPRESS_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
/// 我方写剪贴板后的序列号（restore_text 成功路径标记）
static OWN_SEQS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
/// 上次触发文本（同文本去重）
static LAST: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// 开关同步（selection_set_clipboard_lookup / restore_from_prefs）
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

/// 标记抑制窗（now + for_ms）：窗口内轮询到的变化全部丢弃
pub(crate) fn suppress(for_ms: u64) {
    let until = Instant::now() + Duration::from_millis(for_ms);
    *SUPPRESS_UNTIL.lock().unwrap_or_else(|e| e.into_inner()) = Some(until);
}

/// 我方写入剪贴板成功后调用（restore_text；序列号记录供轮询路径识别自写）
pub(super) fn mark_own_write() {
    let seq = super::clipboard::sequence();
    let mut v = OWN_SEQS.lock().unwrap_or_else(|e| e.into_inner());
    v.push(seq);
    if v.len() > OWN_SEQ_CAP {
        v.remove(0);
    }
}

/// 纯函数：长度在 (0, MAX_TEXT_CHARS] 内才触发
fn text_ok(text: &str) -> bool {
    let n = text.chars().count();
    0 < n && n <= MAX_TEXT_CHARS
}

/// 纯函数：同文本去重窗内视为重复
fn is_duplicate(text: &str, last: Option<&(String, Instant)>, now: Instant) -> bool {
    last.is_some_and(|(t, at)| {
        t == text && now.duration_since(*at).as_millis() < DUPLICATE_WINDOW_MS
    })
}

/// 启动监听线程（常驻；开关 = AtomicBool，关闭时仅不触发、序列号照常跟进）
pub fn spawn() {
    let spawned = std::thread::Builder::new()
        .name("selection-clipmon".into())
        .spawn(monitor_loop);
    if let Err(e) = spawned {
        tracing::error!("selection: failed to spawn clipmon thread: {e}");
    }
}

fn monitor_loop() {
    let mut last_seq = super::clipboard::sequence();
    tracing::info!("selection: clipmon loop ready (baseline seq {last_seq})");
    loop {
        std::thread::sleep(Duration::from_millis(POLL_MS));
        let seq = super::clipboard::sequence();
        if seq == last_seq {
            continue;
        }
        last_seq = seq;
        // 关闭状态不触发，但保持序列号跟进——开启瞬间不把陈旧变化当新复制
        if !enabled() {
            continue;
        }
        process_change(seq);
    }
}

/// 剪贴板变化处理：防护判定 → 读文本 → 投递 worker（失败/过滤 = 静默丢弃）
fn process_change(seq: u32) {
    // ① 兜底捕获抑制窗（注入复制让目标程序写剪贴板 / 恢复写入）
    if SUPPRESS_UNTIL
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some_and(|t| Instant::now() < t)
    {
        return;
    }
    // ② 我方写入（浮标复制动作 / 兜底恢复）
    if take_own_seq(seq) {
        return;
    }
    // ③ 本应用内复制（词条/翻译/AI 输出）不再触发
    if super::uia::foreground_process_name().is_some_and(|p| p == "onedict.exe") {
        return;
    }
    let Some(text) = super::clipboard::read_text() else {
        return;
    };
    // ④ 长度门 + 同文本去重
    if !text_ok(&text) {
        return;
    }
    let now = Instant::now();
    let duplicate = {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let dup = is_duplicate(&text, last.as_ref(), now);
        *last = Some((text.clone(), now));
        dup
    };
    if duplicate {
        return;
    }
    // 锚点 = 当前鼠标位置（键盘 Ctrl+C 后鼠标通常在选区附近；右键复制在菜单旁）
    let anchor = cursor_pos();
    super::hook::send_worker(WorkerMsg::Clipboard { text, anchor });
}

/// 命中我方记录 → 取出并返回 true（一次写入对应一次消耗，防同号重复拦截）
fn take_own_seq(seq: u32) -> bool {
    let mut v = OWN_SEQS.lock().unwrap_or_else(|e| e.into_inner());
    match v.iter().position(|&s| s == seq) {
        Some(i) => {
            v.remove(i);
            true
        }
        None => false,
    }
}

fn cursor_pos() -> Point {
    // SAFETY: 无参数光标查询
    let mut pt = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut pt);
    }
    Point { x: pt.x, y: pt.y }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_length_gate() {
        assert!(!text_ok(""));
        assert!(text_ok("hello"));
        assert!(text_ok("词"));
        let long = "中".repeat(MAX_TEXT_CHARS);
        assert!(text_ok(&long), "恰达上限（含）放行");
        let too_long = "中".repeat(MAX_TEXT_CHARS + 1);
        assert!(!text_ok(&too_long));
    }

    #[test]
    fn duplicate_within_window() {
        let now = Instant::now();
        // 窗内同文本 → 重复
        let last = (String::from("word"), now - Duration::from_millis(999));
        assert!(is_duplicate("word", Some(&last), now));
        // 超窗 → 非重复
        let last = (String::from("word"), now - Duration::from_millis(1001));
        assert!(!is_duplicate("word", Some(&last), now));
        // 异文本 → 非重复
        let last = (String::from("other"), now);
        assert!(!is_duplicate("word", Some(&last), now));
        // 无历史 → 非重复
        assert!(!is_duplicate("word", None, now));
    }
}
