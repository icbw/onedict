/**
 * 生词卡卡面组装纯函数（services/vocabCard.ts 的可测内核，无 React/Tauri 依赖，
 * node test/vocabCard.mjs 基线覆盖）：跨源释义合并（来源权重排序 + 同文去重 +
 * 条数钳制）、独立例句合并、AI 输出宽松解析。
 *
 * 释义来源权重（词典复用优先，AI 兜底）：
 * 本地 O8C（牛津高阶双解）→ 剑桥（义项绑定例句）→ 必应（中文释义串 + 例句区）
 * → 有道（简明释义）→ AI。
 */
import type { CardSentence, CardSense } from "../types/vocabulary";

/** 释义来源权重序（同权重按采集序） */
export const SOURCE_ORDER = ["O8C", "web-cambridge", "web-bing", "web-youdao", "ai"];

export function sourceRank(dictId: string): number {
  const i = SOURCE_ORDER.indexOf(dictId);
  return i < 0 ? SOURCE_ORDER.length : i;
}

/** 采集源（引擎结构化输出 / 本地提取器产出的同形数据） */
export interface SenseGroup {
  dictId: string;
  structured: {
    phonetic?: string;
    senses: Array<{
      pos: string;
      definition: string;
      definitionEn?: string;
      example?: string;
      exampleZh?: string;
    }>;
    sentences: Array<{ en: string; cn: string }>;
  };
}

const SENSES_MAX = 5;
const SENTENCES_MAX = 3;

/** 跨源释义合并：按来源权重排序展开，同「词性|释义」去重（跨源同文保留权重高者），
 *  钳制 5 条。source 字段记录来源词典 id（卡面来源徽标）。 */
export function mergeSenses(groups: SenseGroup[]): CardSense[] {
  const ordered = [...groups].sort((a, b) => sourceRank(a.dictId) - sourceRank(b.dictId));
  const out: CardSense[] = [];
  const seen = new Set<string>();
  for (const g of ordered) {
    for (const s of g.structured.senses) {
      const key = `${s.pos}|${s.definition}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        pos: s.pos || null,
        definition: s.definition,
        definitionEn: s.definitionEn ?? null,
        example: s.example ?? null,
        exampleZh: s.exampleZh ?? null,
        source: g.dictId,
      });
      if (out.length >= SENSES_MAX) return out;
    }
  }
  return out;
}

/** 独立例句合并（en/cn 齐全才收；钳制 3 条） */
export function mergeSentences(groups: SenseGroup[]): CardSentence[] {
  const out: CardSentence[] = [];
  for (const g of [...groups].sort((a, b) => sourceRank(a.dictId) - sourceRank(b.dictId))) {
    for (const s of g.structured.sentences) {
      if (!s.en || !s.cn) continue;
      out.push({ en: s.en, zh: s.cn, source: g.dictId });
      if (out.length >= SENTENCES_MAX) return out;
    }
  }
  return out;
}

/** 首个可用音标（来源权重序） */
export function firstPhonetic(groups: SenseGroup[]): string | null {
  for (const g of [...groups].sort((a, b) => sourceRank(a.dictId) - sourceRank(b.dictId))) {
    if (g.structured.phonetic) return g.structured.phonetic;
  }
  return null;
}

/** AI 输出 JSON 宽松解析：剥围栏 / 首尾大括号截取 / 数组元素逐项过滤
 *  （AI 偶发混入非对象条目，类型错误不得让整体解析失败）；释义产出 source="ai"
 *  （卡面兜底标注依据）。 */
export function parseAiSenses(response: string): CardSense[] {
  const trimmed = response.trim();
  const body = trimmed.startsWith("```")
    ? trimmed
        .replace(/^`+/, "")
        .replace(/`+$/, "")
        .replace(/^[a-z]*/i, "")
        .trim()
    : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: { senses?: unknown };
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw.senses)) return [];
  const out: CardSense[] = [];
  for (const v of raw.senses) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const definition = typeof o.definition === "string" ? o.definition.trim() : "";
    if (!definition) continue;
    out.push({
      pos: typeof o.pos === "string" && o.pos.trim() ? o.pos.trim() : null,
      definition,
      definitionEn: null,
      example: typeof o.example === "string" && o.example.trim() ? o.example.trim() : null,
      exampleZh:
        typeof o.exampleZh === "string" && o.exampleZh.trim() ? o.exampleZh.trim() : null,
      source: "ai",
    });
    if (out.length >= SENSES_MAX) break;
  }
  return out;
}
