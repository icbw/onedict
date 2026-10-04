/**
 * 复习语音预取（M3 配套，设置页「发音 → 复习语音预取」开关默认关）。
 *
 * 动机（方案 §7.1）：语境卡正面读整句走 sentenceChain（仅合成源）——每卡必走
 * 合成；实时在线合成 1–2s 延迟毁翻卡节奏，断网直接降级本地系统语音（音质断崖）。
 * 预取把在线合成挪到复习之外，经 `voice-cache\` 的 write-through 层落盘
 * （`synthesizeEdge` 出口内联缓存，命中本地秒放），是语境化复习的可用性必需。
 *
 * 原则：
 * - **范围 = 词 + 语境句**（今日计划单元与会话选词的全集）。词典例句不进批量
 *   （每词条多条、量大，靠例句点击的自然积累）。
 * - **预取只加速不承诺**：串行低并发、失败静默、连续失败 3 次放弃本批剩余
 *   （大概率网络 / 服务不可用，逐条硬试只是徒耗）；复习链未命中永远实时合成兜底。
 * - 未配置 Edge 音源（六槽全 local / 解析不出）的用户无感知跳过。
 * - 主动清（单元毕业 / 删除，`clearVoiceCacheForEntries`）按**当前偏好配置**
 *   重算缓存键删除——语音 / 语速改过之后算不出的旧键由 Rust 侧 LRU 容量上限
 *   最终回收（主机制），主动清只是加速器。
 */
import { invoke } from "@tauri-apps/api/core";
import { synthesizeEdge } from "./edgeTts";
import { sentenceChainOf } from "./pronounce";
import { resolveVoiceForSource } from "./voiceRouter";
import type { PronouncePrefs } from "../types/prefs";
import type { VocabularyEntry } from "../types/vocabulary";

/** 连续合成失败达到此数即放弃本批剩余（静默） */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 本会话已入队 / 已预取的文本（去重：跳词 / 会话重叠不重复合成） */
const enqueued = new Set<string>();
/** 串行链：同一时刻只跑一批，后续批次排队（天然低并发） */
let chain: Promise<void> = Promise.resolve();

/** 词条的预取文本集（词 + 语境句；空串过滤） */
function textsOfEntries(entries: VocabularyEntry[]): string[] {
  const texts: string[] = [];
  for (const e of entries) {
    const word = e.word.trim();
    if (word) texts.push(word);
    const sentence = e.context?.sentence?.trim();
    if (sentence) texts.push(sentence);
  }
  return texts;
}

/** 后台预取（fire-and-forget）：开关关闭 / 句子链无 edge / 全部已入队时 no-op */
export function prefetchVoiceAudio(entries: VocabularyEntry[], prefs: PronouncePrefs): void {
  if (!prefs.voicePrefetch || entries.length === 0) return;
  if (!sentenceChainOf(prefs).includes("edge")) return;
  const fresh = textsOfEntries(entries).filter((t) => !enqueued.has(t));
  if (fresh.length === 0) return;
  for (const t of fresh) enqueued.add(t);
  chain = chain.then(() => runBatch(fresh, prefs)).catch(() => {
    /* 批次失败静默（预取不承诺） */
  });
}

async function runBatch(texts: string[], prefs: PronouncePrefs): Promise<void> {
  let failures = 0;
  for (const text of texts) {
    if (failures >= MAX_CONSECUTIVE_FAILURES) return;
    try {
      const voice = await resolveVoiceForSource(text, prefs, "edge", "");
      if (!voice) continue; // 无 Edge 音源（六槽全 local）→ 无感知跳过
      await synthesizeEdge(text, voice, prefs.rate); // write-through：命中秒回，未命中合成落盘
    } catch {
      failures += 1;
    }
  }
}

/** 主动清（单元毕业 / 删除的加速器）：按当前偏好配置重算 key 删除该批词条的
 *  缓存；同时从会话去重集中移除（词条若被移回 / 单元重建，下次触发重新预取）。 */
export async function clearVoiceCacheForEntries(
  entries: VocabularyEntry[],
  prefs: PronouncePrefs | null,
): Promise<void> {
  const words = textsOfEntries(entries);
  for (const t of words) enqueued.delete(t);
  if (!prefs || words.length === 0) return;
  try {
    const items: Array<{ text: string; voice: string; rate: number }> = [];
    for (const text of words) {
      const voice = await resolveVoiceForSource(text, prefs, "edge", "");
      if (voice) items.push({ text, voice, rate: prefs.rate });
    }
    if (items.length) await invoke("voice_cache_remove", { items });
  } catch {
    /* 清理失败静默（LRU 兜底） */
  }
}
