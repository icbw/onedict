//! 查词历史持久化：
//!   history_list   全量条目（最近优先；200 条上限内全量拉取，renderer 渲染 chips）
//!   history_add    记录一次查询：同词头（归一化）幂等 → count+1 + lastAt 更新 + 提到最前；
//!                  新词头插最前；超容量淘汰最旧
//!   history_clear  清空
//!
//! 存储 = app_data_dir()/history.json 单文件（version=1；损坏改名 .corrupt 留档后空载，
//! 语义对齐 vocabulary/prefs）。normKey 复用生词本归一化（trim + 空白折叠 + 小写）。
//!
//! 记录边界：只记**显式查询**——主窗口 Enter 提交与「引用」动作
//! （DictionaryTab commit 路径）；词条 entry:// 内链跳词不记（浏览行为非查询意图）；
//! 划词面板查询暂不记（划词即记的噪声权衡留待，接入只需一行 invoke）。
//!
//! 子模块 `translate`：翻译历史（同款存储/广播语义，无去重带自增 id）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

// 翻译历史命令经 `history::translate::` 路径注册（#[tauri::command] 生成的隐藏宏
// 与函数同路径解析，子模块路径直引即可，无需 re-export）
pub mod translate;

const FILE_VERSION: u32 = 1;
/// 容量上限：超过淘汰最旧（存储顺序 = 最近优先，淘汰尾部）
const MAX_ENTRIES: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// 用户原样查询的词头（仅 trim/空白归一化）
    pub word: String,
    /// 查重键：trim + 空白折叠 + 小写
    pub norm_key: String,
    /// 累计查询次数
    pub count: u64,
    /// 最近查询时间（ms epoch）
    pub last_at: i64,
}

#[derive(Serialize, Deserialize)]
struct HistoryFile {
    version: u32,
    entries: Vec<HistoryEntry>,
}

/// 与 vocabulary::normalize_word 同语义（JS `word.trim().replace(/\s+/g, ' ')` 等价）
fn normalize_word(word: &str) -> String {
    word.trim().split_whitespace().collect::<Vec<_>>().join(" ")
}

struct HistoryState {
    entries: Vec<HistoryEntry>,
    path: PathBuf,
}

impl HistoryState {
    fn open(path: PathBuf) -> Self {
        let mut state = Self {
            entries: Vec::new(),
            path,
        };
        state.load();
        state
    }

    /// 对齐 vocabulary load()：不存在 → 空；version+entries 形状不符 → warn 空载；
    /// 解析失败 → 改名 .corrupt 留档后空载
    fn load(&mut self) {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return; // 不存在（或不可读）→ 空载
        };
        match serde_json::from_str::<HistoryFile>(&text) {
            Ok(file) if file.version == FILE_VERSION => {
                self.entries = file.entries;
            }
            Ok(file) => {
                tracing::warn!(target: "history", version = file.version, "history.json 形状不符，按空载处理（下次落盘将覆盖）");
            }
            Err(error) => {
                let backup = self.path.with_extension("json.corrupt");
                match std::fs::rename(&self.path, &backup) {
                    Ok(()) => {
                        tracing::error!(target: "history", backup = %backup.display(), error = %error, "history.json 解析失败，已改名留档并空载");
                    }
                    Err(rename_error) => {
                        tracing::error!(target: "history", error = %rename_error, "history.json 解析失败且留档失败，按空载处理");
                    }
                }
            }
        }
    }

    /// 整文件落盘（每次变更全量写，vocabulary 同语义）
    fn persist(&self) {
        let file = HistoryFile {
            version: FILE_VERSION,
            entries: self.entries.clone(),
        };
        let text = match serde_json::to_string_pretty(&file) {
            Ok(t) => t,
            Err(error) => {
                tracing::error!(target: "history", error = %error, "history.json 序列化失败");
                return;
            }
        };
        if let Err(error) = crate::fsutil::write_atomic(&self.path, &text) {
            tracing::error!(target: "history", error = %error, "history.json 落盘失败");
        }
    }

    /// 记录一次查询：同 normKey 幂等更新（count+1 + 提最前）；新词头插最前；
    /// 超容量淘汰最旧。空词静默忽略（调用方已 trim，防御）。
    fn add(&mut self, raw_word: &str, now: i64) {
        let word = normalize_word(raw_word);
        if word.is_empty() {
            return;
        }
        let key = word.to_lowercase();
        if let Some(pos) = self.entries.iter().position(|e| e.norm_key == key) {
            let mut entry = self.entries.remove(pos);
            entry.count = entry.count.saturating_add(1);
            entry.last_at = now;
            self.entries.insert(0, entry);
        } else {
            self.entries.insert(
                0,
                HistoryEntry {
                    word,
                    norm_key: key,
                    count: 1,
                    last_at: now,
                },
            );
            self.entries.truncate(MAX_ENTRIES);
        }
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
pub struct HistoryStore {
    state: Mutex<HistoryState>,
}

impl HistoryStore {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("history.json");
        if let Err(error) = std::fs::create_dir_all(data_dir) {
            tracing::error!(target: "history", dir = %data_dir.display(), error = %error, "数据目录创建失败（落盘将持续报错）");
        }
        tracing::info!(target: "history", path = %path.display(), "查词历史存储就绪");
        Self {
            state: Mutex::new(HistoryState::open(path)),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut HistoryState) -> T) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        Ok(f(&mut state))
    }

    /// 从指定路径重读（数据恢复 data_restore 用）
    pub fn reload_from(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        *state = HistoryState::open(path);
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<HistoryEntry>, String> {
        self.with(|s| s.entries.clone())
    }

    pub fn add(&self, word: &str, now: i64) -> Result<(), String> {
        self.with(|s| s.add(word, now))
    }

    pub fn clear(&self) -> Result<(), String> {
        self.with(|s| s.clear())
    }

    /// 删除单条：原样词头归一化取查重键（与 add 同键路径）。返回是否删除。
    pub fn remove(&self, word: &str) -> Result<bool, String> {
        let key = normalize_word(word).to_lowercase();
        if key.is_empty() {
            return Ok(false);
        }
        self.with(|s| {
            let len_before = s.entries.len();
            s.entries.retain(|e| e.norm_key != key);
            let removed = s.entries.len() != len_before;
            if removed {
                s.persist();
            }
            removed
        })
    }
}

// ── Tauri commands ──

#[tauri::command]
pub fn history_list(store: tauri::State<'_, HistoryStore>) -> Result<Vec<HistoryEntry>, String> {
    store.list()
}

#[tauri::command]
pub fn history_add(
    store: tauri::State<'_, HistoryStore>,
    app: tauri::AppHandle,
    word: String,
) -> Result<(), String> {
    let now = now_ms();
    store.add(&word, now)?;
    broadcast_change(&app);
    Ok(())
}

#[tauri::command]
pub fn history_clear(
    store: tauri::State<'_, HistoryStore>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    store.clear()?;
    broadcast_change(&app);
    Ok(())
}

/// 删除单条（查词历史独立页）：仅命中时广播（未命中免无谓刷新）
#[tauri::command]
pub fn history_remove(
    store: tauri::State<'_, HistoryStore>,
    app: tauri::AppHandle,
    word: String,
) -> Result<bool, String> {
    let removed = store.remove(&word)?;
    if removed {
        broadcast_change(&app);
    }
    Ok(removed)
}

/// 任何变更后广播（vocabulary 同语义；发起窗口也收到，重拉幂等无害——统一从
/// 广播驱动 state，避免双写路径）
fn broadcast_change(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Err(error) = app.emit("history-changed", ()) {
        tracing::error!(target: "history", error = %error, "history-changed 广播失败");
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
            "onedict-history-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn add_is_idempotent_bumps_count_and_moves_front() {
        let dir = temp_dir("add");
        let store = HistoryStore::open(&dir);

        store.add("Hello", 1_000).unwrap();
        store.add("world", 2_000).unwrap();
        // 空白/大小写归一化命中同条目：count+1、lastAt 更新、提到最前
        store.add("  hello  ", 3_000).unwrap();

        let list = store.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].word, "Hello");
        assert_eq!(list[0].count, 2);
        assert_eq!(list[0].last_at, 3_000);
        assert_eq!(list[1].word, "world");

        // 空词静默忽略
        store.add("   ", 4_000).unwrap();
        assert_eq!(store.list().unwrap().len(), 2);
    }

    #[test]
    fn capacity_evicts_oldest() {
        let dir = temp_dir("cap");
        let store = HistoryStore::open(&dir);
        for i in 0..(MAX_ENTRIES as i64 + 10) {
            store.add(&format!("w{i}"), i).unwrap();
        }
        let list = store.list().unwrap();
        assert_eq!(list.len(), MAX_ENTRIES);
        // 最旧的 w0..w9 被淘汰；最前 = 最新
        assert_eq!(list[0].word, format!("w{}", MAX_ENTRIES as i64 + 9));
        assert!(!list.iter().any(|e| e.word == "w0"));
    }

    #[test]
    fn clear_empties_and_persists() {
        let dir = temp_dir("clear");
        let store = HistoryStore::open(&dir);
        store.add("a", 1).unwrap();
        store.clear().unwrap();
        assert!(store.list().unwrap().is_empty());

        // 落盘语义：重开（模拟重启）仍为空
        let reopened = HistoryStore::open(&dir);
        assert!(reopened.list().unwrap().is_empty());
    }

    #[test]
    fn remove_deletes_only_target_and_persists() {
        let dir = temp_dir("remove");
        {
            let store = HistoryStore::open(&dir);
            store.add("alpha", 1).unwrap();
            store.add("beta", 2).unwrap();
            // 归一化命中（大小写/空白），只删目标
            assert!(store.remove("  BETA ").unwrap());
            // 已删后再删 = false（不广播依赖命令层判断）
            assert!(!store.remove("beta").unwrap());
            let list = store.list().unwrap();
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].word, "alpha");
        }
        // 落盘语义：重开（模拟重启）仍删除
        let reopened = HistoryStore::open(&dir);
        let list = reopened.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].word, "alpha");
    }

    #[test]
    fn corrupt_file_is_backed_up_as_corrupt() {
        let dir = temp_dir("corrupt");
        let path = dir.join("history.json");
        std::fs::write(&path, "{ not json").unwrap();

        let _store = HistoryStore::open(&dir);
        assert!(!path.exists(), "损坏文件应被改名");
        assert!(dir.join("history.json.corrupt").exists());
    }

    #[test]
    fn persist_roundtrip_keeps_schema_shape() {
        let dir = temp_dir("roundtrip");
        {
            let store = HistoryStore::open(&dir);
            store.add("días", 1_000).unwrap();
            store.add("días", 2_000).unwrap();
        }
        let store = HistoryStore::open(&dir);
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].word, "días");
        assert_eq!(list[0].count, 2);

        // JSON 文本字段名（camelCase）与 version
        let text = std::fs::read_to_string(dir.join("history.json")).unwrap();
        for field in ["\"normKey\"", "\"lastAt\"", "\"count\""] {
            assert!(text.contains(field), "缺少字段 {field}");
        }
        assert!(text.contains("\"version\": 1"));
    }
}
