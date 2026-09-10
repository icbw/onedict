//! 生词卡存储（pickdict VocabularyService 的 Rust 移植，语义逐条对齐：
//!   vocabulary_list    全量条目（JSON 存储规模 <1 万条，全量拉取 + renderer 侧过滤排序）
//!   vocabulary_has     查重（normKey 归一化匹配）
//!   vocabulary_add     幂等添加：同 normKey 已存在时返回已有条目（created=false）
//!   vocabulary_remove  删除（id 不存在时静默，无错误）
//!   vocabulary_review  提交复习调度结果（reviewCount+1 后合并写盘）
//!
//! 存储 = app_data_dir()/vocabulary.json 单文件（schema 扁平、字段名与 pickdict 逐字段
//! 一致，version=1，两作数据文件可互迁；量大再评估 rusqlite）。
//!
//! 架构差异：pickdict 在主进程内算 SM-2；onedict 调度纯函数留
//! 前端 src/services/sm2.ts（node test/sm2.mjs 断言），vocabulary_review 只接收前端
//! applySm2 的结果做持久化——算法单一事实源不落两处。
//!
//! load 损坏语义对齐 pickdict：JSON 解析失败 → 原文件改名 .corrupt 留档后空载
//! （避免首次落盘静默覆盖原始数据）；version 不符 → warn 后空载。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const FILE_VERSION: u32 = 1;

/// 内置收词箱单元 id（不落盘，前端固定渲染；查词页加词的落点）
pub const INBOX_UNIT_ID: &str = "inbox";

fn default_unit_id() -> String {
    INBOX_UNIT_ID.to_string()
}

/// 与 pickdict IPC schema / vocabulary.json 逐字段一致（camelCase）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyEntry {
    pub id: String,
    /// 用户原样添加的词头（仅 trim/空白归一化）
    pub word: String,
    /// 查重键：小写归一化（可迁 SQLite 唯一索引）
    pub norm_key: String,
    pub note: String,
    /// 所属单元（v1 旧文件缺省 → 收词箱；serde default 保持与 pickdict 互迁）
    #[serde(default = "default_unit_id")]
    pub unit_id: String,
    pub added_at: i64,
    /// SM-2 状态
    pub ease_factor: f64,
    pub interval_days: f64,
    pub repetitions: i64,
    pub due_at: i64,
    pub last_reviewed_at: Option<i64>,
    pub review_count: i64,
    pub lapses: i64,
}

/// 学习单元（生词本分组；收词箱为保留 id 不入此列表）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyUnit {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize)]
struct VocabularyFile {
    version: u32,
    entries: Vec<VocabularyEntry>,
    /// v1 旧文件缺省 → 空列表（serde default，保持 schema 向后兼容）
    #[serde(default)]
    units: Vec<VocabularyUnit>,
}

/// vocabulary_review 的输入：前端 applySm2 的调度结果（不含 reviewCount，Rust 侧自增）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleUpdate {
    pub ease_factor: f64,
    pub interval_days: f64,
    pub repetitions: i64,
    pub lapses: i64,
    pub due_at: i64,
    pub last_reviewed_at: Option<i64>,
    /// 复习评分（学习统计：vocabulary_review 记入 review-log.json；
    /// serde default——旧调用/测试不传 = None 不记）
    #[serde(default)]
    pub grade: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub entry: VocabularyEntry,
    pub created: bool,
}

/// JS `word.trim().replace(/\s+/g, ' ')` 等价实现（trim + 空白序列折叠为单空格）。
/// JS \s 与 Rust is_whitespace 在 \u{feff} 等个别码点上有差，词头场景无实际影响。
fn normalize_word(word: &str) -> String {
    word.trim().split_whitespace().collect::<Vec<_>>().join(" ")
}

struct VocabState {
    entries: Vec<VocabularyEntry>,
    units: Vec<VocabularyUnit>,
    path: PathBuf,
}

impl VocabState {
    fn open(path: PathBuf) -> Self {
        let mut state = Self {
            entries: Vec::new(),
            units: Vec::new(),
            path,
        };
        state.load();
        state
    }

    /// 对齐 pickdict load()：不存在 → 空；version+entries 形状不符 → warn 空载；
    /// 解析失败 → 改名 .corrupt 留档后空载
    fn load(&mut self) {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return; // 不存在（或不可读）→ 空载
        };
        match serde_json::from_str::<VocabularyFile>(&text) {
            Ok(file) if file.version == FILE_VERSION => {
                self.entries = file.entries;
                self.units = file.units;
            }
            Ok(file) => {
                tracing::warn!(target: "vocabulary", version = file.version, "vocabulary.json 形状不符，按空载处理（下次落盘将覆盖）");
            }
            Err(error) => {
                let backup = self.path.with_extension("json.corrupt");
                match std::fs::rename(&self.path, &backup) {
                    Ok(()) => {
                        tracing::error!(target: "vocabulary", backup = %backup.display(), error = %error, "vocabulary.json 解析失败，已改名留档并空载");
                    }
                    Err(rename_error) => {
                        tracing::error!(target: "vocabulary", error = %rename_error, "vocabulary.json 解析失败且留档失败，按空载处理");
                    }
                }
            }
        }
    }

    /// 整文件落盘（pickdict writeFileSync 语义：每次变更全量写；原子写）
    fn persist(&self) {
        let file = VocabularyFile {
            version: FILE_VERSION,
            entries: self.entries.clone(),
            units: self.units.clone(),
        };
        let text = match serde_json::to_string_pretty(&file) {
            Ok(t) => t,
            Err(error) => {
                tracing::error!(target: "vocabulary", error = %error, "vocabulary.json 序列化失败");
                return;
            }
        };
        if let Err(error) = crate::fsutil::write_atomic(&self.path, &text) {
            tracing::error!(target: "vocabulary", error = %error, "vocabulary.json 落盘失败");
        }
    }

    fn has(&self, word: &str) -> bool {
        let key = normalize_word(word).to_lowercase();
        self.entries.iter().any(|e| e.norm_key == key)
    }

    /// 幂等添加：同 normKey 已存在 → 返回已有条目 created=false；空词报错
    fn add(&mut self, raw_word: &str, now: i64) -> Result<(VocabularyEntry, bool), String> {
        let word = normalize_word(raw_word);
        if word.is_empty() {
            return Err("empty word".into());
        }
        let key = word.to_lowercase();
        if let Some(existing) = self.entries.iter().find(|e| e.norm_key == key) {
            return Ok((existing.clone(), false));
        }
        let entry = VocabularyEntry {
            id: uuid::Uuid::new_v4().to_string(),
            word,
            norm_key: key,
            note: String::new(),
            unit_id: INBOX_UNIT_ID.to_string(),
            added_at: now,
            ease_factor: 2.5,
            interval_days: 0.0,
            repetitions: 0,
            due_at: now,
            last_reviewed_at: None,
            review_count: 0,
            lapses: 0,
        };
        self.entries.push(entry.clone());
        self.persist();
        Ok((entry, true))
    }

    /// id 不存在 → 静默返回 false（pickdict remove 语义）
    fn remove(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        let removed = self.entries.len() != before;
        if removed {
            self.persist();
        }
        removed
    }

    /// 新建单元（名称 trim 后非空；重名允许——分组语义非唯一键）
    fn unit_create(&mut self, raw_name: &str, now: i64) -> Result<VocabularyUnit, String> {
        let name = raw_name.trim();
        if name.is_empty() {
            return Err("empty unit name".into());
        }
        let unit = VocabularyUnit {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            created_at: now,
        };
        self.units.push(unit.clone());
        self.persist();
        Ok(unit)
    }

    /// 重命名（收词箱保留 id 报错；空名报错）
    fn unit_rename(&mut self, id: &str, raw_name: &str) -> Result<(), String> {
        if id == INBOX_UNIT_ID {
            return Err("cannot rename inbox".into());
        }
        let name = raw_name.trim();
        if name.is_empty() {
            return Err("empty unit name".into());
        }
        let unit = self
            .units
            .iter_mut()
            .find(|u| u.id == id)
            .ok_or_else(|| format!("unit not found: {id}"))?;
        unit.name = name.to_string();
        self.persist();
        Ok(())
    }

    /// 删除单元：其词条自动回收进收词箱（词不丢）；收词箱保留 id 报错
    fn unit_remove(&mut self, id: &str) -> Result<bool, String> {
        if id == INBOX_UNIT_ID {
            return Err("cannot remove inbox".into());
        }
        let before = self.units.len();
        self.units.retain(|u| u.id != id);
        let removed = self.units.len() != before;
        if removed {
            for entry in self.entries.iter_mut().filter(|e| e.unit_id == id) {
                entry.unit_id = INBOX_UNIT_ID.to_string();
            }
            self.persist();
        }
        Ok(removed)
    }

    /// 移动词条到单元（目标须为收词箱或已存在单元；词条不存在报错）
    fn move_entry(&mut self, entry_id: &str, unit_id: &str) -> Result<(), String> {
        if unit_id != INBOX_UNIT_ID && !self.units.iter().any(|u| u.id == unit_id) {
            return Err(format!("unit not found: {unit_id}"));
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|e| e.id == entry_id)
            .ok_or_else(|| format!("vocabulary entry not found: {entry_id}"))?;
        if entry.unit_id != unit_id {
            entry.unit_id = unit_id.to_string();
            self.persist();
        }
        Ok(())
    }

    /// 合并前端调度结果 + reviewCount+1（pickdict review 语义；id 不存在报错）
    fn review(&mut self, id: &str, next: &ScheduleUpdate) -> Result<VocabularyEntry, String> {
        let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) else {
            return Err(format!("vocabulary entry not found: {id}"));
        };
        entry.ease_factor = next.ease_factor;
        entry.interval_days = next.interval_days;
        entry.repetitions = next.repetitions;
        entry.lapses = next.lapses;
        entry.due_at = next.due_at;
        entry.last_reviewed_at = next.last_reviewed_at;
        entry.review_count += 1;
        let updated = entry.clone();
        self.persist();
        Ok(updated)
    }
}

/// Tauri managed state：命令内持锁短借（全内存操作 + 变更即整文件落盘）
pub struct VocabularyStore {
    state: Mutex<VocabState>,
}

impl VocabularyStore {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("vocabulary.json");
        if let Err(error) = std::fs::create_dir_all(data_dir) {
            tracing::error!(target: "vocabulary", dir = %data_dir.display(), error = %error, "数据目录创建失败（落盘将持续报错）");
        }
        tracing::info!(target: "vocabulary", path = %path.display(), "生词卡存储就绪");
        Self {
            state: Mutex::new(VocabState::open(path)),
        }
    }

    /// 从指定路径重读（数据恢复 data_restore 用）：整 state 替换，
    /// 后续变更落盘到该路径
    pub fn reload_from(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        *state = VocabState::open(path);
        Ok(())
    }

    fn with<T>(&self, f: impl FnOnce(&mut VocabState) -> T) -> Result<T, String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        Ok(f(&mut state))
    }

    pub fn list(&self) -> Result<Vec<VocabularyEntry>, String> {
        self.with(|s| s.entries.clone())
    }

    /// 条目 + 单元一并取出（Anki CSV 导出用：单元名映射）
    pub fn entries_and_units(
        &self,
    ) -> Result<(Vec<VocabularyEntry>, Vec<VocabularyUnit>), String> {
        self.with(|s| (s.entries.clone(), s.units.clone()))
    }

    pub fn has(&self, word: &str) -> Result<bool, String> {
        self.with(|s| s.has(word))
    }

    pub fn add(&self, word: &str, now: i64) -> Result<AddResult, String> {
        self.with(|s| {
            let (entry, created) = s.add(word, now)?;
            Ok(AddResult { entry, created })
        })?
    }

    pub fn remove(&self, id: &str) -> Result<bool, String> {
        self.with(|s| s.remove(id))
    }

    pub fn review(&self, id: &str, next: &ScheduleUpdate) -> Result<VocabularyEntry, String> {
        self.with(|s| s.review(id, next))?
    }

    pub fn units(&self) -> Result<Vec<VocabularyUnit>, String> {
        self.with(|s| s.units.clone())
    }

    pub fn unit_create(&self, name: &str, now: i64) -> Result<VocabularyUnit, String> {
        self.with(|s| s.unit_create(name, now))?
    }

    pub fn unit_rename(&self, id: &str, name: &str) -> Result<(), String> {
        self.with(|s| s.unit_rename(id, name))?
    }

    pub fn unit_remove(&self, id: &str) -> Result<bool, String> {
        self.with(|s| s.unit_remove(id))?
    }

    pub fn move_entry(&self, entry_id: &str, unit_id: &str) -> Result<(), String> {
        self.with(|s| s.move_entry(entry_id, unit_id))?
    }
}

// ── Tauri commands ──

#[tauri::command]
pub fn vocabulary_list(store: tauri::State<'_, VocabularyStore>) -> Result<Vec<VocabularyEntry>, String> {
    store.list()
}

#[tauri::command]
pub fn vocabulary_has(store: tauri::State<'_, VocabularyStore>, word: String) -> Result<bool, String> {
    store.has(&word)
}

#[tauri::command]
pub fn vocabulary_add(
    store: tauri::State<'_, VocabularyStore>,
    app: tauri::AppHandle,
    word: String,
) -> Result<AddResult, String> {
    let result = store.add(&word, now_ms())?;
    broadcast_change(&app);
    Ok(result)
}

#[tauri::command]
pub fn vocabulary_remove(
    store: tauri::State<'_, VocabularyStore>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    let removed = store.remove(&id)?;
    if removed {
        broadcast_change(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn vocabulary_review(
    store: tauri::State<'_, VocabularyStore>,
    log: tauri::State<'_, crate::reviewlog::ReviewLogStore>,
    app: tauri::AppHandle,
    id: String,
    next: ScheduleUpdate,
) -> Result<VocabularyEntry, String> {
    let updated = store.review(&id, &next)?;
    // 学习统计：复习即记录按天计数；失败不影响复习本身
    if let Some(grade) = next.grade.as_deref() {
        log.record(grade, &crate::reviewlog::today_key());
    }
    broadcast_change(&app);
    Ok(updated)
}

/// 学习统计：复习日志全量（按天聚合；前端自取最近 N 天切片）
#[tauri::command]
pub fn vocabulary_review_log(
    log: tauri::State<'_, crate::reviewlog::ReviewLogStore>,
) -> Result<std::collections::BTreeMap<String, crate::reviewlog::DayCount>, String> {
    log.snapshot()
}

#[tauri::command]
pub fn vocabulary_unit_list(store: tauri::State<'_, VocabularyStore>) -> Result<Vec<VocabularyUnit>, String> {
    store.units()
}

#[tauri::command]
pub fn vocabulary_unit_create(
    store: tauri::State<'_, VocabularyStore>,
    app: tauri::AppHandle,
    name: String,
) -> Result<VocabularyUnit, String> {
    let unit = store.unit_create(&name, now_ms())?;
    broadcast_change(&app);
    Ok(unit)
}

#[tauri::command]
pub fn vocabulary_unit_rename(
    store: tauri::State<'_, VocabularyStore>,
    app: tauri::AppHandle,
    id: String,
    name: String,
) -> Result<(), String> {
    store.unit_rename(&id, &name)?;
    broadcast_change(&app);
    Ok(())
}

#[tauri::command]
pub fn vocabulary_unit_remove(
    store: tauri::State<'_, VocabularyStore>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    store.unit_remove(&id)?;
    broadcast_change(&app);
    Ok(())
}

#[tauri::command]
pub fn vocabulary_move(
    store: tauri::State<'_, VocabularyStore>,
    app: tauri::AppHandle,
    id: String,
    unit_id: String,
) -> Result<(), String> {
    store.move_entry(&id, &unit_id)?;
    broadcast_change(&app);
    Ok(())
}

/// 任何变更后广播（pickdict broadcastChange 语义；发起者窗口也收到，刷新幂等无害）
fn broadcast_change(app: &tauri::AppHandle) {
    use tauri::Emitter;
    if let Err(error) = app.emit("vocabulary-changed", ()) {
        tracing::error!(target: "vocabulary", error = %error, "vocabulary-changed 广播失败");
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
            "onedict-vocab-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn add_is_idempotent_by_norm_key() {
        let dir = temp_dir("add");
        let store = VocabularyStore::open(&dir);
        let now = 1_000;

        let first = store.add("Hello", now).unwrap();
        assert!(first.created);
        let first = first.entry;
        assert_eq!(first.word, "Hello");
        assert_eq!(first.norm_key, "hello");

        // 空白/大小写归一化后命中同条目 → 返回已有条目 created=false
        let again = store.add("  hello  ", now + 5).unwrap();
        assert!(!again.created);
        assert_eq!(again.entry.id, first.id);
        assert_eq!(again.entry.added_at, now, "幂等命中不更新原条目");

        // 空词报错
        assert!(store.add("   ", now).is_err());
    }

    #[test]
    fn remove_missing_is_silent() {
        let dir = temp_dir("remove");
        let store = VocabularyStore::open(&dir);
        let entry = store.add("word", 1).unwrap().entry;

        store.remove("no-such-id").unwrap(); // 不存在：静默无错误
        assert_eq!(store.list().unwrap().len(), 1);

        store.remove(&entry.id).unwrap();
        assert_eq!(store.list().unwrap().len(), 0);
    }

    #[test]
    fn review_merges_schedule_and_bumps_count() {
        let dir = temp_dir("review");
        let store = VocabularyStore::open(&dir);
        let entry = store.add("word", 1).unwrap().entry;

        let next = ScheduleUpdate {
            ease_factor: 2.6,
            interval_days: 1.0,
            repetitions: 1,
            lapses: 0,
            due_at: 1 + 86_400_000,
            last_reviewed_at: Some(86_400_001),
            grade: None,
        };
        let updated = store.review(&entry.id, &next).unwrap();
        assert_eq!(updated.ease_factor, 2.6);
        assert_eq!(updated.repetitions, 1);
        assert_eq!(updated.review_count, 1);
        assert_eq!(updated.last_reviewed_at, Some(86_400_001));
        assert!(store.review("missing", &next).is_err());
    }

    #[test]
    fn corrupt_file_is_backed_up_as_corrupt() {
        let dir = temp_dir("corrupt");
        let path = dir.join("vocabulary.json");
        std::fs::write(&path, "{ not json").unwrap();

        let _store = VocabularyStore::open(&dir);
        assert!(!path.exists(), "损坏文件应被改名");
        assert!(dir.join("vocabulary.json.corrupt").exists());
    }

    #[test]
    fn unexpected_version_starts_empty() {
        let dir = temp_dir("version");
        let path = dir.join("vocabulary.json");
        std::fs::write(&path, r#"{"version":99,"entries":[]}"#).unwrap();

        let store = VocabularyStore::open(&dir);
        assert!(store.list().unwrap().is_empty(), "version 不符 → 空载");
        assert!(path.exists(), "原文件保留（warn，不删除）");
    }

    #[test]
    fn persist_roundtrip_keeps_schema_shape() {
        let dir = temp_dir("roundtrip");
        let now = 1_000;
        let entry = {
            let store = VocabularyStore::open(&dir);
            let r = store.add("días", now).unwrap();
            assert_eq!(r.entry.norm_key, "días"); // Unicode to_lowercase
            r.entry
        };

        // 新实例重开（模拟重启）→ 数据仍在，字段形状不变
        let store = VocabularyStore::open(&dir);
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], entry);
        assert_eq!(list[0].last_reviewed_at, None);

        // JSON 文本字段名与 pickdict schema 一致（camelCase）
        let text = std::fs::read_to_string(dir.join("vocabulary.json")).unwrap();
        for field in [
            "\"normKey\"", "\"addedAt\"", "\"easeFactor\"", "\"intervalDays\"",
            "\"repetitions\"", "\"dueAt\"", "\"lastReviewedAt\"", "\"reviewCount\"", "\"lapses\"",
            "\"unitId\"",
        ] {
            assert!(text.contains(field), "缺少字段 {field}");
        }
        assert!(text.contains("\"version\": 1"));
    }

    #[test]
    fn unit_crud_recycles_entries_to_inbox() {
        let dir = temp_dir("unit");
        let store = VocabularyStore::open(&dir);

        let unit = store.unit_create(" Unit 1 ", 100).unwrap();
        assert_eq!(unit.name, "Unit 1", "名称 trim");
        assert!(store.unit_create("   ", 100).is_err(), "空名报错");

        let entry = store.add("word", 100).unwrap().entry;
        assert_eq!(entry.unit_id, INBOX_UNIT_ID, "新词落收词箱");

        store.move_entry(&entry.id, &unit.id).unwrap();
        assert!(
            store.list().unwrap().iter().any(|e| e.id == entry.id && e.unit_id == unit.id),
            "移动后词条归属单元"
        );
        assert!(store.move_entry(&entry.id, "no-such-unit").is_err(), "目标单元须存在");
        assert!(store.move_entry("no-such-entry", INBOX_UNIT_ID).is_err(), "词条须存在");

        store.unit_rename(&unit.id, "Unit 1 改").unwrap();
        assert!(store.unit_rename(INBOX_UNIT_ID, "x").is_err(), "收词箱不可改名");

        store.unit_remove(&unit.id).unwrap();
        assert!(store.unit_remove(INBOX_UNIT_ID).is_err(), "收词箱不可删除");
        assert!(store.units().unwrap().is_empty());
        assert!(
            store.list().unwrap().iter().any(|e| e.id == entry.id && e.unit_id == INBOX_UNIT_ID),
            "删单元后词条回收进收词箱，词不丢"
        );
    }

    #[test]
    fn legacy_v1_file_loads_with_unit_defaults() {
        let dir = temp_dir("legacy");
        let path = dir.join("vocabulary.json");
        // pickdict v1 旧文件：无 units、entry 无 unitId —— serde default 兜底
        std::fs::write(
            &path,
            r#"{"version":1,"entries":[{"id":"e1","word":"apple","normKey":"apple","note":"",
                "addedAt":1,"easeFactor":2.5,"intervalDays":0,"repetitions":0,"dueAt":1,
                "lastReviewedAt":null,"reviewCount":0,"lapses":0}]}"#,
        )
        .unwrap();

        let store = VocabularyStore::open(&dir);
        assert!(store.units().unwrap().is_empty(), "旧文件无单元");
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].unit_id, INBOX_UNIT_ID, "缺省 unitId → 收词箱");
    }
}
