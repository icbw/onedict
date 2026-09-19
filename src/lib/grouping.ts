/**
 * 生词自动聚合（单元划分纯函数）。
 *
 * 目标：把散落生词整理成「有容量上限的单元」，不依赖手工划分。分层信号（确定性优先）：
 * - L0 时间批次：addedAt 间隔 > batchGapMs 切开，同批贪心装箱到容量上限；
 * - L1 词形族：并查集聚类——共享前缀 ≥ minPrefix 且长度比 ≥ 0.6，或编辑距离 ≤ 2（短词）；
 * - 命名：词形族取全族最长公共前缀（不足 minPrefix 退化为「词形相近」），批次取起始日期。
 *
 * 边界：只读传入词表（调用方决定范围）/ 不读写存储——落盘走 Rust `vocabulary_group_apply`
 * （全量校验后一次落盘），撤销走 `vocabulary_group_undo`。
 *
 * 行为基线：node test/grouping.mjs
 */

export interface GroupingEntry {
  id: string;
  word: string;
  addedAt: number;
}

/** 一组聚合结果（直接映射为 GroupSpec：name / seed / entryIds） */
export interface GroupPlan {
  /** 单元名（含词数与分组依据，落库即展示） */
  name: string;
  /** 聚合规则标识：`morph:<前缀>` / `batch:<起始毫秒>` */
  seed: string;
  entryIds: string[];
}

export interface GroupingOptions {
  /** 单元生词上限（默认 20） */
  capacity?: number;
  /** 时间批次切分间隔（默认 30 分钟） */
  batchGapMs?: number;
  /** 词形族共享前缀长度下限（默认 4） */
  minPrefix?: number;
  /** 短词编辑距离阈值（默认 2） */
  maxDistance?: number;
}

export const DEFAULT_CAPACITY = 20;
const DEFAULT_BATCH_GAP_MS = 30 * 60 * 1000;
const DEFAULT_MIN_PREFIX = 4;
const DEFAULT_MAX_DISTANCE = 2;
/** 短词放宽编辑距离的长度上限（长词只认前缀，避免误并） */
const SHORT_WORD_LEN = 8;

/** 词形比较用归一：小写 + 去空白与连字符 */
function shapeOf(word: string): string {
  return word.toLowerCase().replace(/[\s-]+/g, "");
}

/** 最长公共前缀长度 */
export function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** 编辑距离（滚动数组；词表内两两比较，规模足够小） */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length];
}

/** 词形相近判定：长度比下限 + （共享前缀 或 短词编辑距离） */
export function isMorphNeighbor(
  a: string,
  b: string,
  minPrefix = DEFAULT_MIN_PREFIX,
  maxDistance = DEFAULT_MAX_DISTANCE,
): boolean {
  if (!a || !b) return false;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter / longer < 0.6) return false;
  if (commonPrefixLength(a, b) >= minPrefix) return true;
  const limit = shorter <= SHORT_WORD_LEN ? maxDistance : 1;
  return levenshtein(a, b) <= limit;
}

/** 并查集（族聚类用） */
class UnionFind {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let cursor = x;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor];
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** 全族长公共前缀 */
function commonPrefixOfAll(shapes: string[]): string {
  let prefix = shapes[0] ?? "";
  for (const s of shapes.slice(1)) {
    prefix = prefix.slice(0, commonPrefixLength(prefix, s));
    if (!prefix) break;
  }
  return prefix;
}

/** 按容量切块（保序） */
function chunkByCapacity(indexes: number[], capacity: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < indexes.length; i += capacity) out.push(indexes.slice(i, i + capacity));
  return out;
}

/** 按时间间隔切段（保序，入参须按 addedAt 升序） */
function splitByTimeGap(
  indexes: number[],
  entries: GroupingEntry[],
  gapMs: number,
): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  for (const i of indexes) {
    if (current.length > 0) {
      const prev = entries[current[current.length - 1]].addedAt;
      if (entries[i].addedAt - prev > gapMs) {
        out.push(current);
        current = [];
      }
    }
    current.push(i);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** 本地日期 `MM-DD`（批次命名；与统计同用本地时区） */
function monthDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 重名递增命名：`词根 pre-（12 词）` → 第二组 `词根 pre- 2（12 词）` */
function named(base: string, count: number, used: Map<string, number>): string {
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  const label = seen === 0 ? base : `${base} ${seen + 1}`;
  return `${label}（${count} 词）`;
}

/**
 * 生成分组计划（纯函数，无副作用）。
 * 族优先（多词成族），剩余词按时间批次装箱；族按成员数降序、批次按时间升序返回。
 */
export function planGroups(entries: GroupingEntry[], options: GroupingOptions = {}): GroupPlan[] {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const gapMs = options.batchGapMs ?? DEFAULT_BATCH_GAP_MS;
  const minPrefix = options.minPrefix ?? DEFAULT_MIN_PREFIX;
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  if (entries.length === 0 || capacity <= 0) return [];

  const shapes = entries.map((e) => shapeOf(e.word));
  const uf = new UnionFind(entries.length);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (isMorphNeighbor(shapes[i], shapes[j], minPrefix, maxDistance)) uf.union(i, j);
    }
  }

  const families = new Map<number, number[]>();
  entries.forEach((_, i) => {
    const root = uf.find(i);
    const list = families.get(root);
    if (list) list.push(i);
    else families.set(root, [i]);
  });

  const used = new Map<string, number>();
  const plans: GroupPlan[] = [];
  const singles: number[] = [];
  const familyChunks: Array<{ size: number; prefix: string; chunk: number[] }> = [];

  for (const members of families.values()) {
    if (members.length < 2) {
      singles.push(members[0]);
      continue;
    }
    const ordered = [...members].sort((a, b) => entries[a].addedAt - entries[b].addedAt);
    const prefix = commonPrefixOfAll(ordered.map((i) => shapes[i]));
    for (const chunk of chunkByCapacity(ordered, capacity)) {
      familyChunks.push({ size: members.length, prefix, chunk });
    }
  }
  familyChunks.sort((a, b) => b.size - a.size);

  for (const { prefix, chunk } of familyChunks) {
    const seed = `morph:${prefix || "similar"}`;
    const base = prefix.length >= minPrefix ? `${prefix}- 词族` : "词形相近";
    plans.push({
      name: named(base, chunk.length, used),
      seed,
      entryIds: chunk.map((i) => entries[i].id),
    });
  }

  const rest = singles.sort((a, b) => entries[a].addedAt - entries[b].addedAt);
  for (const batch of splitByTimeGap(rest, entries, gapMs)) {
    const startAt = entries[batch[0]].addedAt;
    for (const chunk of chunkByCapacity(batch, capacity)) {
      plans.push({
        name: named(`${monthDay(startAt)} 收词`, chunk.length, used),
        seed: `batch:${startAt}`,
        entryIds: chunk.map((i) => entries[i].id),
      });
    }
  }
  return plans;
}
