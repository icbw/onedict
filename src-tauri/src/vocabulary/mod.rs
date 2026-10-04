//! 生词卡存储（pickdict VocabularyService 的 Rust 移植，语义逐条对齐：
//!   vocabulary_list    全量条目（JSON 存储规模 <1 万条，全量拉取 + renderer 侧过滤排序）
//!   vocabulary_has     查重（normKey 归一化匹配）
//!   vocabulary_add     幂等添加：同 normKey 已存在时返回已有条目（created=false）
//!   vocabulary_remove  删除（id 不存在时静默，无错误）
//!   vocabulary_review  提交复习调度结果（reviewCount+1 后合并写盘）
//!   —— 单元与分组（单元 = 复习单位）
//!   vocabulary_unit_update       更新单元元数据（容量 / 状态 / 锁定 / 显示序）
//!   vocabulary_group_apply       智能分组落地：一次创建自动单元 + 批量移动词条
//!   vocabulary_group_undo        撤销最近一次自动分组（删单元、词条回收进收词箱）
//!   vocabulary_unit_round_commit 提交单元复习轮次（unit-log.json + 单元进度推进）
//!   vocabulary_unit_check_commit 提交单元抽查记录
//!   vocabulary_unit_log          单元轮次 / 抽查 / 分组记录（前端自取切片）
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

/// 语境句长上限（字符数；超长截断防单条爆体积——截断发生在入存储前，
/// 收词箱语境句在复习卡与备份中长期驻留）
const CONTEXT_SENTENCE_MAX_CHARS: usize = 500;

/// 收词语境（查词场景记忆）。sentence 为空 = 降级态（仅来源元数据）。
/// wordOffset = 选区词在句中的偏移，单位 UTF-16 code unit（JS 字符串天然索引，
/// 前端 slice 直接可用；在 Rust 侧按 encode_utf16 计算，不存字节偏移）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EntryContext {
    /// 原句，词形保持原样——遇到的词形本身就是记忆对象
    #[serde(default)]
    pub sentence: String,
    /// [start, end) 偏移；None = 句中未定位到选区词（截断 / 跨句边界）
    #[serde(default)]
    pub word_offset: Option<[u32; 2]>,
    #[serde(default)]
    pub source_app: Option<String>,
    /// selection / clipboard / manual（ocr 预留）
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub captured_at: i64,
}

/// 主复习词义（释义级收藏）：释义文本快照，词典文件更新不失效
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntrySense {
    /// 来源词典（展示用；词典移除后兜底显示 id）
    pub dict_id: String,
    pub definition: String,
}

/// 语境入库清理：句超长截断（char boundary 安全）；截断后偏移越界即丢弃
fn sanitize_context(mut ctx: EntryContext) -> EntryContext {
    if ctx.sentence.chars().count() > CONTEXT_SENTENCE_MAX_CHARS {
        ctx.sentence = ctx.sentence.chars().take(CONTEXT_SENTENCE_MAX_CHARS).collect();
        ctx.word_offset = None; // 截断窗口不保证仍含选区词
    }
    ctx
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
    /// 最近一次评分（不确定词判定 = again/hard 或 lapses 偏高；serde default 兼容旧文件）
    #[serde(default)]
    pub last_grade: Option<String>,
    /// 收词语境（旧文件 / 纯词头收藏 = None）
    #[serde(default)]
    pub context: Option<EntryContext>,
    /// 主复习词义（无释义收藏 = None，复习回落通用义）
    #[serde(default)]
    pub sense: Option<EntrySense>,
}

/// 单元容量默认值（新建 / 自动分组未显式指定时的生词上限）
pub const DEFAULT_UNIT_CAPACITY: u32 = 20;

/// 单元来源：手工创建 / 自动聚合（自动单元可被重跑替换）
pub const UNIT_KIND_MANUAL: &str = "manual";
pub const UNIT_KIND_AUTO: &str = "auto";
/// 单元状态：进行中 / 已毕业 / 暂停
pub const UNIT_STATUS_ACTIVE: &str = "active";
pub const UNIT_STATUS_DONE: &str = "done";
pub const UNIT_STATUS_PAUSED: &str = "paused";

fn default_unit_kind() -> String {
    UNIT_KIND_MANUAL.to_string()
}

fn default_unit_capacity() -> u32 {
    DEFAULT_UNIT_CAPACITY
}

fn default_unit_status() -> String {
    UNIT_STATUS_ACTIVE.to_string()
}

/// 学习单元（分组 + 复习单位；收词箱为保留 id 不入此列表）。
/// id/name/createdAt 之外均为后加字段：serde default 保证旧文件零破坏。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyUnit {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    /// 来源：manual / auto
    #[serde(default = "default_unit_kind")]
    pub kind: String,
    /// 生词上限（0 = 不限）；自动分组按此拆包
    #[serde(default = "default_unit_capacity")]
    pub capacity: u32,
    /// active / done / paused（毕业判定见前端 reviewPlan）
    #[serde(default = "default_unit_status")]
    pub status: String,
    /// 当前复习轮次（0 = 未开始，每完成一轮 +1）
    #[serde(default)]
    pub round: u32,
    /// 上一轮完成时间
    #[serde(default)]
    pub last_completed_at: Option<i64>,
    /// 聚合规则标识（展示分组依据 / 重算分组）
    #[serde(default)]
    pub seed: Option<String>,
    /// 用户手改过 → 自动重跑不覆盖
    #[serde(default)]
    pub locked: bool,
    /// 显示序（0 = 按创建序）
    #[serde(default)]
    pub order: i64,
}

/// 新建单元的可选参数（缺省 = 手工单元 / 默认容量 / 未锁定）
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitCreateOpts {
    pub kind: Option<String>,
    pub capacity: Option<u32>,
    pub seed: Option<String>,
    pub locked: Option<bool>,
}

/// 单元元数据补丁（仅传入字段生效）
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitPatch {
    pub name: Option<String>,
    pub capacity: Option<u32>,
    pub status: Option<String>,
    pub locked: Option<bool>,
    pub order: Option<i64>,
}

/// 智能分组的一组：单元名 + 归属词条（由前端聚合算法产出）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSpec {
    pub name: String,
    #[serde(default)]
    pub seed: Option<String>,
    #[serde(default)]
    pub capacity: Option<u32>,
    pub entry_ids: Vec<String>,
}

/// 单元复习轮次提交（unit-log 记录 + 单元进度推进；完成时间与单元名由存储侧补全）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundRecordInput {
    /// 第几轮（1 起）
    pub round: u32,
    #[serde(default)]
    pub started_at: i64,
    pub size: u32,
    #[serde(default)]
    pub again: u32,
    #[serde(default)]
    pub hard: u32,
    #[serde(default)]
    pub good: u32,
    #[serde(default)]
    pub easy: u32,
    #[serde(default)]
    pub again_pending: u32,
    /// 毕业规则（前端 reviewPlan 判定）给出的新状态；None = 保持
    #[serde(default)]
    pub status: Option<String>,
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
    /// 已存在但补填了语境 / 更新了主词义（created=false 时的更新信号，
    /// 前端据此区分「已在生词本」与「已补充语境」提示）
    pub updated: bool,
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

    /// 幂等添加（带语境 / 主词义）：
    /// 不存在 → 创建（挂 context / sense）；
    /// 已存在 → context 为 None 时补填（重查 = 没记住，语境仍有增量价值），
    /// 已有 context 不覆盖（多语境追加不支持）；sense 传入即更新（最新收藏胜出）。
    /// 空词报错。
    fn add(
        &mut self,
        raw_word: &str,
        now: i64,
        context: Option<EntryContext>,
        sense: Option<EntrySense>,
    ) -> Result<(VocabularyEntry, bool, bool), String> {
        let word = normalize_word(raw_word);
        if word.is_empty() {
            return Err("empty word".into());
        }
        let key = word.to_lowercase();
        let context = context.map(sanitize_context);
        if let Some(existing) = self.entries.iter_mut().find(|e| e.norm_key == key) {
            let mut updated = false;
            if existing.context.is_none() {
                if let Some(ctx) = context {
                    existing.context = Some(ctx);
                    updated = true;
                }
            }
            if let Some(sense) = sense {
                if existing.sense.as_ref() != Some(&sense) {
                    existing.sense = Some(sense);
                    updated = true;
                }
            }
            // clone 终结 existing 借用后再落盘（persist 借 &self）
            let entry = existing.clone();
            if updated {
                self.persist();
            }
            return Ok((entry, false, updated));
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
            last_grade: None,
            context,
            sense,
        };
        self.entries.push(entry.clone());
        self.persist();
        Ok((entry, true, false))
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
    fn unit_create(
        &mut self,
        raw_name: &str,
        now: i64,
        opts: &UnitCreateOpts,
    ) -> Result<VocabularyUnit, String> {
        let name = raw_name.trim();
        if name.is_empty() {
            return Err("empty unit name".into());
        }
        let unit = VocabularyUnit {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            created_at: now,
            kind: opts.kind.clone().unwrap_or_else(|| UNIT_KIND_MANUAL.to_string()),
            capacity: opts.capacity.unwrap_or(DEFAULT_UNIT_CAPACITY),
            status: UNIT_STATUS_ACTIVE.to_string(),
            round: 0,
            last_completed_at: None,
            seed: opts.seed.clone(),
            locked: opts.locked.unwrap_or(false),
            order: self.units.len() as i64,
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

    /// 移动词条到单元（目标须为收词箱或已存在单元；词条不存在报错）。
    /// 手改内容即锁定目标单元——自动分组重跑不覆盖用户的调整。
    fn move_entry(&mut self, entry_id: &str, unit_id: &str) -> Result<(), String> {
        if unit_id != INBOX_UNIT_ID && !self.units.iter().any(|u| u.id == unit_id) {
            return Err(format!("unit not found: {unit_id}"));
        }
        let entry = self
            .entries
            .iter_mut()
            .find(|e| e.id == entry_id)
            .ok_or_else(|| format!("vocabulary entry not found: {entry_id}"))?;
        let changed = entry.unit_id != unit_id;
        if changed {
            entry.unit_id = unit_id.to_string();
        }
        if changed {
            if let Some(unit) = self.units.iter_mut().find(|u| u.id == unit_id) {
                unit.locked = true;
            }
            self.persist();
        }
        Ok(())
    }

    /// 更新单元元数据（仅传入字段生效；空名报错；收词箱不可改）
    fn unit_update(&mut self, id: &str, patch: &UnitPatch) -> Result<VocabularyUnit, String> {
        if id == INBOX_UNIT_ID {
            return Err("cannot update inbox".into());
        }
        if let Some(name) = patch.name.as_deref() {
            if name.trim().is_empty() {
                return Err("empty unit name".into());
            }
        }
        let unit = self
            .units
            .iter_mut()
            .find(|u| u.id == id)
            .ok_or_else(|| format!("unit not found: {id}"))?;
        if let Some(name) = patch.name.as_deref() {
            unit.name = name.trim().to_string();
        }
        if let Some(capacity) = patch.capacity {
            unit.capacity = capacity;
        }
        if let Some(status) = patch.status.as_deref() {
            unit.status = status.to_string();
        }
        if let Some(order) = patch.order {
            unit.order = order;
        }
        // 手改即锁定（显式传 locked 时以传入值为准，便于解绑）
        unit.locked = patch.locked.unwrap_or(true);
        let updated = unit.clone();
        self.persist();
        Ok(updated)
    }

    /// 复习轮次推进（完成一轮：轮次 + 完成时间 + 可选状态变更）
    fn unit_advance(
        &mut self,
        id: &str,
        round: u32,
        completed_at: i64,
        status: Option<&str>,
    ) -> Result<VocabularyUnit, String> {
        let unit = self
            .units
            .iter_mut()
            .find(|u| u.id == id)
            .ok_or_else(|| format!("unit not found: {id}"))?;
        unit.round = round;
        unit.last_completed_at = Some(completed_at);
        if let Some(status) = status {
            unit.status = status.to_string();
        }
        let updated = unit.clone();
        self.persist();
        Ok(updated)
    }

    /// 智能分组落地：为每组创建自动单元并批量移动词条（先全量校验，避免半写入）
    fn group_apply(&mut self, groups: &[GroupSpec], now: i64) -> Result<Vec<VocabularyUnit>, String> {
        for group in groups {
            if group.name.trim().is_empty() {
                return Err("empty unit name".into());
            }
            if group.entry_ids.is_empty() {
                return Err("empty group".into());
            }
            for id in &group.entry_ids {
                if !self.entries.iter().any(|e| e.id == *id) {
                    return Err(format!("vocabulary entry not found: {id}"));
                }
            }
        }
        let mut created = Vec::with_capacity(groups.len());
        for group in groups {
            let unit = VocabularyUnit {
                id: uuid::Uuid::new_v4().to_string(),
                name: group.name.trim().to_string(),
                created_at: now,
                kind: UNIT_KIND_AUTO.to_string(),
                capacity: group.capacity.unwrap_or(DEFAULT_UNIT_CAPACITY),
                status: UNIT_STATUS_ACTIVE.to_string(),
                round: 0,
                last_completed_at: None,
                seed: group.seed.clone(),
                locked: false,
                order: self.units.len() as i64,
            };
            for entry in self
                .entries
                .iter_mut()
                .filter(|e| group.entry_ids.contains(&e.id))
            {
                entry.unit_id = unit.id.clone();
            }
            self.units.push(unit.clone());
            created.push(unit);
        }
        self.persist();
        Ok(created)
    }

    /// 撤销一次自动分组：删除批内单元（词条自动回收进收词箱），返回删除的单元数
    fn group_undo(&mut self, unit_ids: &[String]) -> u32 {
        let before = self.units.len();
        self.units.retain(|u| !unit_ids.contains(&u.id));
        let removed = (before - self.units.len()) as u32;
        if removed > 0 {
            for entry in self.entries.iter_mut() {
                if unit_ids.contains(&entry.unit_id) {
                    entry.unit_id = INBOX_UNIT_ID.to_string();
                }
            }
            self.persist();
        }
        removed
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
        if let Some(grade) = next.grade.as_deref() {
            entry.last_grade = Some(grade.to_string());
        }
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

    pub fn add(
        &self,
        word: &str,
        now: i64,
        context: Option<EntryContext>,
        sense: Option<EntrySense>,
    ) -> Result<AddResult, String> {
        self.with(|s| {
            let (entry, created, updated) = s.add(word, now, context, sense)?;
            Ok(AddResult { entry, created, updated })
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

    pub fn unit_create(
        &self,
        name: &str,
        now: i64,
        opts: &UnitCreateOpts,
    ) -> Result<VocabularyUnit, String> {
        self.with(|s| s.unit_create(name, now, opts))?
    }

    pub fn unit_update(&self, id: &str, patch: &UnitPatch) -> Result<VocabularyUnit, String> {
        self.with(|s| s.unit_update(id, patch))?
    }

    pub fn unit_advance(
        &self,
        id: &str,
        round: u32,
        completed_at: i64,
        status: Option<&str>,
    ) -> Result<VocabularyUnit, String> {
        self.with(|s| s.unit_advance(id, round, completed_at, status))?
    }

    pub fn group_apply(
        &self,
        groups: &[GroupSpec],
        now: i64,
    ) -> Result<Vec<VocabularyUnit>, String> {
        self.with(|s| s.group_apply(groups, now))?
    }

    pub fn group_undo(&self, unit_ids: &[String]) -> Result<u32, String> {
        self.with(|s| s.group_undo(unit_ids))
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
    context: Option<EntryContext>,
    sense: Option<EntrySense>,
) -> Result<AddResult, String> {
    let result = store.add(&word, now_ms(), context, sense)?;
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
    kind: Option<String>,
    capacity: Option<u32>,
    seed: Option<String>,
    locked: Option<bool>,
) -> Result<VocabularyUnit, String> {
    let opts = UnitCreateOpts { kind, capacity, seed, locked };
    let unit = store.unit_create(&name, now_ms(), &opts)?;
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

/// 更新单元元数据（容量 / 名称 / 状态 / 锁定 / 显示序）
#[tauri::command]
pub fn vocabulary_unit_update(
    store: tauri::State<'_, VocabularyStore>,
    app: tauri::AppHandle,
    id: String,
    patch: UnitPatch,
) -> Result<VocabularyUnit, String> {
    let unit = store.unit_update(&id, &patch)?;
    broadcast_change(&app);
    Ok(unit)
}

/// 智能分组落地：创建自动单元 + 批量移动词条，并记入 unit-log（供撤销）
#[tauri::command]
pub fn vocabulary_group_apply(
    store: tauri::State<'_, VocabularyStore>,
    log: tauri::State<'_, crate::unitlog::UnitLogStore>,
    app: tauri::AppHandle,
    groups: Vec<GroupSpec>,
) -> Result<Vec<VocabularyUnit>, String> {
    let now = now_ms();
    let created = store.group_apply(&groups, now)?;
    let entry_count = groups.iter().map(|g| g.entry_ids.len() as u32).sum();
    log.record_group(crate::unitlog::GroupRecord {
        at: now,
        unit_ids: created.iter().map(|u| u.id.clone()).collect(),
        entry_count,
    });
    broadcast_change(&app);
    Ok(created)
}

/// 撤销最近一次智能分组（无记录 → 0，静默；单元删除、词条回收进收词箱）
#[tauri::command]
pub fn vocabulary_group_undo(
    store: tauri::State<'_, VocabularyStore>,
    log: tauri::State<'_, crate::unitlog::UnitLogStore>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let Some(record) = log.last_group() else {
        return Ok(0);
    };
    let removed = store.group_undo(&record.unit_ids)?;
    log.drop_last_group();
    if removed > 0 {
        broadcast_change(&app);
    }
    Ok(removed)
}

/// 提交单元复习轮次：写 unit-log + 推进单元进度（轮次 / 完成时间 / 可选状态）
#[tauri::command]
pub fn vocabulary_unit_round_commit(
    store: tauri::State<'_, VocabularyStore>,
    log: tauri::State<'_, crate::unitlog::UnitLogStore>,
    app: tauri::AppHandle,
    unit_id: String,
    record: RoundRecordInput,
) -> Result<VocabularyUnit, String> {
    let now = now_ms();
    let updated = store.unit_advance(&unit_id, record.round, now, record.status.as_deref())?;
    log.record_round(crate::unitlog::RoundRecord {
        unit_id: updated.id.clone(),
        unit_name: updated.name.clone(),
        round: record.round,
        started_at: record.started_at,
        completed_at: now,
        size: record.size,
        again: record.again,
        hard: record.hard,
        good: record.good,
        easy: record.easy,
        again_pending: record.again_pending,
    });
    broadcast_change(&app);
    Ok(updated)
}

/// 提交单元抽查记录（不改轮次进度；评分已由 vocabulary_review 单独写入）
#[tauri::command]
pub fn vocabulary_unit_check_commit(
    log: tauri::State<'_, crate::unitlog::UnitLogStore>,
    app: tauri::AppHandle,
    unit_id: String,
    sampled: u32,
    missed: Vec<String>,
) -> Result<(), String> {
    log.record_check(crate::unitlog::CheckRecord {
        unit_id,
        at: now_ms(),
        sampled,
        missed,
    });
    broadcast_change(&app);
    Ok(())
}

/// 单元日志全量（轮次 / 抽查 / 分组；前端自取切片）
#[tauri::command]
pub fn vocabulary_unit_log(
    log: tauri::State<'_, crate::unitlog::UnitLogStore>,
) -> Result<crate::unitlog::UnitLogSnapshot, String> {
    log.snapshot()
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

        let first = store.add("Hello", now, None, None).unwrap();
        assert!(first.created);
        assert!(!first.updated);
        let first = first.entry;
        assert_eq!(first.word, "Hello");
        assert_eq!(first.norm_key, "hello");
        assert!(first.context.is_none(), "纯词头收藏无语境");

        // 空白/大小写归一化后命中同条目 → 返回已有条目 created=false
        let again = store.add("  hello  ", now + 5, None, None).unwrap();
        assert!(!again.created);
        assert_eq!(again.entry.id, first.id);
        assert_eq!(again.entry.added_at, now, "幂等命中不更新原条目");

        // 空词报错
        assert!(store.add("   ", now, None, None).is_err());
    }

    fn sample_context() -> EntryContext {
        EntryContext {
            sentence: "The quick brown fox jumps.".into(),
            word_offset: Some([4, 9]),
            source_app: Some("chrome.exe".into()),
            kind: "selection".into(),
            captured_at: 123,
        }
    }

    #[test]
    fn add_with_context_fills_but_never_overwrites() {
        let dir = temp_dir("context");
        let store = VocabularyStore::open(&dir);
        let now = 1_000;

        // 新建即带语境与主词义
        let ctx = sample_context();
        let sense = EntrySense { dict_id: "d1".into(), definition: "adj. 快的".into() };
        let r = store.add("quick", now, Some(ctx.clone()), Some(sense.clone())).unwrap();
        assert!(r.created);
        assert_eq!(r.entry.context.as_ref(), Some(&ctx));
        assert_eq!(r.entry.sense.as_ref(), Some(&sense));

        // 已存在且已有语境 → 不覆盖（多语境追加不支持）
        let other = EntryContext { sentence: "其他句子".into(), ..Default::default() };
        let r = store.add("QUICK", now, Some(other), None).unwrap();
        assert!(!r.created && !r.updated);
        assert_eq!(r.entry.context.as_ref(), Some(&ctx), "已有语境不被覆盖");

        // sense 传入即更新（最新收藏胜出）
        let new_sense = EntrySense { dict_id: "d2".into(), definition: "adj. 迅速的".into() };
        let r = store
            .add("quick", now, None, Some(new_sense.clone()))
            .unwrap();
        assert!(!r.created && r.updated);
        assert_eq!(r.entry.sense.as_ref(), Some(&new_sense));

        // 语境补填：纯词头旧词遇到语境 → 补填 + updated
        store.add("bare", now, None, None).unwrap();
        let r = store.add("bare", now, Some(ctx.clone()), None).unwrap();
        assert!(!r.created && r.updated);
        assert_eq!(r.entry.context.as_ref(), Some(&ctx));

        // 重启后语境仍在（roundtrip）
        let store = VocabularyStore::open(&dir);
        let entry = store.list().unwrap().into_iter().find(|e| e.word == "quick").unwrap();
        assert_eq!(entry.context.as_ref(), Some(&ctx));
        assert_eq!(entry.sense.as_ref(), Some(&new_sense));
    }

    #[test]
    fn context_sentence_truncates_to_limit() {
        // 截断到上限；截断后偏移越界即丢弃
        let long: String = "词".repeat(CONTEXT_SENTENCE_MAX_CHARS + 50);
        let ctx = EntryContext {
            sentence: long.clone(),
            word_offset: Some([0, 1]),
            ..Default::default()
        };
        let sanitized = sanitize_context(ctx);
        assert_eq!(sanitized.sentence.chars().count(), CONTEXT_SENTENCE_MAX_CHARS);
        assert!(sanitized.word_offset.is_none(), "截断后偏移丢弃");

        // 未超长 → 偏移保留
        let ctx = EntryContext { sentence: "正常句子".into(), word_offset: Some([2, 4]), ..Default::default() };
        assert_eq!(sanitize_context(ctx).word_offset, Some([2, 4]));
    }

    #[test]
    fn remove_missing_is_silent() {
        let dir = temp_dir("remove");
        let store = VocabularyStore::open(&dir);
        let entry = store.add("word", 1, None, None).unwrap().entry;

        store.remove("no-such-id").unwrap(); // 不存在：静默无错误
        assert_eq!(store.list().unwrap().len(), 1);

        store.remove(&entry.id).unwrap();
        assert_eq!(store.list().unwrap().len(), 0);
    }

    #[test]
    fn review_merges_schedule_and_bumps_count() {
        let dir = temp_dir("review");
        let store = VocabularyStore::open(&dir);
        let entry = store.add("word", 1, None, None).unwrap().entry;

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
            let r = store.add("días", now, None, None).unwrap();
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
            "\"unitId\"", "\"lastGrade\"", "\"context\"", "\"sense\"",
        ] {
            assert!(text.contains(field), "缺少字段 {field}");
        }
        assert!(text.contains("\"version\": 1"));
    }

    #[test]
    fn unit_crud_recycles_entries_to_inbox() {
        let dir = temp_dir("unit");
        let store = VocabularyStore::open(&dir);

        let opts = UnitCreateOpts::default();
        let unit = store.unit_create(" Unit 1 ", 100, &opts).unwrap();
        assert_eq!(unit.name, "Unit 1", "名称 trim");
        assert!(store.unit_create("   ", 100, &opts).is_err(), "空名报错");

        let entry = store.add("word", 100, None, None).unwrap().entry;
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
        assert!(list[0].context.is_none(), "旧文件无语境字段 → None");
        assert!(list[0].sense.is_none(), "旧文件无主词义 → None");
    }

    #[test]
    fn legacy_unit_without_new_fields_gets_defaults() {
        let dir = temp_dir("legacy-unit");
        let path = dir.join("vocabulary.json");
        std::fs::write(
            &path,
            r#"{"version":1,"entries":[],"units":[{"id":"u1","name":"旧单元","createdAt":5}]}"#,
        )
        .unwrap();

        let store = VocabularyStore::open(&dir);
        let units = store.units().unwrap();
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].kind, UNIT_KIND_MANUAL);
        assert_eq!(units[0].capacity, DEFAULT_UNIT_CAPACITY);
        assert_eq!(units[0].status, UNIT_STATUS_ACTIVE);
        assert_eq!(units[0].round, 0);
        assert!(units[0].last_completed_at.is_none());
        assert!(units[0].seed.is_none());
        assert!(!units[0].locked);
        assert_eq!(units[0].order, 0);
    }

    #[test]
    fn unit_metadata_patch_and_advance() {
        let dir = temp_dir("unit-meta");
        let store = VocabularyStore::open(&dir);
        let unit = store.unit_create("Unit", 100, &UnitCreateOpts::default()).unwrap();

        let patched = store
            .unit_update(&unit.id, &UnitPatch { capacity: Some(12), ..Default::default() })
            .unwrap();
        assert_eq!(patched.capacity, 12);
        assert!(patched.locked, "手改即锁定");
        assert!(store.unit_update(&unit.id, &UnitPatch { name: Some("  ".into()), ..Default::default() }).is_err());
        assert!(store.unit_update(INBOX_UNIT_ID, &UnitPatch::default()).is_err(), "收词箱不可改");

        let unlocked = store
            .unit_update(&unit.id, &UnitPatch { locked: Some(false), ..Default::default() })
            .unwrap();
        assert!(!unlocked.locked, "显式传值可解绑");

        let advanced = store.unit_advance(&unit.id, 1, 5_000, Some(UNIT_STATUS_DONE)).unwrap();
        assert_eq!(advanced.round, 1);
        assert_eq!(advanced.last_completed_at, Some(5_000));
        assert_eq!(advanced.status, UNIT_STATUS_DONE);
        assert!(store.unit_advance("missing", 1, 0, None).is_err());
    }

    #[test]
    fn group_apply_creates_units_and_undo_recycles() {
        let dir = temp_dir("group");
        let store = VocabularyStore::open(&dir);
        let a = store.add("apple", 1, None, None).unwrap().entry;
        let b = store.add("apply", 1, None, None).unwrap().entry;
        let c = store.add("banana", 1, None, None).unwrap().entry;

        let groups = vec![
            GroupSpec {
                name: "a- 词族".into(),
                seed: Some("morph:a".into()),
                capacity: Some(10),
                entry_ids: vec![a.id.clone(), b.id.clone()],
            },
            GroupSpec {
                name: "其他".into(),
                seed: None,
                capacity: None,
                entry_ids: vec![c.id.clone()],
            },
        ];
        let created = store.group_apply(&groups, 100).unwrap();
        assert_eq!(created.len(), 2);
        assert_eq!(created[0].kind, UNIT_KIND_AUTO);
        assert_eq!(created[0].capacity, 10);
        assert_eq!(created[1].capacity, DEFAULT_UNIT_CAPACITY);

        let list = store.list().unwrap();
        let unit_of = |id: &str| list.iter().find(|e| e.id == id).unwrap().unit_id.clone();
        assert_eq!(unit_of(&a.id), created[0].id);
        assert_eq!(unit_of(&c.id), created[1].id);

        // 校验失败不半写入（含不存在词条）
        let bad = vec![GroupSpec {
            name: "x".into(),
            seed: None,
            capacity: None,
            entry_ids: vec![a.id.clone(), "missing".into()],
        }];
        assert!(store.group_apply(&bad, 100).is_err());
        assert_eq!(store.units().unwrap().len(), 2, "失败不新增单元");
        assert!(store
            .group_apply(
                &[GroupSpec { name: " ".into(), seed: None, capacity: None, entry_ids: vec![a.id.clone()] }],
                100,
            )
            .is_err());

        // 撤销：删单元 + 词回收进收词箱
        let ids: Vec<String> = created.iter().map(|u| u.id.clone()).collect();
        assert_eq!(store.group_undo(&ids).unwrap(), 2);
        assert!(store.units().unwrap().is_empty());
        let list = store.list().unwrap();
        assert!(list.iter().all(|e| e.unit_id == INBOX_UNIT_ID), "词条回收进收词箱");
    }

    #[test]
    fn review_records_last_grade_and_move_locks_unit() {
        let dir = temp_dir("last-grade");
        let store = VocabularyStore::open(&dir);
        let entry = store.add("word", 1, None, None).unwrap().entry;
        let unit = store.unit_create("U", 1, &UnitCreateOpts::default()).unwrap();

        let next = ScheduleUpdate {
            ease_factor: 2.5,
            interval_days: 1.0,
            repetitions: 1,
            lapses: 0,
            due_at: 2,
            last_reviewed_at: Some(2),
            grade: Some("hard".into()),
        };
        let updated = store.review(&entry.id, &next).unwrap();
        assert_eq!(updated.last_grade.as_deref(), Some("hard"));

        // 移入单元 → 目标单元锁定（自动重跑不覆盖用户的调整）
        store.move_entry(&entry.id, &unit.id).unwrap();
        let units = store.units().unwrap();
        assert!(units[0].locked, "手改内容即锁定");
    }
}
