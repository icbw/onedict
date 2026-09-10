/**
 * 学习统计纯函数。
 *
 * 日期键 = 本地时区 `YYYY-MM-DD`，与 Rust `reviewlog::today_key`（GetLocalTime）
 * 同用本地时区——两端聚合不错位。所有函数收 `now` 参数（可测，无隐式全局时钟）。
 *
 * 行为基线：node test/stats.mjs
 */

/** review-log.json 单日计数（Rust DayCount，serde camelCase） */
export interface DayCount {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export type ReviewLog = Record<string, DayCount>;

/** 本地时区日期键 `YYYY-MM-DD` */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地「今日起点」（0 点） */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 最近 n 天日期键（升序，末位 = 今天；setDate 逐日递减规避夏令时偏移） */
export function lastNDays(n: number, now = Date.now()): string[] {
  const d = new Date(startOfToday(now));
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    keys.unshift(dayKeyOf(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return keys;
}

export interface ReviewDay extends DayCount {
  key: string;
  total: number;
}

/** 最近 n 天复习量序列（日志缺失日补零；升序，末位 = 今天） */
export function stackReviewDays(log: ReviewLog, n = 30, now = Date.now()): ReviewDay[] {
  return lastNDays(n, now).map((key) => {
    const c = log[key] ?? { again: 0, hard: 0, good: 0, easy: 0 };
    return { key, ...c, total: c.again + c.hard + c.good + c.easy };
  });
}

export interface DueDay {
  key: string;
  label: string;
  count: number;
}

/**
 * 未来 n 天到期分布：桶 0 = 今日（**含逾期**），桶 1..n-1 = 未来各日；
 * 超出范围（> 末桶）忽略。
 */
export function dueCountsByDay(
  entries: { dueAt: number }[],
  n = 14,
  now = Date.now(),
): DueDay[] {
  const out: DueDay[] = [];
  const d = new Date(startOfToday(now));
  for (let i = 0; i < n; i++) {
    const cur = new Date(d);
    cur.setDate(d.getDate() + i);
    out.push({ key: dayKeyOf(cur.getTime()), label: i === 0 ? "今日" : `+${i}`, count: 0 });
  }
  const idxByKey = new Map(out.map((b, i) => [b.key, i]));
  for (const e of entries) {
    const key = dayKeyOf(e.dueAt);
    let idx = idxByKey.get(key);
    if (idx === undefined) {
      idx = key < out[0].key ? 0 : -1; // 逾期并入今日；超出范围忽略
    }
    if (idx >= 0) out[idx].count++;
  }
  return out;
}

export interface StatusBuckets {
  /** 新词：从未复习 */
  fresh: number;
  /** 学习中：复习 1–2 次（SM-2 固定间隔阶段 1d/6d） */
  learning: number;
  /** 复习中：≥3 次（间隔按易度因子拉伸） */
  reviewing: number;
}

/** 记忆状态三桶（按 repetitions 划分） */
export function statusBuckets(entries: { repetitions: number }[]): StatusBuckets {
  const b: StatusBuckets = { fresh: 0, learning: 0, reviewing: 0 };
  for (const e of entries) {
    if (e.repetitions <= 0) b.fresh++;
    else if (e.repetitions <= 2) b.learning++;
    else b.reviewing++;
  }
  return b;
}
