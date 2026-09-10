/**
 * SuperMemo-2 调度（经典 SM-2 算法）。
 * // from pickdict (MIT), adapted for Tauri —— 逐字节复制
 * （pickdict src/main/services/vocabulary/sm2.ts；纯函数零依赖，无传输层可剥）。
 *
 * onedict 架构差异：调度单一事实源在前端 renderer，
 * Rust 存储命令 vocabulary_review 只接收 applySm2 的结果做持久化。
 *
 * 四档评分映射原始 0–5 质量分：again=2 / hard=3 / good=4 / easy=5（Anki 风格）。
 * - q≥3：repetitions 0→1 天、1→6 天、之后 interval × EF（hard 因 EF 下调自然变短）
 * - q<3（again）：repetitions 清零记一次遗忘，interval 回到 1 天
 * - EF 每次 按公式调整，下限 1.3
 *
 * 行为基线：node test/sm2.mjs
 */

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'

const GRADE_QUALITY: Record<ReviewGrade, number> = {
  again: 2,
  hard: 3,
  good: 4,
  easy: 5
}

export const DAY_MS = 24 * 60 * 60 * 1000

export interface SchedulingState {
  easeFactor: number
  intervalDays: number
  repetitions: number
  lapses: number
}

export interface ScheduledState extends SchedulingState {
  dueAt: number
  lastReviewedAt: number
}

export function applySm2(state: SchedulingState, grade: ReviewGrade, now = Date.now()): ScheduledState {
  const q = GRADE_QUALITY[grade]
  let easeFactor = state.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  if (easeFactor < 1.3) easeFactor = 1.3

  let intervalDays: number
  let repetitions = state.repetitions
  let lapses = state.lapses

  if (q < 3) {
    repetitions = 0
    lapses += 1
    intervalDays = 1
  } else {
    repetitions += 1
    if (repetitions === 1) intervalDays = 1
    else if (repetitions === 2) intervalDays = 6
    else intervalDays = Math.round(state.intervalDays * easeFactor)
  }

  return {
    easeFactor,
    intervalDays,
    repetitions,
    lapses,
    dueAt: now + intervalDays * DAY_MS,
    lastReviewedAt: now
  }
}
