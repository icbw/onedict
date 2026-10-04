/**
 * 语境句挖空（复习卡正面 M3）：词形切片替换为空格占位，用户在原句语境中回忆
 * 遇到的那个词形。
 *
 * `wordOffset` 是 Rust 侧扩句时算好的 UTF-16 code unit 偏移（`[start, end)`），
 * 与 JS 字符串索引天然同单位——**不做 indexOf 事后查找**：词形多次出现时
 * indexOf 永远命中最先出现处，且归一化差异（NBSP / 组合字符）会让两者对不上。
 *
 * 纯函数，无 React 依赖——`node test/vocabContext.mjs` 基线覆盖。
 */

/** 挖空占位符（三下划线；不成词、视觉宽度稳定） */
export const MASK_TOKEN = "___";

/**
 * 语境句挖空：offset 有效 → 词形区间替换为 `___`；offset 缺失 / 越界 / 颠倒 →
 * 原句原样返回（降级为「读整句但不挖空」，复习仍可用）。
 */
export function maskSentence(sentence: string, wordOffset: [number, number] | null): string {
  if (!wordOffset) return sentence;
  const [start, end] = wordOffset;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return sentence;
  if (start < 0 || end <= start || end > sentence.length) return sentence;
  return sentence.slice(0, start) + MASK_TOKEN + sentence.slice(end);
}

/**
 * 语境句高亮区间提取（背面置顶卡：原句 + 词形标色对照）。
 * 返回 null = 无有效区间（整句平铺，不着色）；边界校验与 maskSentence 同口径。
 */
export function sentenceHighlight(
  sentence: string,
  wordOffset: [number, number] | null,
): { before: string; hit: string; after: string } | null {
  if (!wordOffset) return null;
  const [start, end] = wordOffset;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end <= start || end > sentence.length) return null;
  return {
    before: sentence.slice(0, start),
    hit: sentence.slice(start, end),
    after: sentence.slice(end),
  };
}
