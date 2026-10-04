/**
 * 生词卡卡面整理管线（前端编排；Rust 只触发与落盘，见 src-tauri/src/vocabulary/card.rs）。
 * 组装纯函数在 lib/vocabCardCore.ts（node 基线覆盖），本文件负责采集与编排：
 *
 * 内容策略：释义与例句复用词典内容，AI 只兜底——
 *   1. 本地 O8C（牛津高阶双解；义项 DOM 结构稳定，单点适配，extractO8C）
 *   2. web-cambridge（剑桥英汉双解；def-block 义项绑定例句对译）
 *   3. web-bing（必应；词性分组中文释义串 + 独立例句区）
 *   4. web-youdao（有道；简明释义逐条）
 *   5. 词典源全空才 AI 兜底生成（per-item source = "ai"，卡面标注）
 * 语境原句的中文对译（sentenceZh）词典无法提供 → AI 翻译（有语境才调，无 AI 配置跳过）。
 *
 * 执行体 = 主窗口（keep-alive 常驻；划词面板短生命周期不能承载后台任务）：
 * - Rust `vocabulary-card-request` 事件（收藏 / 卡面「重新整理」）→ 串行队列即时执行；
 * - 启动补齐：挂载后延迟扫描全量词条，无 card 的旧词低速率补齐（升级前收藏的
 *   词条自动获得卡面；单词条失败跳过，下次启动重试）。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  WEB_DICTS,
  webItemsFromDictItems,
  type WebDictSense,
  type WebDictStructured,
} from "./webdict";
import { streamChat } from "./aiStream";
import { aiReady } from "../lib/aiConfig";
import {
  firstPhonetic,
  mergeSenses,
  mergeSentences,
  parseAiSenses,
  type SenseGroup,
} from "../lib/vocabCardCore";
import type { PrefsPayload } from "../types/prefs";
import type { CardSense, EntryCard, VocabularyEntry } from "../types/vocabulary";

/** 卡面请求（Rust vocabulary-card-request payload；与 Rust CardRequest 对齐） */
interface CardRequest {
  id: string;
  force: boolean;
}

/** 启动补齐延迟（等词典预热 / 主窗口首帧稳定）与批内间隔（在线源限速） */
const BACKFILL_DELAY_MS = 20_000;
const BACKFILL_INTERVAL_MS = 2_500;

/** 本地词典提取器注册（数据驱动的单点增强：词典 id → DOM 提取器）。
 *  mdict 词条 HTML 无 schema，逐典适配；未注册的本地词典不进卡面材料
 *  （其完整内容仍可经卡面「词典中查看」到达）。 */
const LOCAL_EXTRACTORS: Record<string, (html: string) => WebDictStructured> = {
  O8C: extractO8C,
};

function foldText(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

// ── 本地词典提取（O8C 牛津高阶双解） ──

/** O8C 词性缩写映射（.pos[pos] 属性 → 卡面词性标签） */
const O8C_POS: Record<string, string> = {
  n: "n.",
  v: "v.",
  adj: "adj.",
  adv: "adv.",
  prep: "prep.",
  conj: "conj.",
  pron: "pron.",
  det: "det.",
  num: "num.",
  excl: "interj.",
  auxv: "aux.",
};

/** O8C 词条 HTML → 结构化释义。词条骨架：span.entry > span.h-g（词头/音标/词性）
 *  + span.n-g（义项：span.def-g > span.d [英文定义，内嵌 span.chn 中文对译] +
 *  span.x-g 例证 [span.x 英文例 / span.tx 例句对译]）。
 *  音标取英式优先（.phon-gb），词性由 pos 属性映射为卡面标签形态。 */
export function extractO8C(html: string): WebDictStructured {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const phonEl = doc.querySelector(".phon-gb, .phon-us");
  const phonRaw = foldText(phonEl?.textContent);
  const $pos = doc.querySelector(".pos-g .pos");
  const posKey = ($pos?.getAttribute("pos") || "").trim();
  const pos = O8C_POS[posKey] ?? foldText($pos?.textContent);
  const senses: WebDictSense[] = [];
  doc.querySelectorAll("span.n-g").forEach(($ng) => {
    const $d = $ng.querySelector(".def-g .d");
    if (!$d) return;
    const definition = foldText($d.querySelector(".chn")?.textContent);
    const $clone = $d.cloneNode(true) as Element;
    $clone.querySelectorAll(".chn").forEach(($c) => $c.remove());
    const definitionEn = foldText($clone.textContent);
    const $xg = $ng.querySelector(".x-g");
    const example = foldText($xg?.querySelector(":scope > .x")?.textContent);
    const exampleZh = foldText($xg?.querySelector(":scope > .tx")?.textContent);
    if (!definition && !definitionEn) return;
    senses.push({
      pos,
      definition: definition || definitionEn,
      definitionEn: definitionEn || undefined,
      example: example || undefined,
      exampleZh: exampleZh || undefined,
    });
  });
  return {
    phonetic: phonRaw ? (phonRaw.startsWith("/") ? phonRaw : `/${phonRaw}/`) : undefined,
    senses,
    sentences: [],
  };
}

// ── 多源采集 ──

/** 在线词典采集（仅用户启用的源；单源失败静默跳过——词组/断网/NO_RESULT 均常态） */
async function collectWeb(word: string, prefs: PrefsPayload | null): Promise<SenseGroup[]> {
  const enabled = webItemsFromDictItems(prefs?.dictItems)
    .filter((w) => w.enabled && WEB_DICTS[w.id])
    .map((w) => w.id);
  const groups = await Promise.all(
    enabled.map(async (id): Promise<SenseGroup | null> => {
      try {
        const r = await WEB_DICTS[id].search(word);
        return r.structured && r.structured.senses.length > 0
          ? { dictId: id, structured: r.structured }
          : null;
      } catch {
        return null; // NO_RESULT / 网络错误 / FORBIDDEN：跳过该源
      }
    }),
  );
  return groups.filter((g): g is SenseGroup => g !== null);
}

/** 本地词典采集（仅注册了提取器且启用的词典；dictionary_lookup 含 @@@LINK 重定向） */
async function collectLocal(word: string): Promise<SenseGroup[]> {
  const wanted = Object.keys(LOCAL_EXTRACTORS);
  if (wanted.length === 0) return [];
  const dicts = await invoke<{ id: string; enabled: boolean }[]>("dictionary_list").catch(
    () => [],
  );
  const ids = dicts.filter((d) => d.enabled && wanted.includes(d.id)).map((d) => d.id);
  const groups = await Promise.all(
    ids.map(async (id): Promise<SenseGroup | null> => {
      const r = await invoke<{ html: string | null }>("dictionary_lookup", {
        dictId: id,
        word,
      }).catch(() => null);
      const html = r?.html;
      if (!html) return null;
      const structured = LOCAL_EXTRACTORS[id](html);
      return structured.senses.length > 0 ? { dictId: id, structured } : null;
    }),
  );
  return groups.filter((g): g is SenseGroup => g !== null);
}

// ── AI（兜底释义生成 + 语境原句对译；aiReady 才调） ──

async function aiTranslateSentence(
  sentence: string,
  prefs: PrefsPayload,
  signal?: AbortSignal,
): Promise<string | null> {
  const text = await streamChat(
    [
      {
        role: "system",
        content:
          "你是翻译引擎。把用户提供的句子翻译成自然的简体中文。只输出译文本身，不要任何解释或引号。",
      },
      { role: "user", content: sentence.trim() },
    ],
    { noThink: true },
    signal,
    () => {},
  );
  return text.trim() || null;
}

/** 词典源全空时的 AI 兜底释义（原句存在时要求最贴合语境的排第一） */
async function aiFallbackSenses(
  word: string,
  sentence: string,
  prefs: PrefsPayload,
  signal?: AbortSignal,
): Promise<CardSense[]> {
  const parts = [`词条：${word}`];
  if (sentence.trim()) parts.push(`原句：${sentence.trim()}`);
  const response = await streamChat(
    [
      {
        role: "system",
        content:
          '你是双语词典编辑。为词条整理 2-5 条最常用的中文释义，只输出一个 JSON 对象：\n{"senses":[{"pos":"词性","definition":"中文释义(不超过30字)","example":"英文例句(不超过25词,可省略)","exampleZh":"例句中文翻译(可省略)"}]}\n规则：按常用度排序；若提供了原句，把最贴合原句语境的释义排第一；严格只输出 JSON 本身。',
      },
      { role: "user", content: parts.join("\n") },
    ],
    { noThink: true },
    signal,
    () => {},
  );
  return parseAiSenses(response);
}

// ── 管线主体 ──

/** 组装一张卡面（词典复用 + AI 兜底 + 原句对译）。返回 null = 无内容可写
 *  （词典全空且 AI 未配置/失败）——保持无 card 降级态（卡面有重试入口）。 */
async function buildCard(
  entry: VocabularyEntry,
  prefs: PrefsPayload | null,
): Promise<EntryCard | null> {
  const word = entry.word;
  const sentence = entry.context?.sentence?.trim() ?? "";
  const [localGroups, webGroups] = await Promise.all([
    collectLocal(word),
    collectWeb(word, prefs),
  ]);
  const groups = [...localGroups, ...webGroups];
  let senses = mergeSenses(groups);
  const sentences = mergeSentences(groups);
  const phonetic = firstPhonetic(groups);

  const canAi = prefs ? aiReady(prefs.ai) : false;
  let sentenceZh: string | null = null;
  if (canAi && sentence && prefs) {
    sentenceZh = await aiTranslateSentence(sentence, prefs).catch(() => null);
  }
  if (senses.length === 0 && canAi && prefs) {
    senses = await aiFallbackSenses(word, sentence, prefs).catch(() => []);
  }
  if (senses.length === 0 && sentences.length === 0 && !sentenceZh) return null;

  const hasAi = senses.some((s) => s.source === "ai");
  const hasDict = senses.some((s) => s.source !== "ai");
  return {
    senses,
    sentences,
    phonetic,
    sentenceZh,
    source: hasAi && hasDict ? "mixed" : hasAi ? "ai" : "web",
    generatedAt: Date.now(),
  };
}

/** 单词条整理（幂等：已有卡面且非 force → 跳过；失败静默——降级态可重试） */
async function pipeline(req: CardRequest): Promise<void> {
  const entry = await invoke<VocabularyEntry | null>("vocabulary_entry", { id: req.id }).catch(
    () => null,
  );
  if (!entry) return;
  if (entry.card && !req.force) return;
  const prefs = await invoke<PrefsPayload>("prefs_get").catch(() => null);
  const card = await buildCard(entry, prefs);
  if (!card) return;
  await invoke<VocabularyEntry>("vocabulary_card_set", { id: req.id, card });
}

// ── 串行队列 + 事件接线 + 启动补齐 ──

const queue: CardRequest[] = [];
let draining = false;
let disposed = false;

function enqueue(req: CardRequest): void {
  // 同 id 已在队：合并（force 粘性——任一 force 请求即覆盖式重跑）
  const existing = queue.find((r) => r.id === req.id);
  if (existing) {
    existing.force = existing.force || req.force;
    return;
  }
  queue.push(req);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0 && !disposed) {
      const req = queue.shift()!;
      await pipeline(req).catch(() => {}); // 单词条失败静默（降级态可重试）
      if (queue.length > 0 && !disposed) await sleep(300); // 在线源礼貌节流
    }
  } finally {
    draining = false;
  }
}

/** 启动补齐：升级前收藏的旧词条（无 card）低速率逐个整理。
 *  节流间隔独立于事件队列（批量在线查询礼貌节流）；应用退出自然终止。 */
async function backfill(): Promise<void> {
  if (disposed) return;
  const entries = await invoke<VocabularyEntry[]>("vocabulary_list").catch(() => []);
  for (const entry of entries) {
    if (disposed) return;
    if (entry.card) continue;
    enqueue({ id: entry.id, force: false });
    if (!draining) void drain();
    await sleep(BACKFILL_INTERVAL_MS);
  }
}

/** 主窗口挂载接线（返回清理函数）。 */
export function initVocabCardPipeline(): () => void {
  const un = listen<CardRequest>("vocabulary-card-request", (e) => {
    enqueue(e.payload);
    void drain();
  });
  const timer = setTimeout(() => void backfill(), BACKFILL_DELAY_MS);
  return () => {
    disposed = true;
    queue.length = 0;
    clearTimeout(timer);
    void un.then((f) => f(), () => {});
  };
}
