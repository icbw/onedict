//! 学习统计：复习日志。
//!
//! SM-2 元数据只存词条快照（repetitions/lapses/dueAt…），复习事件无历史——
//! 统计图表需要「哪天复习了多少、各档评分分布」，故按**天聚合**落盘
//! `review-log.json`（每次复习计数 +1，一天一条；不存逐事件明细，一年 ≤366 条）。
//!
//! - 记录点 = `vocabulary_review` 命令（Rust 侧复习持久化唯一入口，不漏记）；
//!   `ScheduleUpdate.grade` 为 serde default 可选项——旧调用/测试不传 = 不记。
//! - 日期键 = 本地时区 `YYYY-MM-DD`（GetLocalTime 直接给本地年月日，零时区换算；
//!   前端图表同用本地时区聚合，两端一致）。
//! - 非法评分值不写盘（防御：日志不因脏数据膨胀）。
//!
//! 纪律：全局单例逻辑收敛实例方法 + `#[cfg(test)]` 实例测试（MEMORY 通用坑）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use windows::Win32::Foundation::SYSTEMTIME;
use windows::Win32::System::SystemInformation::GetLocalTime;

pub const FILE_NAME: &str = "review-log.json";
const VERSION: u32 = 1;

/// 合法评分（与前端 sm2.ts ReviewGrade 对齐）
pub const GRADES: [&str; 4] = ["again", "hard", "good", "easy"];

/// 单日复习计数（四档评分次数）
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    #[serde(default)]
    pub again: u32,
    #[serde(default)]
    pub hard: u32,
    #[serde(default)]
    pub good: u32,
    #[serde(default)]
    pub easy: u32,
}

impl DayCount {
    fn bump(&mut self, grade: &str) {
        match grade {
            "again" => self.again += 1,
            "hard" => self.hard += 1,
            "good" => self.good += 1,
            "easy" => self.easy += 1,
            _ => {}
        }
    }

    /// 当日四档总数（预留对称 getter：前端 stats.ts 同源聚合，Rust 侧暂无消费方）
    #[allow(dead_code)]
    pub fn total(&self) -> u32 {
        self.again + self.hard + self.good + self.easy
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct LogFile {
    version: u32,
    days: BTreeMap<String, DayCount>,
}

impl Default for LogFile {
    fn default() -> Self {
        Self { version: VERSION, days: BTreeMap::new() }
    }
}

struct LogState {
    path: PathBuf,
    days: BTreeMap<String, DayCount>,
}

/// Tauri managed state：命令内持锁短借（内存操作 + 变更即整文件落盘）
pub struct ReviewLogStore {
    state: Mutex<LogState>,
}

impl ReviewLogStore {
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join(FILE_NAME);
        if let Err(error) = std::fs::create_dir_all(data_dir) {
            tracing::error!(target: "reviewlog", dir = %data_dir.display(), error = %error, "数据目录创建失败（落盘将持续报错）");
        }
        let days = Self::load(&path);
        tracing::info!(target: "reviewlog", path = %path.display(), days = days.len(), "复习日志存储就绪");
        Self { state: Mutex::new(LogState { path, days }) }
    }

    /// 磁盘载入：损坏 → 改名 .corrupt 留档 + 空载；version 不符 → 保留原文件空载
    fn load(path: &Path) -> BTreeMap<String, DayCount> {
        let Ok(text) = std::fs::read_to_string(path) else {
            return BTreeMap::new(); // 不存在 = 首次
        };
        match serde_json::from_str::<LogFile>(&text) {
            Ok(file) if file.version == VERSION => file.days,
            Ok(_) => {
                tracing::warn!(target: "reviewlog", path = %path.display(), "版本不符，空载（原文件保留）");
                BTreeMap::new()
            }
            Err(error) => {
                let corrupt = path.with_extension("json.corrupt");
                match std::fs::rename(path, &corrupt) {
                    Ok(()) => tracing::error!(target: "reviewlog", path = %corrupt.display(), error = %error, "损坏文件改名留档，空载"),
                    Err(e) => tracing::error!(target: "reviewlog", error = %e, "损坏文件改名失败，空载"),
                }
                BTreeMap::new()
            }
        }
    }

    /// 从指定路径重读（数据恢复 data_restore 用）：整 state 替换
    pub fn reload_from(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "锁中毒")?;
        state.days = Self::load(&path);
        state.path = path;
        Ok(())
    }

    /// 记录一次复习（非法评分 = 静默忽略不落盘）
    pub fn record(&self, grade: &str, day_key: &str) {
        if !GRADES.contains(&grade) {
            return;
        }
        let mut state = match self.state.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        state.days.entry(day_key.to_string()).or_default().bump(grade);
        state.persist();
    }

    /// 快照（按日期升序；图表自取最近 N 天切片）
    pub fn snapshot(&self) -> Result<BTreeMap<String, DayCount>, String> {
        let state = self.state.lock().map_err(|_| "锁中毒")?;
        Ok(state.days.clone())
    }
}

impl LogState {
    fn persist(&mut self) {
        let file = LogFile { version: VERSION, days: self.days.clone() };
        let Ok(text) = serde_json::to_string_pretty(&file) else {
            tracing::error!(target: "reviewlog", "序列化失败");
            return;
        };
        if let Err(error) = crate::fsutil::write_atomic(&self.path, &text) {
            tracing::error!(target: "reviewlog", error = %error, "review-log.json 落盘失败");
        }
    }
}

/// 本地时区日期键 `YYYY-MM-DD`（GetLocalTime 无时区换算；前端聚合同用本地时区）
pub fn today_key() -> String {
    // SAFETY: 无参数本地时间查询
    let st: SYSTEMTIME = unsafe { GetLocalTime() };
    format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "onedict-reviewlog-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn record_aggregates_by_day_and_persists() {
        let dir = temp_dir("agg");
        let store = ReviewLogStore::open(&dir);

        store.record("good", "2026-09-05");
        store.record("good", "2026-09-05");
        store.record("again", "2026-09-05");
        store.record("easy", "2026-09-04");
        store.record("invalid", "2026-09-05"); // 非法评分：不记不落盘

        let snap = store.snapshot().unwrap();
        assert_eq!(snap.len(), 2);
        let d5 = &snap["2026-09-05"];
        assert_eq!((d5.again, d5.good), (1, 2));
        assert_eq!(snap["2026-09-04"].easy, 1);

        // 重开（模拟重启）→ 数据仍在，字段形状正确
        let reopened = ReviewLogStore::open(&dir);
        let snap2 = reopened.snapshot().unwrap();
        assert_eq!(snap2, snap);
        let text = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        for field in ["\"version\"", "\"days\"", "\"again\"", "\"hard\"", "\"good\"", "\"easy\""] {
            assert!(text.contains(field), "缺少字段 {field}");
        }
    }

    #[test]
    fn corrupt_file_moves_aside_and_starts_empty() {
        let dir = temp_dir("corrupt");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, "{ not json").unwrap();

        let store = ReviewLogStore::open(&dir);
        assert!(store.snapshot().unwrap().is_empty(), "损坏 → 空载");
        assert!(!path.exists(), "损坏文件应被改名");
        assert!(dir.join("review-log.json.corrupt").exists());
    }

    #[test]
    fn unexpected_version_starts_empty() {
        let dir = temp_dir("version");
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, r#"{"version":99,"days":{}}"#).unwrap();

        let store = ReviewLogStore::open(&dir);
        assert!(store.snapshot().unwrap().is_empty(), "version 不符 → 空载");
        assert!(path.exists(), "原文件保留（warn，不删除）");
    }

    #[test]
    fn reload_from_replaces_state() {
        let dir = temp_dir("reload");
        let store = ReviewLogStore::open(&dir);
        store.record("good", "2026-09-05");

        let other = temp_dir("reload-src");
        std::fs::write(
            other.join(FILE_NAME),
            r#"{"version":1,"days":{"2026-01-01":{"again":3,"hard":0,"good":0,"easy":0}}}"#,
        )
        .unwrap();
        store.reload_from(other.join(FILE_NAME)).unwrap();

        let snap = store.snapshot().unwrap();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap["2026-01-01"].again, 3, "恢复后整 state 替换");
    }
}
