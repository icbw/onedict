/**
 * 单元复习计划与进度（纯函数）。
 *
 * - 今日计划：按到期密度 / 逾期度 / 进行中 / 今日已复习 / 不确定占比打分，取前 N 个单元；
 * - 会话选词：到期词优先 → 不确定词补齐 → 维持性抽查（占比上限，防只练到期不复习旧词）；
 * - 不确定词：`lastGrade ∈ {again, hard}` 或 `lapses ≥ 2`（纯派生，不新增调度字段）；
 * - 毕业：连续 2 轮零遗留（again = 0 且无队尾遗留）+ 熟练词（repetitions ≥ 3）占比 ≥ 80%。
 *
 * 掌握度仍由 SM-2（`src/services/sm2.ts`）单一事实源决定，本模块只决定「复习什么、什么顺序」。
 *
 * 行为基线：node test/reviewplan.mjs
 */
import type {
  CheckRecord,
  ReviewGrade,
  RoundRecord,
  VocabularyEntry,
  VocabularyUnit,
} from "../types/vocabulary";

/**
 * 一日毫秒与「今日零点」在本模块内自持：`node test/reviewPlan.mjs` 直接按路径执行 .ts
 * （strip-types），运行时跨文件导入需要显式扩展名，而本仓惯例是不带扩展名
 * ——故常量与工具内联，值域与 `services/sm2.ts`、`lib/stats.ts` 保持一致。
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 本地「今日起点」（0 点） */
function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 不确定词判定：最近一次评分偏低，或遗忘次数偏高 */
export function isUnsure(entry: {
  lastGrade: ReviewGrade | null;
  lapses: number;
}): boolean {
  return entry.lastGrade === "again" || entry.lastGrade === "hard" || entry.lapses >= 2;
}

/** 熟练阈值（毕业判定与抽查池共用：SM-2 第 3 次通过后的间隔拉伸阶段） */
export const MASTERED_REPETITIONS = 3;

/** 单元今日计划条目（已有单元 + 派生统计） */
export interface UnitStat {
  id: string;
  name: string;
  /** 单元词数 */
  size: number;
  /** 到期词数 */
  dueCount: number;
  /** 最逾期天数（无到期词 = 0） */
  overdueDays: number;
  status: VocabularyUnit["status"];
  /** 当前轮次（0 = 未开始） */
  round: number;
  lastCompletedAt: number | null;
  /** 不确定词数 */
  unsureCount: number;
  /** 今日已复习过（单元内任一词今日有复习记录） */
  reviewedToday: boolean;
}

/**
 * 单元打分：到期密度为主（3×），逾期度与进行中次之，今日已复习过降权、不确定占比加权。
 * 已毕业单元不进计划（由调用方过滤）。
 */
export function unitScore(stat: UnitStat): number {
  if (stat.size === 0) return Number.NEGATIVE_INFINITY;
  const density = stat.dueCount / stat.size;
  const overdue = Math.min(stat.overdueDays, 7) / 7;
  const unsure = stat.unsureCount / stat.size;
  return (
    3 * density +
    1.5 * overdue +
    (stat.round > 0 ? 1 : 0) -
    (stat.reviewedToday ? 0.8 : 0) +
    0.5 * unsure
  );
}

/** 今日计划：可复习单元打分排序取前 max 个（已毕业 / 空单元排除） */
export function planUnits(stats: UnitStat[], max = 3): UnitStat[] {
  return stats
    .filter((s) => s.status !== "done" && s.size > 0)
    .map((s) => ({ stat: s, score: unitScore(s) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((entry) => entry.stat);
}

/** 由单元 / 词表派生统计（UI 与打分共用；checks 预留） */
export function buildUnitStats(
  units: VocabularyUnit[],
  entries: VocabularyEntry[],
  now = Date.now(),
): UnitStat[] {
  const todayStart = startOfToday(now);
  return units.map((unit) => {
    const own = entries.filter((e) => e.unitId === unit.id);
    const due = own.filter((e) => e.dueAt <= now);
    const oldestDue = due.length ? Math.min(...due.map((e) => e.dueAt)) : 0;
    return {
      id: unit.id,
      name: unit.name,
      size: own.length,
      dueCount: due.length,
      overdueDays: due.length ? Math.max(0, (now - oldestDue) / DAY_MS) : 0,
      status: unit.status,
      round: unit.round,
      lastCompletedAt: unit.lastCompletedAt,
      unsureCount: own.filter(isUnsure).length,
      reviewedToday: own.some((e) => e.lastReviewedAt != null && e.lastReviewedAt >= todayStart),
    };
  });
}

export interface QueueOptions {
  /** 单次会话入场词上限（默认 20） */
  batchSize?: number;
  now?: number;
  /** 维持性抽查占比上限（默认 0.2） */
  sampleRatio?: number;
  /** 随机源（测试可注入） */
  random?: () => number;
}

export interface SessionQueue {
  queue: VocabularyEntry[];
  /** 无到期词 → 提前练习（保留「重复练习」语义，仍按正常 SM-2 评分） */
  repeat: boolean;
}

/**
 * 会话选词：到期词（dueAt 升序，最逾期在前）→ 不确定词（遗忘多者优先）→ 熟词抽查。
 * 范围内无到期词时回退为全量提前练习。
 */
export function pickQueue(entries: VocabularyEntry[], options: QueueOptions = {}): SessionQueue {
  const batchSize = options.batchSize ?? 20;
  const now = options.now ?? Date.now();
  const sampleRatio = options.sampleRatio ?? 0.2;
  const random = options.random ?? Math.random;
  if (entries.length === 0) return { queue: [], repeat: false };

  const due = entries.filter((e) => e.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  if (due.length === 0) {
    return {
      queue: [...entries].sort((a, b) => a.dueAt - b.dueAt || a.addedAt - b.addedAt),
      repeat: true,
    };
  }

  const queue = due.slice(0, batchSize);
  const chosen = new Set(queue.map((e) => e.id));

  if (queue.length < batchSize) {
    const unsure = entries
      .filter((e) => !chosen.has(e.id) && isUnsure(e))
      .sort((a, b) => b.lapses - a.lapses || a.dueAt - b.dueAt);
    for (const entry of unsure) {
      if (queue.length >= batchSize) break;
      queue.push(entry);
      chosen.add(entry.id);
    }
  }

  const sampleCap = Math.floor(batchSize * sampleRatio);
  const room = batchSize - queue.length;
  if (room > 0 && sampleCap > 0) {
    const pool = entries.filter(
      (e) => !chosen.has(e.id) && e.repetitions >= MASTERED_REPETITIONS,
    );
    for (const entry of shuffle(pool, random).slice(0, Math.min(sampleCap, room))) {
      queue.push(entry);
    }
  }
  return { queue, repeat: false };
}

/** 抽查抽样：从已学词（repetitions ≥ 1）里随机取 count 个；不足则全取 */
export function pickCheckSample(
  entries: VocabularyEntry[],
  count: number,
  random: () => number = Math.random,
): VocabularyEntry[] {
  const pool = entries.filter((e) => e.repetitions >= 1);
  return shuffle(pool, random).slice(0, Math.max(0, count));
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 毕业判定：该单元最近 2 轮均零遗留（again = 0 且 againPending = 0），
 * 且熟练词（repetitions ≥ MASTERED_REPETITIONS）占单元词数 ≥ 80%。
 */
export function shouldGraduate(
  rounds: RoundRecord[],
  unitId: string,
  mastered: number,
  size: number,
): boolean {
  if (size === 0) return false;
  const recent = rounds
    .filter((r) => r.unitId === unitId)
    .sort((a, b) => a.round - b.round)
    .slice(-2);
  if (recent.length < 2) return false;
  if (recent.some((r) => r.again > 0 || r.againPending > 0)) return false;
  return mastered / size >= 0.8;
}

/** 单元最近一次抽查（UI 提示「久未抽查」用） */
export function lastCheckOf(checks: CheckRecord[], unitId: string): CheckRecord | null {
  let latest: CheckRecord | null = null;
  for (const check of checks) {
    if (check.unitId !== unitId) continue;
    if (!latest || check.at > latest.at) latest = check;
  }
  return latest;
}
