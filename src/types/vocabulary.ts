/**
 *  生词卡类型（对应 src-tauri/src/vocabulary/mod.rs 与 unitlog.rs 命令出入参）。
 * 基础字段与 pickdict IPC schema 一致；后加字段在 Rust 侧一律 serde default，
 * 旧数据文件（含 pickdict 互迁）读取时自动补默认值。
 */

export type ReviewGrade = "again" | "hard" | "good" | "easy";

export interface VocabularyEntry {
  id: string;
  /** 用户原样添加的词头（仅 trim/空白归一化） */
  word: string;
  /** 查重键：小写归一化（可迁 SQLite 唯一索引） */
  normKey: string;
  note: string;
  /** 所属单元（收词箱 = "inbox"） */
  unitId: string;
  addedAt: number;
  /** SM-2 状态 */
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  dueAt: number;
  lastReviewedAt: number | null;
  reviewCount: number;
  lapses: number;
  /** 最近一次评分（不确定词判定用；旧数据为 null） */
  lastGrade: ReviewGrade | null;
}

/** 单元来源：手工创建 / 自动聚合 */
export type UnitKind = "manual" | "auto";
/** 单元状态：进行中 / 已毕业 / 暂停 */
export type UnitStatus = "active" | "done" | "paused";

/** 学习单元（收词箱为保留 id "inbox"，不在此列表，前端固定渲染） */
export interface VocabularyUnit {
  id: string;
  name: string;
  createdAt: number;
  kind: UnitKind;
  /** 生词上限（0 = 不限）；自动分组按此拆包 */
  capacity: number;
  status: UnitStatus;
  /** 当前复习轮次（0 = 未开始，每完成一轮 +1） */
  round: number;
  lastCompletedAt: number | null;
  /** 聚合规则标识（分组依据展示 / 重算） */
  seed: string | null;
  /** 手改过 → 自动重跑不覆盖 */
  locked: boolean;
  /** 显示序（0 = 按创建序） */
  order: number;
}

/** 单元容量默认值（Rust `DEFAULT_UNIT_CAPACITY`） */
export const DEFAULT_UNIT_CAPACITY = 20;

/** 收词箱保留 id（Rust `INBOX_UNIT_ID`） */
export const INBOX_UNIT_ID = "inbox";

/** vocabulary_review 提交的调度结果（SM-2 在前端 applySm2 计算，见 src/services/sm2.ts） */
export interface ScheduleUpdate {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  lapses: number;
  dueAt: number;
  lastReviewedAt: number | null;
  /** 复习评分（学习统计：Rust 侧记入 review-log.json；缺省 = 不记） */
  grade?: ReviewGrade;
}

/** review-log.json 单日计数（Rust DayCount，见 src/lib/stats.ts） */
export interface ReviewDayCount {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

/** 单元复习轮次记录（Rust unitlog::RoundRecord） */
export interface RoundRecord {
  unitId: string;
  unitName: string;
  round: number;
  startedAt: number;
  completedAt: number;
  /** 本轮入场词数 */
  size: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  /** 结束时仍未通过（「重来」后未再评上）的词数 */
  againPending: number;
}

/** 单元抽查记录（Rust unitlog::CheckRecord） */
export interface CheckRecord {
  unitId: string;
  at: number;
  sampled: number;
  /** 抽查中评「重来/困难」的词 */
  missed: string[];
}

/** 智能分组批次（Rust unitlog::GroupRecord；撤销依据） */
export interface GroupRecord {
  at: number;
  unitIds: string[];
  entryCount: number;
}

/** unit-log.json 全量快照（Rust unitlog::UnitLogSnapshot） */
export interface UnitLogSnapshot {
  rounds: RoundRecord[];
  checks: CheckRecord[];
  groups: GroupRecord[];
}

/** 复习轮次提交（Rust vocabulary::RoundRecordInput；completedAt / unitName 由存储侧补全） */
export interface RoundCommit {
  round: number;
  startedAt: number;
  size: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  againPending: number;
  /** 毕业规则给出的新状态；缺省 = 保持 */
  status?: UnitStatus;
}
