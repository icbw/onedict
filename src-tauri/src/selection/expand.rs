//! 懒扩句（收藏语境捕获）：把选区扩展为完整句子作为收词语境。
//!
//! 取数时机（两段式，均不碰捕获热线的 p95 决策门）：
//! - **捕获时预取**（主路径）：捕获成功即后台线程预扩句——此刻源应用前台、
//!   选区存活；面板出现并抢焦点后源应用 `GetSelection` 会报空（Word 实测），
//!   语境必须趁前台拿到。单飞标记防线程堆积（UIA 挂起时预取停摆）。
//! - **收藏时实况扩句**（兜底）：预取未就绪（竞态 / 单飞跳过）时按句柄重导航
//!   尝试——成功与否都降级不阻塞收藏。
//! - 导航一律**句柄直达**（捕获时记 HWND → GUITHREADINFO 线程焦点 →
//!   ElementFromHandle）：收藏时面板盖住选区，屏幕坐标命中的是自家 WebView2
//!   （首查触发 Chromium 无障碍惰性初始化，实测挂 ~2.5s——首版教训）。
//! - 任一环节失败**永不阻塞收藏**——调用方拿降级元数据继续 add。

use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::TextUnit_Paragraph;
use windows::Win32::UI::WindowsAndMessaging::{
    GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
};

use super::uia;
use super::SHARED;

/// UIA 扩句超时（超时即降级；停在此超时上的线程无害——随完成自然退出）
const EXPAND_TIMEOUT_MS: u64 = 1000;

/// 预扩句结果（捕获时刻后台预取完成，写入锚点）
#[derive(Clone)]
pub struct PreExpanded {
    pub sentence: String,
    pub word_offset: Option<[u32; 2]>,
}

/// 预取单飞标记：上一条未完成（源应用 UIA 挂起）时跳过本次，防线程堆积。
/// 挂死即预取停摆，收藏时实况扩句兜底（焦点被抢场景可能失败——可接受降级，
/// 正常链路毫秒级完成并复位）
static PRE_EXPAND_RUNNING: AtomicBool = AtomicBool::new(false);

/// 捕获成功即后台预扩句（finish_capture 尾部调用；只对 UIA 路径——剪贴板/
/// 监听路径无句可取）。完成后写回锚点 `pre_expanded`；锚点已被新捕获顶掉
/// （captured_at 变化）则丢弃，绝不张冠李戴。
pub fn spawn_pre_expansion(source_hwnd: isize, text: String, captured_at: i64) {
    if PRE_EXPAND_RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("selection-pre-expand".into())
        .spawn(move || {
            // 预取 = 捕获时刻，源应用前台焦点未动（浮标不抢焦）→ GetFocusedElement
            // 与捕获 worker 同款路径优先（捕获刚验证可行）
            let result = expand_sentence(source_hwnd, &text, true);
            PRE_EXPAND_RUNNING.store(false, Ordering::Release);
            match result {
                Ok((sentence, word_offset)) => {
                    tracing::debug!(
                        target: "selection::expand",
                        sentence_chars = sentence.chars().count(),
                        "pre-expansion ok"
                    );
                    if let Ok(mut st) = SHARED.lock() {
                        if let Some(anchor) = st.capture_anchor.as_mut() {
                            if anchor.captured_at == captured_at && anchor.text == text {
                                anchor.pre_expanded =
                                    Some(PreExpanded { sentence, word_offset });
                            }
                        }
                    }
                }
                Err(reason) => {
                    tracing::info!(target: "selection::expand", reason, "pre-expansion failed (fallback: live expand at collect)");
                }
            }
        });
    if spawned.is_err() {
        PRE_EXPAND_RUNNING.store(false, Ordering::Release);
    }
}

/// 扩句结果。sentence 空 = 降级态（仅来源元数据）；命令返回 None = 无匹配锚点
/// （会话内未捕获过 / 面板词与锚点文本不一致，如 OCR 复用面板），调用方按
/// manual 来源收藏。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExpandContext {
    pub sentence: String,
    /// [start, end)，UTF-16 code unit 偏移（JS 字符串索引直接可用）；None = 未定位到
    pub word_offset: Option<[u32; 2]>,
    pub source_app: Option<String>,
    /// "selection"（UIA 捕获）/ "clipboard"（兜底或监听，无句）
    pub kind: String,
    pub captured_at: i64,
}

#[tauri::command]
pub fn selection_expand_context(word: String) -> Option<ExpandContext> {
    let anchor = SHARED.lock().ok().and_then(|st| st.capture_anchor.clone())?;
    // 面板词必须就是被捕获词：不匹配（OCR / 陈旧锚点）即放弃，绝不给旧语境
    if anchor.text != word {
        tracing::info!(target: "selection::expand", "no context: panel word != anchor text (stale anchor or manual entry)");
        return None;
    }
    let degraded = || ExpandContext {
        sentence: String::new(),
        word_offset: None,
        source_app: anchor.source_app.clone(),
        kind: if anchor.mode == "uia" { "selection" } else { "clipboard" }.to_string(),
        captured_at: anchor.captured_at,
    };
    // 非 UIA 路径（剪贴板兜底 / 监听）没有可重导航的 TextPattern → 仅来源元数据
    if anchor.mode != "uia" {
        return Some(degraded());
    }
    // 预扩句命中（捕获时刻趁源应用前台预取，与面板焦点无关）→ 直接取用
    if let Some(pre) = anchor.pre_expanded.clone() {
        tracing::info!(
            target: "selection::expand",
            sentence_chars = pre.sentence.chars().count(),
            "expand ok (pre-expanded at capture time)"
        );
        return Some(ExpandContext {
            sentence: pre.sentence,
            word_offset: pre.word_offset,
            ..degraded()
        });
    }
    // 独立线程重导航（超时 / panic / 失败统一走降级，不拖收藏）。
    // prefer_focused=false：此刻面板已抢焦点，焦点路径必命中自家 WebView2
    let (tx, rx) = std::sync::mpsc::channel();
    let source_hwnd = anchor.source_hwnd;
    let selected = anchor.text.clone();
    std::thread::Builder::new()
        .name("selection-expand".into())
        .spawn(move || {
            let _ = tx.send(expand_sentence(source_hwnd, &selected, false));
        })
        .ok()?;
    let started = std::time::Instant::now();
    match rx.recv_timeout(std::time::Duration::from_millis(EXPAND_TIMEOUT_MS)) {
        Ok(Ok((sentence, word_offset))) => {
            tracing::info!(
                target: "selection::expand",
                elapsed_ms = started.elapsed().as_millis() as u64,
                sentence_chars = sentence.chars().count(),
                "expand ok (sentence captured)"
            );
            Some(ExpandContext {
                sentence,
                word_offset,
                ..degraded()
            })
        }
        // 线程完成但失败：reason 由失败环节给出（各阶段日志定位卡点）
        Ok(Err(reason)) => {
            tracing::info!(target: "selection::expand", elapsed_ms = started.elapsed().as_millis() as u64, reason, "expand degraded (stage failure)");
            Some(degraded())
        }
        // 超时（含线程 panic：send 不发生 → recv 超时）
        Err(_) => {
            tracing::info!(target: "selection::expand", timeout_ms = EXPAND_TIMEOUT_MS, "expand degraded (timeout or worker panic)");
            Some(degraded())
        }
    }
}

/// 重导航扩句：句柄取元素 → TextPattern → GetSelection → ExpandToEnclosingUnit。
/// 任一环节失败返回 Err(原因)（调用方降级）。每阶段落 info 日志——线程若挂死，
/// 日志停在挂死阶段之后（外层超时不可见内部，阶段打点是唯一定位手段）。
fn expand_sentence(
    source_hwnd: isize,
    selected: &str,
    prefer_focused: bool,
) -> Result<(String, Option<[u32; 2]>), String> {
    // SAFETY: 专用线程 COM 初始化（MTA，UIA 推荐）；S_FALSE（已初始化）视为成功。
    // 正常路径配对 CoUninitialize；expand_once panic 时跳过——线程随即终止，
    // MTA 计数残留对进程生命周期内的一次性线程无害
    tracing::debug!(target: "selection::expand", stage = "co-init");
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return Err("co-initialize failed".into());
        }
        let result = expand_once(source_hwnd, selected, prefer_focused);
        tracing::debug!(target: "selection::expand", stage = "expand_once returned", ok = result.is_ok());
        CoUninitialize();
        result
    }
}

/// 源应用线程的内部焦点窗口（GUITHREADINFO **按线程查询**——线程焦点状态独立于
/// OS 前台，面板抢焦不清除源应用自己的焦点记录；Word/记事本由此直达文档控件）
fn thread_focus_hwnd(source_hwnd: isize) -> Option<isize> {
    // SAFETY: Win32 查询链
    unsafe {
        let hwnd = HWND(source_hwnd as *mut core::ffi::c_void);
        if hwnd.is_invalid() {
            return None;
        }
        let thread = GetWindowThreadProcessId(hwnd, None);
        if thread == 0 {
            return None;
        }
        let mut gti = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(thread, &mut gti).is_err() {
            return None;
        }
        if gti.hwndFocus.is_invalid() {
            None
        } else {
            Some(gti.hwndFocus.0 as isize)
        }
    }
}

/// SAFETY: 调用方线程已 CoInitializeEx(MTA)。
/// `prefer_focused`：预取场景（捕获时刻源应用前台焦点未动）为 true——
/// GetFocusedElement → TextPattern 与捕获 worker 同款路径优先。Chromium 实测
/// 句柄链的首个 TextPattern 后代是 Omnibox（空选区）而非文档元素；焦点路径
/// 无此歧义。收藏时兜底场景为 false（焦点已被面板抢走，焦点路径必命中自家
/// WebView2），直接走句柄链。
unsafe fn expand_once(
    source_hwnd: isize,
    selected: &str,
    prefer_focused: bool,
) -> Result<(String, Option<[u32; 2]>), String> {
    let uia = uia::Uia::new().map_err(|e| format!("uia-init: {e}"))?;

    if prefer_focused {
        tracing::debug!(target: "selection::expand", stage = "focused-path");
        if let Ok(element) = uia.focused() {
            if let Ok(pattern) = uia.text_pattern(&element) {
                if let Ok(Some(range)) = uia.first_nonempty_range(&pattern) {
                    // SAFETY: 本函数处于 CoInitializeEx(MTA) 线程
                    if let Ok(result) = unsafe { finish_expand(&range, selected) } {
                        return Ok(result);
                    }
                }
            }
        }
        tracing::debug!(target: "selection::expand", stage = "focused-path missed, handle-path fallback");
    }

    if source_hwnd == 0 {
        return Err("no source hwnd captured".into());
    }
    tracing::debug!(target: "selection::expand", stage = "element-from-handle", hwnd = source_hwnd);
    // 线程焦点窗口优先（Word/记事本直达文档控件），失败退源窗口顶层元素
    let element = thread_focus_hwnd(source_hwnd)
        .and_then(|h| uia.element_from_handle(h).ok())
        .or_else(|| uia.element_from_handle(source_hwnd).ok())
        .ok_or("element-from-handle failed (source window gone?)")?;
    tracing::debug!(target: "selection::expand", stage = "text-pattern");
    // TextPattern：句柄元素自身没有则找后代首个支持者（Chromium 的文档节点在
    // 渲染窗口元素之下）；后续选区校验兜底——找错元素读不到匹配选区自然放弃
    let pattern = match uia.text_pattern(&element) {
        Ok(p) => p,
        Err(e) => uia
            .first_text_pattern_descendant(&element)
            .map_err(|_| format!("no TextPattern under source window: {e}"))?,
    };
    tracing::debug!(target: "selection::expand", stage = "get-selection");
    let range = match uia.first_nonempty_range(&pattern) {
        Ok(Some(r)) => r,
        // 面板已抢焦点：多数应用保留选区，但部分（或点击后）选区消失 → 无法重取
        Ok(None) => return Err("no-selection (source app reported empty selection)".into()),
        Err(e) => return Err(format!("get-selection failed: {e}")),
    };
    // SAFETY: 调用方线程已 CoInitializeEx(MTA)
    unsafe { finish_expand(&range, selected) }
}

/// 选区校验 + 扩段 + 文本层切句（两条导航路径共用尾部）。
/// SAFETY: 调用方线程已 CoInitializeEx(MTA)
unsafe fn finish_expand(
    range: &windows::Win32::UI::Accessibility::IUIAutomationTextRange,
    selected: &str,
) -> Result<(String, Option<[u32; 2]>), String> {
    // 选区须仍是收藏的词：用户可能已改选区，扩出的段落对新选区才有意义，
    // 对旧词无意义 → 放弃（归一化空白比较，与捕获侧 trim 语义一致）
    let current = uia::Uia::range_text(range);
    tracing::debug!(target: "selection::expand", stage = "selection-check", matched = current.trim() == selected.trim());
    if current.trim() != selected.trim() {
        return Err(format!(
            "selection-changed: now {:?} != captured {:?}",
            current.trim(),
            selected.trim()
        ));
    }
    tracing::debug!(target: "selection::expand", stage = "expand-to-paragraph");
    // UIA TextUnit 无 Sentence 粒度（Character/Format/Word/Line/Paragraph/Page/Document）：
    // 扩到段落后在文本层按句读符号切句，切不出 → 整段即语境（入库侧截断兜底）
    // SAFETY: COM 接口调用（同上）
    if let Err(e) = unsafe { range.ExpandToEnclosingUnit(TextUnit_Paragraph) } {
        return Err(format!("expand-to-paragraph failed: {e}"));
    }
    let paragraph = uia::Uia::range_text(range);
    if paragraph.trim().is_empty() {
        return Err("empty-paragraph".into());
    }
    match extract_sentence_around(&paragraph, selected) {
        Some((sentence, word_offset)) => Ok((sentence, Some(word_offset))),
        None => {
            // 切不出句界（整段无句读）→ 整段即语境（入库截断兜底）
            let word_offset = utf16_offset(&paragraph, selected);
            Ok((paragraph, word_offset))
        }
    }
}

/// 从段落文本中切出选区词所在的句子（UIA 只有段落粒度，句子在文本层还原）。
/// 句界 = 句读符（.!?。！？…）后随空白/引号/串尾；`e.g.` 类缩写会误切——
/// 语境句多包/少包一个短语无伤大雅，换复杂 NLP 不值得（句子质量优化属复习卡打磨期）。
/// 返回 (句子, 词偏移 UTF-16)；词不在段落中 → None（调用方降级）。
fn extract_sentence_around(paragraph: &str, selected: &str) -> Option<(String, [u32; 2])> {
    let chars: Vec<char> = paragraph.chars().collect();
    let word: Vec<char> = selected.chars().collect();
    if word.is_empty() || chars.len() < word.len() {
        return None;
    }
    // 词在段落中的 char 偏移
    let start = (0..=chars.len() - word.len())
        .find(|&i| chars[i..i + word.len()] == word[..])?;
    let end = start + word.len();
    let is_sentence_break = |idx: usize| -> bool {
        let c = chars[idx];
        // 中文句读后无空白书写习惯 → 符号本身即句界
        if "。！？…".contains(c) {
            return true;
        }
        if !".!?".contains(c) {
            return false;
        }
        // 西文句读需后随空白/引号/串尾（排除 3.14；e.g. 类缩写会误切，接受——
        // 语境句多包/少包一个短语无伤大雅）
        match chars.get(idx + 1) {
            None => true,
            Some(&next) => next.is_whitespace() || "\"'”』」〉》>)".contains(next),
        }
    };
    // 句尾 = 词之后第一个句读；句首 = 词之前最后一个句读之后
    let mut sent_end = chars.len();
    for i in end..chars.len() {
        if is_sentence_break(i) {
            sent_end = i + 1;
            // 吞掉紧随的收尾引号（"It works." 的右引号属本句）
            while sent_end < chars.len() && "\"'”』」〉》)".contains(chars[sent_end]) {
                sent_end += 1;
            }
            break;
        }
    }
    let mut sent_start = 0;
    for i in (0..start).rev() {
        if is_sentence_break(i) {
            sent_start = i + 1;
            break;
        }
    }
    while sent_start < start && chars[sent_start].is_whitespace() {
        sent_start += 1;
    }
    let sentence: String = chars[sent_start..sent_end].iter().collect();
    // 词在句内 char 偏移 → UTF-16 code unit 偏移（JS 字符串索引直接可用）
    let prefix_utf16: usize = chars[sent_start..start]
        .iter()
        .map(|c| c.len_utf16())
        .sum();
    let word_utf16: usize = word.iter().map(|c| c.len_utf16()).sum();
    Some((sentence, [prefix_utf16 as u32, (prefix_utf16 + word_utf16) as u32]))
}

/// 选区词在句中的偏移，单位 UTF-16 code unit（JS 字符串的天然索引单位，
/// 前端 slice 直接可用）。找不到（被换行打断 / 跨句边界等）→ None。
fn utf16_offset(haystack: &str, needle: &str) -> Option<[u32; 2]> {
    let hay: Vec<u16> = haystack.encode_utf16().collect();
    let nee: Vec<u16> = needle.encode_utf16().collect();
    if nee.is_empty() || hay.len() < nee.len() {
        return None;
    }
    (0..=hay.len() - nee.len())
        .find(|&i| hay[i..i + nee.len()] == nee[..])
        .map(|i| [i as u32, (i + nee.len()) as u32])
}

#[cfg(test)]
mod tests {
    use super::{extract_sentence_around, utf16_offset};

    #[test]
    fn utf16_offset_matches_ascii_cjk_and_emoji() {
        // ASCII：句首第 4 码位起
        assert_eq!(utf16_offset("The quick brown fox.", "quick"), Some([4, 9]));
        // 中文：UTF-16 每汉字 1 码位
        assert_eq!(utf16_offset("这是一只敏捷的狐狸。", "敏捷"), Some([4, 6]));
        // emoji（代理对）：偏移按 UTF-16 码位计（JS slice 语义一致）——
        // "好快"占 2 码位，🦊 从 2 起、代理对占 2 码位
        assert_eq!(utf16_offset("好快🦊的狐狸", "🦊"), Some([2, 4]));
        // 不存在 / 空词
        assert_eq!(utf16_offset("abc", "xyz"), None);
        assert_eq!(utf16_offset("abc", ""), None);
        // 空句找空词（空词永远 None）
        assert_eq!(utf16_offset("", "a"), None);
    }

    #[test]
    fn sentence_extraction_picks_enclosing_clause() {
        // 多句段落：只取词所在句（含句读符），偏移为句内 UTF-16 位置
        let paragraph = "First sentence ends. The quick fox jumps. Third one.";
        let (sentence, offset) =
            extract_sentence_around(paragraph, "fox").unwrap();
        assert_eq!(sentence, "The quick fox jumps.");
        assert_eq!(offset, [10, 13]);

        // 中文句读
        let (sentence, offset) =
            extract_sentence_around("天空很蓝。那只狐狸很快。就这样。", "狐狸").unwrap();
        assert_eq!(sentence, "那只狐狸很快。");
        assert_eq!(offset, [2, 4]);

        // 句读后引号：右引号并入本句；句首无前导句读则从段首起（叙述部分随引语入句）
        let (sentence, _) =
            extract_sentence_around("He said \"It works.\" Then left.", "works").unwrap();
        assert_eq!(sentence, "He said \"It works.\"");

        // 词不在段落 → None
        assert!(extract_sentence_around("nothing here", "fox").is_none());

        // 无句读（整段即语境句），偏移仍算出
        let (sentence, offset) =
            extract_sentence_around("no punctuation at all just words", "punctuation").unwrap();
        assert_eq!(sentence, "no punctuation at all just words");
        assert_eq!(offset, [3, 14]);
    }
}
