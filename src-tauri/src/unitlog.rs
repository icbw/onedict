//! 单元复习日志：轮次与抽查记录。
//!
//! 生词卡只存词条快照（SM-2 状态），单元的「复习了几轮、每轮评分分布、抽查漏了哪些词」
//! 无历史——单元卡的进度与收获感需要事件记录，故落盘 `unit-log.json`：
//! - `rounds` 每完成一轮追加一条（`vocabulary_unit_round_commit`；含四档分布与顽固词数）
//! - `checks` 每次抽查追加一条（`vocabulary_unit_check_commit`；记录抽样数与漏词）
//! - `groups` 智能分组批次（`group_apply` 写入、`group_undo` 消费后移除）——撤销的持久化依据
//!
//! 容量纪律：三类记录均设上限、超限裁掉最旧，长期使用下文件不无限增长。
//! 纪律：全局单例逻辑收敛实例方法 + `#[cfg(test)]` 实例测试。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "unit-log.json";
const VERSION: u32 = 1;
/// 轮次记录上限（每单元每轮一条，一年量级远小于此）
const MAX_ROUNDS: usize = 1000;
/// 抽查记录上限
const MAX_CHECKS: usize = 500;
/// 分组批次保留数（撤销只针对最近一次，多留几条便于回溯）
const MAX_GROUPS: usize = 5;

/// 单元复习轮次记录（完成一轮追加一条）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoundRecord {
    pub unit_id: String,
    pub unit_name: String,
    /// 第几轮（1 起）
    pub round: u32,
    /// 本轮开始时间（前端打开会话时刻）
    #[serde(default)]
    pub started_at: i64,
    pub completed_at: i64,
    /// 本轮入场词数
    pub size: u32,
    #[serde(default)]
    pub again: u32,
    #[serde(default)]
    pub hard: u32,
    #[serde(default)]
    pub good: u32,
    #[serde(default)]
    pub easy: u32,
    /// 结束时仍未通过（「重来」后未再评上）的词数
    #[serde(default)]
    pub again_pending: u32,
}

/// 单元抽查记录
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckRecord {
    pub unit_id: String,
    pub at: i64,
    pub sampled: u32,
    /// 抽查中评「重来/困难」的词（维持度信号）
    #[serde(default)]
    pub missed: Vec<String>,
}

/// 智能分组批次（撤销依据）
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupRecord {
    pub at: i64,
    pub unit_ids: Vec<String>,
    #[serde(default)]
    pub entry_count: u32,
}

/// 全量快照（前端自取所需切片）
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnitLogSnapshot {
    #[serde(default)]
    pub rounds: Vec<RoundRecord>,
    #[serde(default)]
    pub checks: Vec<CheckRecord>,
    #[serde(default)]
    pub groups: Vec<GroupRecord>,
}

#[derive(Serialize, Deserialize)]
struct UnitLogFile {
    version: u32,
    #[serde(default)]
    rounds: Vec<RoundRecord>,
    #[serde(default)]
    checks: Vec<CheckRecord>,
    #[serde(default)]
    groups: Vec<GroupRecord>,
}

struct LogState {
    path: PathBuf,
    data: UnitLogSnapshot,
}

/// Tauri managed state：命令内持锁短借（内存操作 + 变更即整文件落盘）
pub struct UnitLogStore {
    state: Mutex<LogState>,
}

impl UnitLogStore {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join(FILE_NAME);
        if let Err(error) = std::fs::create_dir_all(data_dir) {
            tracing::error!(target: "unitlog", dir = %data_dir.display(), error = %error, "数据目录创建失败（落盘将持续报错）");
        }
        let data = Self::load(&path);
        tracing::info!(
            target: "unitlog",
            path = %path.display(),
            rounds = data.rounds.len(),
            checks = data.checks.len(),
            "单元日志存储就绪"
        );
        Self { state: Mutex::new(LogState { path, data }) }
    }

    /// 磁盘载入：损坏 → 改名 .corrupt 留档 + 空载；version 不符 → 保留原文件空载
    fn load(path: &Path) -> UnitLogSnapshot {
        let Ok(text) = std::fs::read_to_string(path) else {
            return UnitLogSnapshot::default(); // 不存在 = 首次
        };
        match serde_json::from_str::<UnitLogFile>(&text) {
            Ok(file) if file.version == VERSION => UnitLogSnapshot {
                rounds: file.rounds,
                checks: file.checks,
                groups: file.groups,
            },
            Ok(_) => {
                tracing::warn!(target: "unitlog", path = %path.display(), "版本不符，空载（原文件保留）");
                UnitLogSnapshot::default()
            }
            Err(error) => {
                let corrupt = path.with_extension("json.corrupt");
                match std::fs::rename(path, &corrupt) {
                    Ok(()) => tracing::error!(target: "unitlog", path = %corrupt.display(), error = %error, "损坏文件改名留档，空载"),
                    Err(e) => tracing::error!(target: "unitlog", error = %e, "损坏文件改名失败，空载"),
                }
                UnitLogSnapshot::default()
            }
        }
    }

    /// 从指定路径重读（数据恢复 `data_restore` 用）：整 state 替换
    pub fn reload_from(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        state.data = Self::load(&path);
        state.path = path;
        Ok(())
    }

    pub fn record_round(&self, record: RoundRecord) {
        let Ok(mut state) = self.state.lock() else { return };
        state.data.rounds.push(record);
        trim(&mut state.data.rounds, MAX_ROUNDS);
        state.persist();
    }

    pub fn record_check(&self, record: CheckRecord) {
        let Ok(mut state) = self.state.lock() else { return };
        state.data.checks.push(record);
        trim(&mut state.data.checks, MAX_CHECKS);
        state.persist();
    }

    pub fn record_group(&self, record: GroupRecord) {
        let Ok(mut state) = self.state.lock() else { return };
        state.data.groups.push(record);
        trim(&mut state.data.groups, MAX_GROUPS);
        state.persist();
    }

    /// 最近一次分组（撤销目标；无记录 → None）
    pub fn last_group(&self) -> Option<GroupRecord> {
        let state = self.state.lock().ok()?;
        state.data.groups.last().cloned()
    }

    /// 移除最近一次分组记录（撤销成功后调用）
    pub fn drop_last_group(&self) {
        let Ok(mut state) = self.state.lock() else { return };
        state.data.groups.pop();
        state.persist();
    }

    pub fn snapshot(&self) -> Result<UnitLogSnapshot, String> {
        let state = self.state.lock().map_err(|_| "锁中毒")?;
        Ok(state.data.clone())
    }
}

/// 超限裁掉最旧（只追加语义：保留最近 N 条）
fn trim<T>(records: &mut Vec<T>, max: usize) {
    if records.len() > max {
        let overflow = records.len() - max;
        records.drain(0..overflow);
    }
}

impl LogState {
    fn persist(&mut self) {
        let file = UnitLogFile {
            version: VERSION,
            rounds: self.data.rounds.clone(),
            checks: self.data.checks.clone(),
            groups: self.data.groups.clone(),
        };
        let Ok(text) = serde_json::to_string_pretty(&file) else {
            tracing::error!(target: "unitlog", "序列化失败");
            return;
        };
        if let Err(error) = crate::fsutil::write_atomic(&self.path, &text) {
            tracing::error!(target: "unitlog", error = %error, "unit-log.json 落盘失败");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "onedict-unitlog-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn round(round_no: u32, completed_at: i64) -> RoundRecord {
        RoundRecord {
            unit_id: "u1".into(),
            unit_name: "Unit 1".into(),
            round: round_no,
            started_at: completed_at - 1_000,
            completed_at,
            size: 20,
            again: 1,
            hard: 2,
            good: 15,
            easy: 2,
            again_pending: 0,
        }
    }

    #[test]
    fn records_persist_and_reload() {
        let dir = temp_dir("persist");
        let store = UnitLogStore::open(&dir);
        store.record_round(round(1, 1_000));
        store.record_check(CheckRecord {
            unit_id: "u1".into(),
            at: 2_000,
            sampled: 5,
            missed: vec!["apple".into()],
        });
        store.record_group(GroupRecord { at: 3_000, unit_ids: vec!["a".into()], entry_count: 12 });

        let snap = store.snapshot().unwrap();
        assert_eq!(snap.rounds.len(), 1);
        assert_eq!(snap.checks.len(), 1);
        assert_eq!(snap.groups.len(), 1);

        // 重开（模拟重启）→ 数据仍在，字段形状正确
        let reopened = UnitLogStore::open(&dir);
        assert_eq!(reopened.snapshot().unwrap(), snap);
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        for field in ["\"version\"", "\"rounds\"", "\"checks\"", "\"groups\"", "\"againPending\""] {
            assert!(text.contains(field), "缺少字段 {field}");
        }
    }

    #[test]
    fn group_undo_consumes_last_record() {
        let dir = temp_dir("group");
        let store = UnitLogStore::open(&dir);
        store.record_group(GroupRecord { at: 1, unit_ids: vec!["a".into()], entry_count: 3 });
        store.record_group(GroupRecord { at: 2, unit_ids: vec!["b".into(), "c".into()], entry_count: 9 });

        let last = store.last_group().unwrap();
        assert_eq!(last.unit_ids, vec!["b".to_string(), "c".to_string()]);
        store.drop_last_group();
        assert_eq!(store.last_group().unwrap().unit_ids, vec!["a".to_string()]);
        store.drop_last_group();
        assert!(store.last_group().is_none(), "取空后返回 None");
    }

    #[test]
    fn records_are_trimmed_to_capacity() {
        let dir = temp_dir("trim");
        let store = UnitLogStore::open(&dir);
        for i in 0..(MAX_GROUPS as i64 + 3) {
            store.record_group(GroupRecord { at: i, unit_ids: vec![format!("u{i}")], entry_count: 1 });
        }
        let snap = store.snapshot().unwrap();
        assert_eq!(snap.groups.len(), MAX_GROUPS, "超限裁最旧");
        assert_eq!(snap.groups.last().unwrap().at, MAX_GROUPS as i64 + 2, "保留最近条目");
    }

    #[test]
    fn corrupt_file_moves_aside_and_starts_empty() {
        let dir = temp_dir("corrupt");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "{ not json").unwrap();

        let store = UnitLogStore::open(&dir);
        assert_eq!(store.snapshot().unwrap(), UnitLogSnapshot::default());
        assert!(!path.exists(), "损坏文件应被改名");
        assert!(dir.join("unit-log.json.corrupt").exists());
    }

    #[test]
    fn unexpected_version_starts_empty() {
        let dir = temp_dir("version");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, r#"{"version":99,"rounds":[]}"#).unwrap();

        let store = UnitLogStore::open(&dir);
        assert!(store.snapshot().unwrap().rounds.is_empty(), "version 不符 → 空载");
        assert!(path.exists(), "原文件保留（warn，不删除）");
    }
}
