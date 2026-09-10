/**
 * OCR AI 回填对齐：
 * AI 文本准、本地 rect 准——行数不一致时做文本-位置融合而非放弃叠加。
 *
 * - L1 黄金路径：AI 行数 = 本地行数 → 索引一一替换（既有语义零变化）
 * - L2 坐标直用（解耦）：结构化模型（qwen3.5-ocr 族）自带
 *   rotate_rect 归一化 0-1000 坐标——**本地无行时直接换算建行，不依赖系统
 *   OCR**（本地有行仍走 L1/L3：本地 rect 实测可靠优先）。格式防御 = 全部项
 *   换算有效才走 L2，任一异常整体降级（归一化假设未实机验证标定，保守）
 * - L3 对齐+插值：字符相似度保序 DP（Needleman-Wunsch 变体，gap 罚 0）建锚
 *   （AI 文本 ↔ 本地 rect），锚间插值补位（双锚间隙均分 / 尾部中位行距递推 /
 *   头部反向），本地保留行按 rect 插回，输出视觉序；无锚 = 零 rect 兜底
 *   （本地空的既有语义）
 * - 估算行带 `est` 标记（渲染层无差异，实机验证排错区分 rect 来源）
 *
 * 纯函数零依赖；对齐规模上限保护（超出走零 rect，防极端长文档性能）。
 */

/** 融合输出行（与渲染层 OcrLine 同构；x/y/w/h = 屏幕物理坐标） */
export interface MergedLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 位置为估算（双锚插值 / 行距递推）；渲染层不消费 */
  est?: boolean;
}

/** AI 识别项（提取层输出）：string = 纯文本兼容旧调用/测试基线；rect = 模型
 *  自带坐标（rotate_rect 归一化 0-1000 [cx,cy,w,h,(angle)]，lineTranslate
 *  extractOcrItems 保留） */
export interface AiItemLike {
  text: string;
  rect?: number[];
}

interface LocalLineLike {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RegionLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 对齐规模上限（m×n 超出 = 极端长文档，跳过对齐直接零 rect） */
const MAX_PAIRS = 200 * 200;
/** 常规行锚相似度阈值（容忍本地错字——「AI 文本准」即存在若干字符差异） */
const SIM_THRESHOLD = 0.45;
/** 短文本阈值（防「是/否」类 1-2 字行互配；3 字及以上走常规阈值——3 字短语
 * 单错字 sim 0.67 须容忍） */
const SHORT_SIM_THRESHOLD = 0.65;
const SHORT_TEXT_MAX = 2;
/** 长度差剪枝（差异过大直接不配对） */
const LEN_DIFF_CUT = 0.6;
/** 估算兜底尺寸（本地统计完全缺失时） */
const FALLBACK_H = 12;
const FALLBACK_CHAR_W = 8;

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev;
    prev = curr;
    curr = t;
  }
  return prev[n];
}

/** 锚相似度：低于阈值记 0（不构成锚，落入 gap 由插值处理） */
function pairSim(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  if (Math.abs(la - lb) / Math.max(la, lb) > LEN_DIFF_CUT) return 0;
  const s = 1 - levenshtein(a, b) / Math.max(la, lb);
  const theta = Math.min(la, lb) <= SHORT_TEXT_MAX ? SHORT_SIM_THRESHOLD : SIM_THRESHOLD;
  return s >= theta ? s : 0;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** rotate_rect 归一化基准（qwen 系 0-1000）；分量超界 = 归一化假设不成立 */
const RECT_NORM = 1000;

/** L2 坐标直用：**全部项**带 rect 且全部换算有效才返回行（任一异常 = 格式
 *  保守降级返回 null，走后续路径）。rotate_rect = [cx,cy,w,h,(angle)] 归一化
 *  0-1000 → 屏幕物理坐标：AI 输入图 = 快照保比例缩放，归一化与缩放无关直接
 *  线性映射 region。
 *  **旋转框语义（实机验证双模型标定）**：中心点 cx/cy ✓；w 沿**文本
 *  方向**、angle = 行旋转角——angle 竖排（90°±45°）时轴对齐渲染框 **w/h 互换**
 *  （qwen-vl-ocr 实测：横排中文行 angle=90 输出 w=行高 h=行长，不互换 = 窄条
 *  竖块跑位；qwen3.5-ocr 同构。angle 仅用于交换判定，不做仿射渲染）。 */
function directLines(items: AiItemLike[], region: RegionLike): MergedLine[] | null {
  if (!items.length || !region.w || !region.h) return null;
  const out: MergedLine[] = [];
  for (const it of items) {
    const r = it.rect;
    if (!r || r.length < 4) return null;
    const [cx, cy, rw, rh] = r;
    if ([cx, cy, rw, rh].some((v) => !Number.isFinite(v) || v < 0 || v > RECT_NORM)) return null;
    const rawAngle = r.length > 4 && Number.isFinite(r[4]) ? r[4] : 0;
    const norm = ((rawAngle % 180) + 180) % 180;
    const vertical = norm >= 45 && norm <= 135;
    const w = vertical ? rh : rw;
    const h = vertical ? rw : rh;
    const pw = (w / RECT_NORM) * region.w;
    const ph = (h / RECT_NORM) * region.h;
    if (pw <= 0 || ph <= 0) return null;
    out.push({
      text: it.text,
      x: region.x + (cx / RECT_NORM) * region.w - pw / 2,
      y: region.y + (cy / RECT_NORM) * region.h - ph / 2,
      w: pw,
      h: ph,
    });
  }
  return out;
}

/**
 * 文本-位置融合入口。
 * - `aiItems`：AI 识别项（阅读序，提取层已清洗；string 兼容 = 纯文本，rect = 结构化坐标）
 * - `localLines`：本地 OCR 行（rect 为屏幕物理坐标；words 为空的行 = 全 0）
 * - `region`：选区屏幕物理坐标（L2 换算基准 / 插值钳制基准）
 */
export function mergeOcrResult(
  aiItems: ReadonlyArray<string | AiItemLike>,
  localLines: LocalLineLike[],
  region: RegionLike,
): MergedLine[] {
  // string 兼容归一化（测试基线直传 string[]）
  const items: AiItemLike[] = aiItems.map((it) => (typeof it === "string" ? { text: it } : it));
  const m = items.length;
  const n = localLines.length;
  if (!m) return localLines.map((l) => ({ ...l }));
  // L1 黄金路径：行数一致一一替换（AI 断行与本地一致）
  if (n > 0 && m === n) {
    return localLines.map((l, i) => ({ ...l, text: items[i]?.text ?? l.text }));
  }
  // 本地空 / 规模保护：AI 文本为准零 rect（渲染层既有 w/h<=0 跳过）
  if (n === 0 || m * n > MAX_PAIRS) {
    // L2 坐标直用：本地空 = 结构化模型独立路径（解耦——
    // qwen3.5-ocr 族自带坐标，识别不依赖系统 OCR）
    if (n === 0) {
      const direct = directLines(items, region);
      if (direct) return direct;
    }
    return items.map((it) => ({ text: it.text, x: 0, y: 0, w: 0, h: 0 }));
  }

  // ---- L3 对齐 ----
  // 预计算相似度矩阵（回溯复用，避免双算）
  const cost = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    const a = items[i].text.trim();
    for (let j = 0; j < n; j++) cost[i * n + j] = pairSim(a, localLines[j].text.trim());
  }
  // NW 保序 DP（gap 罚 0：AI 漏行 / 本地漏行均不罚，锚纯由相似度驱动）
  const W = n + 1;
  const dp = new Float64Array((m + 1) * W);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i * W + j] = Math.max(
        dp[(i - 1) * W + (j - 1)] + cost[(i - 1) * n + (j - 1)],
        dp[(i - 1) * W + j],
        dp[i * W + (j - 1)],
      );
    }
  }
  // 回溯取锚（对角优先：c>0 才记锚；浮点等值比较 = 同一表达式路径，安全）
  const pairs: Array<{ ai: number; li: number }> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const c = cost[(i - 1) * n + (j - 1)];
    if (c > 0 && dp[i * W + j] === dp[(i - 1) * W + (j - 1)] + c) {
      pairs.push({ ai: i - 1, li: j - 1 });
      i--;
      j--;
    } else if (dp[i * W + j] === dp[(i - 1) * W + j]) i--;
    else j--;
  }
  pairs.reverse();
  if (!pairs.length) {
    // 全不匹配：AI 文本为准零 rect（与本地空同语义）
    return items.map((it) => ({ text: it.text, x: 0, y: 0, w: 0, h: 0 }));
  }

  // ---- 插值统计量（本地行几何中位数）----
  const hMed = median(localLines.filter((l) => l.h > 0).map((l) => l.h)) || FALLBACK_H;
  const leads: number[] = [];
  for (let j2 = 1; j2 < n; j2++) {
    const d = localLines[j2].y - localLines[j2 - 1].y;
    if (d > 0) leads.push(d);
  }
  const lead = median(leads) || hMed;
  const charW =
    median(
      localLines
        .filter((l) => l.w > 0 && l.text.trim())
        .map((l) => l.w / Math.max(l.text.trim().length, 1)),
    ) || FALLBACK_CHAR_W;
  const estW = (text: string) =>
    Math.min(Math.max(text.trim().length * charW, 8), Math.max(region.w, 8));
  const clamp = (l: MergedLine): MergedLine => {
    if (region.w <= 0 || region.h <= 0) return l;
    const w = Math.min(l.w, region.w);
    const h = Math.min(l.h, region.h);
    return {
      ...l,
      x: Math.min(Math.max(l.x, region.x), region.x + region.w - w),
      y: Math.min(Math.max(l.y, region.y), region.y + region.h - h),
      w,
      h,
    };
  };

  /** 段内 AI 未锚行位置估算：双锚间隙按位均分，退化（无上锚/间隙非正）走上锚
   *  行距递推，头部段按下锚反向递推 */
  const interpolate = (aiIdxs: number[], prevLi: number | null, nextLi: number | null): MergedLine[] => {
    const k = aiIdxs.length;
    const out: MergedLine[] = [];
    for (let s = 1; s <= k; s++) {
      const text = items[aiIdxs[s - 1]].text;
      const w = estW(text);
      let x = 0;
      let y = 0;
      let h = hMed;
      let placed = false;
      if (prevLi !== null && nextLi !== null) {
        const top = localLines[prevLi].y + localLines[prevLi].h;
        const bottom = localLines[nextLi].y;
        if (bottom > top) {
          h = Math.max(1, Math.min(hMed, (bottom - top) / k - 2));
          y = top + ((bottom - top) * s) / (k + 1) - h / 2;
          x = localLines[prevLi].x + ((localLines[nextLi].x - localLines[prevLi].x) * s) / (k + 1);
          out.push(clamp({ text, x, y, w, h, est: true }));
          placed = true;
        }
        // 间隙非正（本地行重叠/异常）→ 退化走下锚上方递推
      }
      if (!placed) {
        if (prevLi !== null) {
          const top = localLines[prevLi].y + localLines[prevLi].h;
          y = top + s * lead;
          x = localLines[prevLi].x;
        } else if (nextLi !== null) {
          y = localLines[nextLi].y - (k - s + 1) * lead;
          x = localLines[nextLi].x;
        }
        out.push(clamp({ text, x, y, w, h, est: true }));
      }
    }
    return out;
  };

  // ---- 装配（视觉序：锚行 + 段内[本地保留行 + AI 插值行]按 y 合并）----
  const out: MergedLine[] = [];
  let liCursor = 0;
  /** [liCursor, untilLi) 内未锚本地行 = 保留行（AI 漏行不删本地结果） */
  const keptInRange = (untilLi: number): MergedLine[] => {
    const kept: MergedLine[] = [];
    while (liCursor < untilLi) {
      if (!pairs.some((p) => p.li === liCursor)) kept.push({ ...localLines[liCursor] });
      liCursor++;
    }
    return kept;
  };
  const emitSegment = (
    kept: MergedLine[],
    aiIdxs: number[],
    prevLi: number | null,
    nextLi: number | null,
  ) => {
    if (!kept.length && !aiIdxs.length) return;
    const seg = [...kept, ...interpolate(aiIdxs, prevLi, nextLi)];
    seg.sort((a, b) => a.y - b.y);
    out.push(...seg);
  };
  const rangeIdx = (from: number, to: number) => {
    const idxs: number[] = [];
    for (let a = from; a < to; a++) idxs.push(a);
    return idxs;
  };

  // 头部段（首锚之前）
  {
    const first = pairs[0];
    emitSegment(keptInRange(first.li), rangeIdx(0, first.ai), null, first.li);
  }
  for (let p = 0; p < pairs.length; p++) {
    const pr = pairs[p];
    // 锚行：AI 文本替换、本地 rect 沿用
    out.push({ ...localLines[pr.li], text: items[pr.ai].text });
    liCursor = pr.li + 1;
    const next = pairs[p + 1];
    if (next) {
      emitSegment(keptInRange(next.li), rangeIdx(pr.ai + 1, next.ai), pr.li, next.li);
    } else {
      emitSegment(keptInRange(n), rangeIdx(pr.ai + 1, m), pr.li, null);
    }
  }
  return out;
}
