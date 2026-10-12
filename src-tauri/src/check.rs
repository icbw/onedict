//! 语言检查数据模块：会话存储 + 用户检查配置。
//!
//! 两个单文件 JSON store（模板对齐 history/translate.rs：FILE_VERSION + Mutex +
//! 变更即全量落盘 + 损坏 .corrupt 留档 + 广播）：
//! - check-session.json：检查会话（text_hash 摘要定位 + findings 快照 + 统计）。
//!   **只存 findings 与摘要，不存全文**（隐私 + 体积）；同 hash 重复检查 = 原位更新。
//! - check-terms.json：用户检查配置——术语表（禁用词→首选词，Vale substitution
//!   四元组形态：匹配词 / 替换词 / 说明 / 级别）+ 拼写白名单 + 忽略清单
//!   （ruleId+quote 键控，忽略跨重启与跨文档不复发）。
//!
//! 拼写探针 check_spell_lookup 走词典模块 Registry::has_words（key 索引二分，
//! 不解压记录块）；术语匹配与英文形态还原在前端规则引擎（纯函数，node 基线覆盖），
//! Rust 侧只管持久化与词典存在性判定。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const SESSION_FILE: &str = "check-session.json";
pub const TERMS_FILE: &str = "check-terms.json";

const SESSIONS_FILE_VERSION: u32 = 1;
const TERMS_FILE_VERSION: u32 = 1;
/// 会话容量：超过淘汰最旧（findings 快照比历史条目大，上限收紧）
const MAX_SESSIONS: usize = 50;
/// 单会话 findings 快照上限（防御病态输入撑爆落盘）
const MAX_FINDINGS_PER_SESSION: usize = 500;
/// 忽略清单容量：超过淘汰最旧（用户可随时在管理页清理）
const MAX_IGNORED: usize = 500;
/// 白名单容量（防御性上限；正常使用远达不到）
const MAX_WHITELIST: usize = 2000;

const TERM_LEVELS: &[&str] = &["info", "warning", "error"];

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 截断到指定 char 数（预览/哈希等由客户端生成，服务端再收紧一次）
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

// ────────────────────────── check-terms.json ──────────────────────────

/// 术语表条目（Vale substitution 四元组：wrong=匹配词 / right=首选词 /
/// note=说明 / level=级别；enabled 软停用避免删了又建）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TermEntry {
    #[serde(default)]
    pub id: u64,
    pub wrong: String,
    pub right: String,
    #[serde(default)]
    pub note: Option<String>,
    pub level: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// 忽略记录：ruleId+quote 双字段键控（同规则命中不同文本仍会提示）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredEntry {
    pub rule_id: String,
    pub quote: String,
    pub at: i64,
}

/// 命令返回的配置全量（terms / whitelist / ignored 三段一起走，
/// 前端单一 state 对齐，避免分段拉取的交错）
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckTermsPayload {
    #[serde(default)]
    pub terms: Vec<TermEntry>,
    #[serde(default)]
    pub whitelist: Vec<String>,
    #[serde(default)]
    pub ignored: Vec<IgnoredEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckTermsFile {
    version: u32,
    next_term_id: u64,
    terms: Vec<TermEntry>,
    whitelist: Vec<String>,
    ignored: Vec<IgnoredEntry>,
}

impl Default for CheckTermsFile {
    fn default() -> Self {
        Self {
            version: TERMS_FILE_VERSION,
            next_term_id: 1,
            terms: Vec::new(),
            whitelist: Vec::new(),
            ignored: Vec::new(),
        }
    }
}

struct CheckTermsState {
    next_term_id: u64,
    terms: Vec<TermEntry>,
    whitelist: Vec<String>,
    ignored: Vec<IgnoredEntry>,
    path: PathBuf,
}

impl CheckTermsState {
    fn open(path: PathBuf) -> Self {
        let mut state = Self {
            next_term_id: 1,
            terms: Vec::new(),
            whitelist: Vec::new(),
            ignored: Vec::new(),
            path,
        };
        state.load();
        state
    }

    /// 语义对齐 translate 历史：不存在 → 空；version/形状不符 → warn 空载；
    /// 解析失败 → 改名 .corrupt 留档后空载
    fn load(&mut self) {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return;
        };
        match serde_json::from_str::<CheckTermsFile>(&text) {
            Ok(file) if file.version == TERMS_FILE_VERSION => {
                self.next_term_id = file.next_term_id.max(1);
                self.terms = file.terms;
                self.whitelist = file.whitelist;
                self.ignored = file.ignored;
            }
            Ok(file) => {
                tracing::warn!(target: "check", version = file.version, "check-terms.json 形状不符，按空载处理（下次落盘将覆盖）");
            }
            Err(error) => {
                let backup = self.path.with_extension("json.corrupt");
                match std::fs::rename(&self.path, &backup) {
                    Ok(()) => {
                        tracing::error!(target: "check", backup = %backup.display(), error = %error, "check-terms.json 解析失败，已改名留档并空载");
                    }
                    Err(rename_error) => {
                        tracing::error!(target: "check", error = %error, "check-terms.json 解析失败且留档失败（rename: {rename_error}），按空载处理");
                    }
                }
            }
        }
    }

    fn persist(&self) {
        let file = CheckTermsFile {
            version: TERMS_FILE_VERSION,
            next_term_id: self.next_term_id,
            terms: self.terms.clone(),
            whitelist: self.whitelist.clone(),
            ignored: self.ignored.clone(),
        };
        let text = match serde_json::to_string_pretty(&file) {
            Ok(t) => t,
            Err(error) => {
                tracing::error!(target: "check", error = %error, "check-terms.json 序列化失败");
                return;
            }
        };
        if let Err(error) = crate::fsutil::write_atomic(&self.path, &text) {
            tracing::error!(target: "check", error = %error, "check-terms.json 落盘失败");
        }
    }

    fn payload(&self) -> CheckTermsPayload {
        CheckTermsPayload {
            terms: self.terms.clone(),
            whitelist: self.whitelist.clone(),
            ignored: self.ignored.clone(),
        }
    }

    /// 整表替换术语列表（id==0 / 撞 id 的条目由服务端分配新 id；术语 ruleId =
    /// `term:<id>`，忽略键依赖 id 稳定，所以既有 id 一律保留）。校验失败整单拒绝，
    /// 不做半截写入。
    fn save_terms(&mut self, terms: Vec<TermEntry>) -> Result<(), String> {
        let mut out: Vec<TermEntry> = Vec::with_capacity(terms.len());
        let mut seen_wrong: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut seen_id: std::collections::HashSet<u64> = std::collections::HashSet::new();
        for mut term in terms {
            term.wrong = term.wrong.trim().to_string();
            term.right = term.right.trim().to_string();
            if term.wrong.is_empty() || term.right.is_empty() {
                return Err("禁用词与首选词都不能为空".into());
            }
            if term.wrong == term.right {
                return Err(format!("禁用词与首选词相同：{term}", term = term.wrong));
            }
            if term.wrong.chars().count() > 200 || term.right.chars().count() > 200 {
                return Err("术语过长（上限 200 字）".into());
            }
            if let Some(note) = term.note.as_deref() {
                if note.chars().count() > 500 {
                    return Err("说明过长（上限 500 字）".into());
                }
                if note.trim().is_empty() {
                    term.note = None;
                }
            }
            if !TERM_LEVELS.contains(&term.level.as_str()) {
                return Err(format!("未知级别：{}（可选 info/warning/error）", term.level));
            }
            // 匹配是大小写不敏感的，同词不同大小写的重复条目保留首条
            if !seen_wrong.insert(term.wrong.to_lowercase()) {
                continue;
            }
            if term.id == 0 || !seen_id.insert(term.id) {
                term.id = self.next_term_id;
                self.next_term_id = self.next_term_id.saturating_add(1);
            }
            out.push(term);
        }
        self.terms = out;
        self.persist();
        Ok(())
    }

    fn whitelist_add(&mut self, word: &str) {
        let word = word.trim();
        if word.is_empty() || word.chars().count() > 100 {
            return;
        }
        if self.whitelist.iter().any(|w| w == word) {
            return;
        }
        self.whitelist.push(word.to_string());
        if self.whitelist.len() > MAX_WHITELIST {
            self.whitelist.remove(0);
        }
        self.persist();
    }

    fn whitelist_remove(&mut self, word: &str) {
        let before = self.whitelist.len();
        self.whitelist.retain(|w| w != word.trim());
        if self.whitelist.len() != before {
            self.persist();
        }
    }

    fn ignored_add(&mut self, rule_id: &str, quote: &str) {
        let rule_id = rule_id.trim();
        let quote = quote.trim();
        if rule_id.is_empty() || rule_id.chars().count() > 200 || quote.chars().count() > 300 {
            return;
        }
        if self.ignored.iter().any(|e| e.rule_id == rule_id && e.quote == quote) {
            return;
        }
        self.ignored.push(IgnoredEntry {
            rule_id: rule_id.to_string(),
            quote: quote.to_string(),
            at: now_ms(),
        });
        if self.ignored.len() > MAX_IGNORED {
            self.ignored.remove(0);
        }
        self.persist();
    }

    fn ignored_remove(&mut self, rule_id: &str, quote: &str) {
        let rule_id = rule_id.trim();
        let quote = quote.trim();
        let before = self.ignored.len();
        self.ignored
            .retain(|e| !(e.rule_id == rule_id && e.quote == quote));
        if self.ignored.len() != before {
            self.persist();
        }
    }
}

/// Tauri managed state：命令内持锁短借（全内存操作 + 变更即整文件落盘）
pub struct CheckTermsStore {
    state: Mutex<CheckTermsState>,
}

impl CheckTermsStore {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join(TERMS_FILE);
        if let Err(error) = std::fs::create_dir_all(data_dir) {
            tracing::error!(target: "check", dir = %data_dir.display(), error = %error, "数据目录创建失败（落盘将持续报错）");
        }
        tracing::info!(target: "check", path = %path.display(), "检查配置存储就绪");
        Self {
            state: Mutex::new(CheckTermsState::open(path)),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut CheckTermsState) -> T) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        Ok(f(&mut state))
    }

    /// 从指定路径重读（数据恢复 data_restore 用）
    pub fn reload_from(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        *state = CheckTermsState::open(path);
        Ok(())
    }

    pub fn payload(&self) -> Result<CheckTermsPayload, String> {
        self.with(|s| s.payload())
    }

    pub fn save_terms(&self, terms: Vec<TermEntry>) -> Result<CheckTermsPayload, String> {
        self.with(|s| s.save_terms(terms).map(|_| s.payload()))?
    }

    pub fn whitelist_add(&self, word: &str) -> Result<Vec<String>, String> {
        self.with(|s| {
            s.whitelist_add(word);
            s.whitelist.clone()
        })
    }

    pub fn whitelist_remove(&self, word: &str) -> Result<Vec<String>, String> {
        self.with(|s| {
            s.whitelist_remove(word);
            s.whitelist.clone()
        })
    }

    pub fn ignored_add(&self, rule_id: &str, quote: &str) -> Result<Vec<IgnoredEntry>, String> {
        self.with(|s| {
            s.ignored_add(rule_id, quote);
            s.ignored.clone()
        })
    }

    pub fn ignored_remove(&self, rule_id: &str, quote: &str) -> Result<Vec<IgnoredEntry>, String> {
        self.with(|s| {
            s.ignored_remove(rule_id, quote);
            s.ignored.clone()
        })
    }
}

// ───────────────────────── check-session.json ─────────────────────────

/// 规则层 Finding 的持久化镜像（字段与前端 langcheck/finding.ts 同构，
/// camelCase 序列化；衍生缓存性质数据，全部字段带 default 提高容错）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckSpan {
    pub index: usize,
    pub length: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckFindingRecord {
    pub id: String,
    pub rule_id: String,
    pub category: String,
    pub severity: String,
    pub message: String,
    pub span: Option<CheckSpan>,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    pub anchored: bool,
    pub replacement: Option<String>,
    pub source: String,
    pub fixable: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckSummary {
    pub total: usize,
    pub fixable: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckSessionEntry {
    pub id: u64,
    pub created_at: i64,
    /// 客户端 FNV 双向哈希（trim 后全文），会话去重键——不存全文，靠哈希识别同文
    pub text_hash: String,
    pub char_count: usize,
    /// 首行摘要（≤64 字）：会话列表的展示标签
    pub preview: String,
    pub summary: CheckSummary,
    pub findings: Vec<CheckFindingRecord>,
}

/// 保存入参（id 由服务端分配/复用，客户端不传）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSessionInput {
    pub created_at: i64,
    pub text_hash: String,
    pub char_count: usize,
    pub preview: String,
    pub summary: CheckSummary,
    pub findings: Vec<CheckFindingRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckSessionFile {
    version: u32,
    next_id: u64,
    /// 最近优先
    sessions: Vec<CheckSessionEntry>,
}

struct CheckSessionState {
    next_id: u64,
    sessions: Vec<CheckSessionEntry>,
    path: PathBuf,
}

impl CheckSessionState {
    fn open(path: PathBuf) -> Self {
        let mut state = Self {
            next_id: 1,
            sessions: Vec::new(),
            path,
        };
        state.load();
        state
    }

    fn load(&mut self) {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return;
        };
        match serde_json::from_str::<CheckSessionFile>(&text) {
            Ok(file) if file.version == SESSIONS_FILE_VERSION => {
                self.next_id = file.next_id.max(1);
                self.sessions = file.sessions;
            }
            Ok(file) => {
                tracing::warn!(target: "check", version = file.version, "check-session.json 形状不符，按空载处理（下次落盘将覆盖）");
            }
            Err(error) => {
                let backup = self.path.with_extension("json.corrupt");
                match std::fs::rename(&self.path, &backup) {
                    Ok(()) => {
                        tracing::error!(target: "check", backup = %backup.display(), error = %error, "check-session.json 解析失败，已改名留档并空载");
                    }
                    Err(rename_error) => {
                        tracing::error!(target: "check", error = %error, "check-session.json 解析失败且留档失败（rename: {rename_error}），按空载处理");
                    }
                }
            }
        }
    }

    fn persist(&self) {
        let file = CheckSessionFile {
            version: SESSIONS_FILE_VERSION,
            next_id: self.next_id,
            sessions: self.sessions.clone(),
        };
        let text = match serde_json::to_string_pretty(&file) {
            Ok(t) => t,
            Err(error) => {
                tracing::error!(target: "check", error = %error, "check-session.json 序列化失败");
                return;
            }
        };
        if let Err(error) = crate::fsutil::write_atomic(&self.path, &text) {
            tracing::error!(target: "check", error = %error, "check-session.json 落盘失败");
        }
    }

    /// 同 text_hash 原位更新（保留 id 移到最前）；新文本插最前；超容量淘汰最旧
    fn upsert(&mut self, input: CheckSessionInput) {
        let mut findings = input.findings;
        if findings.len() > MAX_FINDINGS_PER_SESSION {
            tracing::warn!(target: "check", count = findings.len(), "会话 findings 超上限，快照截断");
            findings.truncate(MAX_FINDINGS_PER_SESSION);
        }
        let entry = CheckSessionEntry {
            id: 0,
            created_at: input.created_at,
            text_hash: truncate_chars(input.text_hash.trim(), 64),
            char_count: input.char_count,
            preview: truncate_chars(input.preview.trim(), 64),
            summary: input.summary,
            findings,
        };
        // 同 hash：复用 id（忽略键等外部引用不失效），摘出后重插最前
        let existing_id = self
            .sessions
            .iter()
            .find(|s| s.text_hash == entry.text_hash)
            .map(|s| s.id);
        match existing_id {
            Some(id) => {
                self.sessions.retain(|s| s.text_hash != entry.text_hash);
                self.sessions.insert(
                    0,
                    CheckSessionEntry {
                        id,
                        ..entry
                    },
                );
            }
            None => {
                let id = self.next_id;
                self.next_id = self.next_id.saturating_add(1);
                self.sessions.insert(
                    0,
                    CheckSessionEntry {
                        id,
                        ..entry
                    },
                );
            }
        }
        if self.sessions.len() > MAX_SESSIONS {
            self.sessions.truncate(MAX_SESSIONS);
        }
        self.persist();
    }
}

/// Tauri managed state：命令内持锁短借
pub struct CheckSessionStore {
    state: Mutex<CheckSessionState>,
}

impl CheckSessionStore {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join(SESSION_FILE);
        if let Err(error) = std::fs::create_dir_all(data_dir) {
            tracing::error!(target: "check", dir = %data_dir.display(), error = %error, "数据目录创建失败（落盘将持续报错）");
        }
        tracing::info!(target: "check", path = %path.display(), "检查会话存储就绪");
        Self {
            state: Mutex::new(CheckSessionState::open(path)),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut CheckSessionState) -> T) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        Ok(f(&mut state))
    }

    /// 从指定路径重读（数据恢复 data_restore 用）
    pub fn reload_from(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        *state = CheckSessionState::open(path);
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<CheckSessionEntry>, String> {
        self.with(|s| s.sessions.clone())
    }

    pub fn upsert(&self, input: CheckSessionInput) -> Result<(), String> {
        self.with(|s| s.upsert(input))
    }

    pub fn clear(&self) -> Result<(), String> {
        self.with(|s| {
            if s.sessions.is_empty() {
                return;
            }
            s.sessions.clear();
            s.persist();
        })
    }
}

// ─────────────────────────── Tauri commands ───────────────────────────

fn broadcast_change(app: &tauri::AppHandle, event: &str) {
    use tauri::Emitter;
    if let Err(error) = app.emit(event, ()) {
        tracing::error!(target: "check", event, error = %error, "{event} 广播失败");
    }
}

#[tauri::command]
pub fn check_terms_get(store: tauri::State<'_, CheckTermsStore>) -> Result<CheckTermsPayload, String> {
    store.payload()
}

#[tauri::command]
pub fn check_terms_save(
    store: tauri::State<'_, CheckTermsStore>,
    app: tauri::AppHandle,
    terms: Vec<TermEntry>,
) -> Result<CheckTermsPayload, String> {
    let payload = store.save_terms(terms)?;
    broadcast_change(&app, "check-terms-changed");
    Ok(payload)
}

#[tauri::command]
pub fn check_whitelist_add(
    store: tauri::State<'_, CheckTermsStore>,
    app: tauri::AppHandle,
    word: String,
) -> Result<Vec<String>, String> {
    let out = store.whitelist_add(&word)?;
    broadcast_change(&app, "check-terms-changed");
    Ok(out)
}

#[tauri::command]
pub fn check_whitelist_remove(
    store: tauri::State<'_, CheckTermsStore>,
    app: tauri::AppHandle,
    word: String,
) -> Result<Vec<String>, String> {
    let out = store.whitelist_remove(&word)?;
    broadcast_change(&app, "check-terms-changed");
    Ok(out)
}

#[tauri::command]
pub fn check_ignored_add(
    store: tauri::State<'_, CheckTermsStore>,
    app: tauri::AppHandle,
    rule_id: String,
    quote: String,
) -> Result<Vec<IgnoredEntry>, String> {
    let out = store.ignored_add(&rule_id, &quote)?;
    broadcast_change(&app, "check-terms-changed");
    Ok(out)
}

#[tauri::command]
pub fn check_ignored_remove(
    store: tauri::State<'_, CheckTermsStore>,
    app: tauri::AppHandle,
    rule_id: String,
    quote: String,
) -> Result<Vec<IgnoredEntry>, String> {
    let out = store.ignored_remove(&rule_id, &quote)?;
    broadcast_change(&app, "check-terms-changed");
    Ok(out)
}

#[tauri::command]
pub fn check_session_save(
    store: tauri::State<'_, CheckSessionStore>,
    app: tauri::AppHandle,
    entry: CheckSessionInput,
) -> Result<(), String> {
    store.upsert(entry)?;
    broadcast_change(&app, "check-session-changed");
    Ok(())
}

#[tauri::command]
pub fn check_session_list(
    store: tauri::State<'_, CheckSessionStore>,
) -> Result<Vec<CheckSessionEntry>, String> {
    store.list()
}

#[tauri::command]
pub fn check_session_clear(
    store: tauri::State<'_, CheckSessionStore>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    store.clear()?;
    broadcast_change(&app, "check-session-changed");
    Ok(())
}

/// 拼写存在性批量探针：words = 前端还原出的候选原形（全小写），
/// 返回与入参对齐的存在标志。无已启用词典时报错——调用方据此跳过拼写层
/// （而不是把所有词都判为未收录）。
#[tauri::command]
pub fn check_spell_lookup(
    registry: tauri::State<'_, crate::dictionary::Registry>,
    words: Vec<String>,
) -> Result<Vec<bool>, String> {
    registry.has_words(&words)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "onedict-check-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn term(id: u64, wrong: &str, right: &str, level: &str) -> TermEntry {
        TermEntry {
            id,
            wrong: wrong.into(),
            right: right.into(),
            note: None,
            level: level.into(),
            enabled: true,
        }
    }

    // ── check-terms ──

    #[test]
    fn terms_save_assigns_ids_and_dedupes() {
        let dir = temp_dir("terms-save");
        let store = CheckTermsStore::open(&dir);
        // id=0 → 服务端分配；同词（忽略大小写）重复保留首条
        let payload = store
            .save_terms(vec![
                term(0, "nodejs", "Node.js", "warning"),
                term(0, "NodeJS", "Node.js", "info"),
                term(0, "数据库", "DB", "info"),
            ])
            .unwrap();
        assert_eq!(payload.terms.len(), 2);
        assert_eq!(payload.terms[0].id, 1);
        assert_eq!(payload.terms[0].level, "warning", "重复条目保留首条");
        assert_eq!(payload.terms[1].id, 2);

        // 二次保存：既有 id 保留（ruleId 引用稳定），新条目续接 id
        let payload = store
            .save_terms(vec![
                term(1, "nodejs", "Node.js", "warning"),
                term(0, "js", "JavaScript", "error"),
            ])
            .unwrap();
        assert_eq!(payload.terms[0].id, 1);
        assert_eq!(payload.terms[1].id, 3);

        // 校验失败整单拒绝，不落盘
        assert!(store.save_terms(vec![term(0, "", "x", "info")]).is_err());
        assert!(store.save_terms(vec![term(0, "a", "b", "fatal")]).is_err());
        assert!(store.save_terms(vec![term(0, "a", "a", "info")]).is_err());
        assert_eq!(store.payload().unwrap().terms.len(), 2);
    }

    #[test]
    fn whitelist_add_dedupes_and_remove_persists() {
        let dir = temp_dir("whitelist");
        let store = CheckTermsStore::open(&dir);
        let out = store.whitelist_add("onedict").unwrap();
        assert_eq!(out, vec!["onedict"]);
        store.whitelist_add("onedict").unwrap();
        store.whitelist_add("  tauri  ").unwrap();
        assert_eq!(
            store.payload().unwrap().whitelist,
            vec!["onedict", "tauri"],
            "重复与首尾空白被归一"
        );
        let out = store.whitelist_remove("tauri").unwrap();
        assert_eq!(out, vec!["onedict"]);
        // 重开后状态延续
        let reopened = CheckTermsStore::open(&dir);
        assert_eq!(reopened.payload().unwrap().whitelist, vec!["onedict"]);
    }

    #[test]
    fn ignored_add_dedupes_and_caps_eviction() {
        let dir = temp_dir("ignored");
        let store = CheckTermsStore::open(&dir);
        store.ignored_add("spell", "recieve").unwrap();
        store.ignored_add("spell", "recieve").unwrap();
        assert_eq!(store.payload().unwrap().ignored.len(), 1, "同键去重");
        for i in 0..(MAX_IGNORED + 10) {
            store.ignored_add("spell", &format!("w{i}")).unwrap();
        }
        let ignored = store.payload().unwrap().ignored;
        assert_eq!(ignored.len(), MAX_IGNORED);
        assert!(
            ignored.iter().any(|e| e.quote == format!("w{}", MAX_IGNORED + 9)),
            "最新的保留"
        );
        assert!(!ignored.iter().any(|e| e.quote == "w0"), "最旧的被淘汰");
        assert!(!ignored.iter().any(|e| e.quote == "recieve"), "更早加入的同样被淘汰");
        store.ignored_remove("spell", "recieve").unwrap();
        assert!(!store.payload().unwrap().ignored.iter().any(|e| e.quote == "recieve"));
    }

    #[test]
    fn terms_corrupt_file_backed_up() {
        let dir = temp_dir("terms-corrupt");
        std::fs::write(dir.join(TERMS_FILE), "{ not json").unwrap();
        let store = CheckTermsStore::open(&dir);
        assert!(store.payload().unwrap().terms.is_empty());
        assert!(dir.join("check-terms.json.corrupt").exists());
    }

    #[test]
    fn terms_persist_roundtrip_camel_case() {
        let dir = temp_dir("terms-roundtrip");
        {
            let store = CheckTermsStore::open(&dir);
            store
                .save_terms(vec![TermEntry {
                    id: 0,
                    wrong: "nodejs".into(),
                    right: "Node.js".into(),
                    note: Some("统一写法".into()),
                    level: "warning".into(),
                    enabled: true,
                }])
                .unwrap();
            store.ignored_add("term:1", "nodejs").unwrap();
        }
        let text = std::fs::read_to_string(dir.join(TERMS_FILE)).unwrap();
        for field in ["\"nextTermId\"", "\"ruleId\"", "\"wrong\"", "\"right\"", "\"enabled\""] {
            assert!(text.contains(field), "缺少字段 {field}");
        }
        let store = CheckTermsStore::open(&dir);
        let payload = store.payload().unwrap();
        assert_eq!(payload.terms.len(), 1);
        assert_eq!(payload.terms[0].note.as_deref(), Some("统一写法"));
        assert_eq!(payload.ignored[0].rule_id, "term:1");
    }

    // ── check-session ──

    fn session_input(hash: &str, preview: &str, total: usize) -> CheckSessionInput {
        CheckSessionInput {
            created_at: 1_000,
            text_hash: hash.into(),
            char_count: 100,
            preview: preview.into(),
            summary: CheckSummary { total, fixable: 1 },
            findings: vec![CheckFindingRecord {
                id: "spell#0".into(),
                rule_id: "spell".into(),
                category: "typo".into(),
                severity: "warning".into(),
                message: "m".into(),
                span: Some(CheckSpan { index: 3, length: 5 }),
                quote: "q".into(),
                prefix: "p".into(),
                suffix: "s".into(),
                anchored: true,
                replacement: None,
                source: "rule".into(),
                fixable: false,
            }],
        }
    }

    #[test]
    fn session_upsert_same_hash_replaces_keeps_id_and_fronts() {
        let dir = temp_dir("session-upsert");
        let store = CheckSessionStore::open(&dir);
        store.upsert(session_input("h1", "甲", 3)).unwrap();
        store.upsert(session_input("h2", "乙", 5)).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].text_hash, "h2", "最近优先");

        // 同 hash 重查：id 复用、字段更新、移到最前
        store.upsert(session_input("h1", "甲'", 7)).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 2, "同 hash 不产生重复会话");
        assert_eq!(list[0].text_hash, "h1");
        assert_eq!(list[0].summary.total, 7);
        assert_eq!(list[0].preview, "甲'");
        assert_eq!(list[0].id, 1, "id 复用（外部引用不失效）");

        // 新 hash 续接 next_id
        store.upsert(session_input("h3", "丙", 1)).unwrap();
        assert_eq!(store.list().unwrap()[0].id, 3);
    }

    #[test]
    fn session_capacity_evicts_oldest() {
        let dir = temp_dir("session-cap");
        let store = CheckSessionStore::open(&dir);
        for i in 0..(MAX_SESSIONS as u64 + 5) {
            store.upsert(session_input(&format!("h{i}"), "p", 1)).unwrap();
        }
        let list = store.list().unwrap();
        assert_eq!(list.len(), MAX_SESSIONS);
        assert_eq!(list[0].text_hash, format!("h{}", MAX_SESSIONS as u64 + 4));
        assert!(!list.iter().any(|s| s.text_hash == "h0"));
    }

    #[test]
    fn session_truncates_findings_and_fields() {
        let dir = temp_dir("session-trunc");
        let store = CheckSessionStore::open(&dir);
        let mut input = session_input("h1", "p", 1);
        input.findings = (0..MAX_FINDINGS_PER_SESSION + 50)
            .map(|i| CheckFindingRecord {
                id: format!("spell#{i}"),
                rule_id: "spell".into(),
                category: "typo".into(),
                severity: "warning".into(),
                message: "m".into(),
                span: None,
                quote: "q".into(),
                prefix: String::new(),
                suffix: String::new(),
                anchored: true,
                replacement: None,
                source: "rule".into(),
                fixable: false,
            })
            .collect();
        input.preview = "x".repeat(500);
        store.upsert(input).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list[0].findings.len(), MAX_FINDINGS_PER_SESSION);
        assert_eq!(list[0].preview.chars().count(), 64);
    }

    #[test]
    fn session_clear_and_corrupt_backup() {
        let dir = temp_dir("session-clear");
        let store = CheckSessionStore::open(&dir);
        store.upsert(session_input("h1", "甲", 1)).unwrap();
        store.clear().unwrap();
        assert!(store.list().unwrap().is_empty());

        std::fs::write(dir.join(SESSION_FILE), "not json at all").unwrap();
        let store2 = CheckSessionStore::open(&dir);
        assert!(store2.list().unwrap().is_empty());
        assert!(dir.join("check-session.json.corrupt").exists());
    }

    #[test]
    fn session_persist_roundtrip_camel_case() {
        let dir = temp_dir("session-roundtrip");
        {
            let store = CheckSessionStore::open(&dir);
            store.upsert(session_input("h1", "甲", 3)).unwrap();
        }
        let text = std::fs::read_to_string(dir.join(SESSION_FILE)).unwrap();
        for field in [
            "\"textHash\"",
            "\"charCount\"",
            "\"createdAt\"",
            "\"ruleId\"",
            "\"span\"",
        ] {
            assert!(text.contains(field), "缺少字段 {field}");
        }
        let store = CheckSessionStore::open(&dir);
        let list = store.list().unwrap();
        assert_eq!(list[0].findings[0].rule_id, "spell");
        assert_eq!(list[0].findings[0].span, Some(CheckSpan { index: 3, length: 5 }));
    }
}
