/**
 *  生词卡类型（对应 src-tauri/src/vocabulary/mod.rs 命令出入参）。
 * 字段与 pickdict IPC schema（src/shared/ipc/schemas/vocabulary.ts）一致；
 * zod 校验层由 Rust serde 承担，这里只保留类型。
 */

export type ReviewGrade = "again" | "hard" | "good" | "easy";

export interface VocabularyEntry {
  id: string;
  /** 用户原样添加的词头（仅 trim/空白归一化） */
  word: string;
  /** 查重键：小写归一化（可迁 SQLite 唯一索引） */
  normKey: string;
  note: string;
  /** 所属单元（收词箱 = "inbox"，Rust 侧 serde default 兜底） */
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
}

/** 学习单元（收词箱为保留 id "inbox"，不在此列表，前端固定渲染） */
export interface VocabularyUnit {
  id: string;
  name: string;
  createdAt: number;
}

/** 收词箱保留 id（Rust INBOX_UNIT_ID） */
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
