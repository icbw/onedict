//! 翻译历史持久化：对齐查词历史 history 模块同款
//! 语义——app_data_dir()/translate-history.json 单文件（version=1，损坏 .corrupt
//! 留档空载）、200 条上限淘汰最旧、变更即整文件落盘 + 广播。
//!
//! 与查词历史的差异：不做归一化去重——每次**成功完成**的翻译都是一条记录
//! （cherry 翻译历史同语义：翻译是「事件」而非「词条」），带自增 id 供前端
//! 列表 key 与回填定位。命令：
//!   translate_history_list    全量条目（最近优先）
//!   translate_history_add     记录一次翻译（空原文/空译文静默忽略）
//!   translate_history_clear   清空
//! 广播事件 `translate-history-changed`（发起窗口也收，统一由广播驱动 state）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const FILE_VERSION: u32 = 1;
/// 容量上限：超过淘汰最旧（存储顺序 = 最近优先，淘汰尾部）
const MAX_ENTRIES: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranslateHistoryEntry {
    /// 自增 id（持久化计数器；前端列表 key / 回填定位）
    pub id: u64,
    /// 原文（用户输入原文，仅 trim）
    pub source_text: String,
    /// 译文（流式完成后的完整输出）
    pub target_text: String,
    /// 源语言代码；None = 自动检测（当前翻译页固定自动检测）
    pub source_lang: Option<String>,
    /// 目标语言代码（如 zh-cn）
    pub target_lang: String,
    /// 创建时间（ms epoch）
    pub created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateHistoryFile {
    version: u32,
    next_id: u64,
    entries: Vec<TranslateHistoryEntry>,
}

struct TranslateHistoryState {
    entries: Vec<TranslateHistoryEntry>,
    next_id: u64,
    path: PathBuf,
}

impl TranslateHistoryState {
    fn open(path: PathBuf) -> Self {
        let mut state = Self {
            entries: Vec::new(),
            next_id: 1,
            path,
        };
        state.load();
        state
    }

    /// 对齐 history::HistoryState::load：不存在 → 空；version/形状不符 → warn 空载；
    /// 解析失败 → 改名 .corrupt 留档后空载
    fn load(&mut self) {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return; // 不存在（或不可读）→ 空载
        };
        match serde_json::from_str::<TranslateHistoryFile>(&text) {
            Ok(file) if file.version == FILE_VERSION => {
                self.entries = file.entries;
                self.next_id = file.next_id.max(1);
            }
            Ok(file) => {
                tracing::warn!(target: "history", version = file.version, "translate-history.json 形状不符，按空载处理（下次落盘将覆盖）");
            }
            Err(error) => {
                let backup = self.path.with_extension("json.corrupt");
                match std::fs::rename(&self.path, &backup) {
                    Ok(()) => {
                        tracing::error!(target: "history", backup = %backup.display(), error = %error, "translate-history.json 解析失败，已改名留档并空载");
                    }
                    Err(rename_error) => {
                        tracing::error!(target: "history", error = %rename_error, "translate-history.json 解析失败且留档失败，按空载处理");
                    }
                }
            }
        }
    }

    fn persist(&self) {
        let file = TranslateHistoryFile {
            version: FILE_VERSION,
            next_id: self.next_id,
            entries: self.entries.clone(),
        };
        let text = match serde_json::to_string_pretty(&file) {
            Ok(t) => t,
            Err(error) => {
                tracing::error!(target: "history", error = %error, "translate-history.json 序列化失败");
                return;
            }
        };
        if let Err(error) = crate::fsutil::write_atomic(&self.path, &text) {
            tracing::error!(target: "history", error = %error, "translate-history.json 落盘失败");
        }
    }

    /// 记录一次翻译：插最前；超容量淘汰最旧。空原文/空译文静默忽略
    /// （调用方已 trim，防御——半途停止/空输出的翻译不入历史）。
    fn add(
        &mut self,
        source_text: &str,
        target_text: &str,
        source_lang: Option<String>,
        target_lang: &str,
        now: i64,
    ) {
        let source_text = source_text.trim();
        let target_text = target_text.trim();
        if source_text.is_empty() || target_text.is_empty() {
            return;
        }
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.entries.insert(
            0,
            TranslateHistoryEntry {
                id,
                source_text: source_text.to_string(),
                target_text: target_text.to_string(),
                source_lang,
                target_lang: target_lang.to_string(),
                created_at: now,
            },
        );
        self.entries.truncate(MAX_ENTRIES);
        self.persist();
    }

    fn clear(&mut self) {
        if self.entries.is_empty() {
            return;
        }
        self.entries.clear();
        self.persist();
    }
}

/// Tauri managed state：命令内持锁短借（全内存操作 + 变更即整文件落盘）
pub struct TranslateHistoryStore {
    state: Mutex<TranslateHistoryState>,
}

impl TranslateHistoryStore {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("translate-history.json");
        if let Err(error) = std::fs::create_dir_all(data_dir) {
            tracing::error!(target: "history", dir = %data_dir.display(), error = %error, "数据目录创建失败（落盘将持续报错）");
        }
        tracing::info!(target: "history", path = %path.display(), "翻译历史存储就绪");
        Self {
            state: Mutex::new(TranslateHistoryState::open(path)),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut TranslateHistoryState) -> T) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        Ok(f(&mut state))
    }

    /// 从指定路径重读（数据恢复 data_restore 用）
    pub fn reload_from(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        *state = TranslateHistoryState::open(path);
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<TranslateHistoryEntry>, String> {
        self.with(|s| s.entries.clone())
    }

    pub fn add(
        &self,
        source_text: &str,
        target_text: &str,
        source_lang: Option<String>,
        target_lang: &str,
        now: i64,
    ) -> Result<(), String> {
        self.with(|s| s.add(source_text, target_text, source_lang, target_lang, now))
    }

    pub fn clear(&self) -> Result<(), String> {
        self.with(|s| s.clear())
    }
}

// ── Tauri commands ──

#[tauri::command]
pub fn translate_history_list(
    store: tauri::State<'_, TranslateHistoryStore>,
) -> Result<Vec<TranslateHistoryEntry>, String> {
    store.list()
}

#[tauri::command]
pub fn translate_history_add(
    store: tauri::State<'_, TranslateHistoryStore>,
    app: tauri::AppHandle,
    source_text: String,
    target_text: String,
    source_lang: Option<String>,
    target_lang: String,
) -> Result<(), String> {
    let now = now_ms();
    store.add(&source_text, &target_text, source_lang, &target_lang, now)?;
    broadcast_change(&app);
    Ok(())
}

#[tauri::command]
pub fn translate_history_clear(
    store: tauri::State<'_, TranslateHistoryStore>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    store.clear()?;
    broadcast_change(&app);
    Ok(())
}

/// 任何变更后广播（查词历史 history-changed 同语义；发起窗口也收，重拉幂等无害）
fn broadcast_change(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Err(error) = app.emit("translate-history-changed", ()) {
        tracing::error!(target: "history", error = %error, "translate-history-changed 广播失败");
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "onedict-translate-history-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn add(store: &TranslateHistoryStore, src: &str, dst: &str, at: i64) {
        store.add(src, dst, None, "zh-cn", at).unwrap();
    }

    #[test]
    fn add_assigns_increasing_ids_and_prepends() {
        let dir = temp_dir("add");
        let store = TranslateHistoryStore::open(&dir);
        add(&store, "hello", "你好", 1_000);
        add(&store, "world", "世界", 2_000);

        let list = store.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, 2, "最新在前");
        assert_eq!(list[0].source_text, "world");
        assert_eq!(list[1].id, 1);
        assert_eq!(list[1].source_lang, None);
        assert_eq!(list[1].target_lang, "zh-cn");

        // 空原文/空译文静默忽略
        add(&store, "   ", "x", 3_000);
        add(&store, "x", "  ", 3_000);
        assert_eq!(store.list().unwrap().len(), 2);
    }

    #[test]
    fn capacity_evicts_oldest() {
        let dir = temp_dir("cap");
        let store = TranslateHistoryStore::open(&dir);
        for i in 0..(MAX_ENTRIES as i64 + 10) {
            add(&store, &format!("s{i}"), &format!("t{i}"), i);
        }
        let list = store.list().unwrap();
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list[0].source_text, format!("s{}", MAX_ENTRIES as i64 + 9));
        assert!(!list.iter().any(|e| e.source_text == "s0"));
    }

    #[test]
    fn clear_empties_and_persists() {
        let dir = temp_dir("clear");
        let store = TranslateHistoryStore::open(&dir);
        add(&store, "a", "甲", 1);
        store.clear().unwrap();
        assert!(store.list().unwrap().is_empty());
        let reopened = TranslateHistoryStore::open(&dir);
        assert!(reopened.list().unwrap().is_empty());
    }

    #[test]
    fn corrupt_file_is_backed_up_as_corrupt() {
        let dir = temp_dir("corrupt");
        let path = dir.join("translate-history.json");
        std::fs::write(&path, "{ not json").unwrap();
        let _store = TranslateHistoryStore::open(&dir);
        assert!(!path.exists(), "损坏文件应被改名");
        assert!(dir.join("translate-history.json.corrupt").exists());
    }

    #[test]
    fn persist_roundtrip_keeps_schema_shape_and_ids() {
        let dir = temp_dir("roundtrip");
        {
            let store = TranslateHistoryStore::open(&dir);
            add(&store, "días", "日子", 1_000);
            add(&store, "hello", "你好", 2_000);
        }
        let store = TranslateHistoryStore::open(&dir);
        let list = store.list().unwrap();
        assert_eq!(list.len(), 2);
        // 重开后自增 id 续接（不回落复用）
        add(&store, "new", "新", 3_000);
        let list = store.list().unwrap();
        assert_eq!(list[0].id, 3);

        let text = std::fs::read_to_string(dir.join("translate-history.json")).unwrap();
        for field in ["\"sourceText\"", "\"targetText\"", "\"targetLang\"", "\"createdAt\"", "\"nextId\""] {
            assert!(text.contains(field), "缺少字段 {field}");
        }
        assert!(text.contains("\"version\": 1"));
    }
}
