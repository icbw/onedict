/**
 * 朗读链执行器：按发音偏好里的**有序链**逐项尝试，取第一个可用的音源朗读。
 *
 * 三个源：
 * - `dict`    本地词典 MDD 录音（sound:// 资源；真人，最快）
 * - `webdict` 在线词典音频（webaudio 锚点给的地址；需网络）
 * - `tts`     本地系统语音合成（唯一能读句子的源）
 *
 * 链 = 优先级（数组序），项缺席 = 停用；把 `tts` 拖到首位即全走系统语音。
 * 播放一律走 `tts.ts` 的单通道（播新停旧）——词典 / 在线资源音频与合成音频
 * 共用同一通道，不出现两条朗读叠音。
 *
 * 帧内（词条 iframe）场景不在这里播：父页只做决策与取数，音频回帧由
 * BOOT_SCRIPT 播放（见 `DictionaryPanel.tsx`）。
 */
import { invoke } from "@tauri-apps/api/core";
import { fetchSoundData } from "./dictSound";
import { speakEdgeQueued, synthesizeEdge } from "./edgeTts";
import {
  playSoundData,
  speak,
  speakQueued,
  stopSpeaking,
  synthesize,
  type SoundData,
} from "./tts";
import { resolveVoiceForSource, type Accent, type SayButton, type VoiceScene } from "./voiceRouter";
import type { PronouncePrefs } from "../types/prefs";

/** 发音提示（info = 取音中，error = 失败；null = 完成清除） */
export interface PronounceHint {
  text: string;
  kind: "info" | "error";
}

export type PronounceStatus = (hint: PronounceHint | null) => void;

/** 音源 id（与偏好 `wordChain` / `sentenceChain` 值域一致）：
 *  dict / webdict = 真人录音；edge = Edge 在线自然语音；tts = 本地系统语音 */
export type WordSource = "dict" | "webdict" | "edge" | "tts";

export const DEFAULT_WORD_CHAIN: WordSource[] = ["dict", "webdict", "edge", "tts"];
export const DEFAULT_SENTENCE_CHAIN: WordSource[] = ["edge", "tts"];

/** 生效的单词链（空数组 = 全部停用，不补默认——与后端归一化语义一致） */
export function wordChainOf(prefs: PronouncePrefs): WordSource[] {
  return prefs.wordChain?.length ? [...prefs.wordChain] : [...DEFAULT_WORD_CHAIN];
}

export function sentenceChainOf(prefs: PronouncePrefs): WordSource[] {
  return prefs.sentenceChain?.length ? [...prefs.sentenceChain] : [...DEFAULT_SENTENCE_CHAIN];
}

/** 合成源（在线自然语音 / 本地系统语音）判定 */
export function isSynthSource(source: WordSource): boolean {
  return source === "edge" || source === "tts";
}

/** 帧内锚点决策：链中是否有合成源排在该资源源之前（true = 点锚点直接合成，跳过资源下载） */
export function ttsBeforeResource(prefs: PronouncePrefs, resource: WordSource): boolean {
  const chain = wordChainOf(prefs);
  const res = chain.indexOf(resource);
  const limit = res < 0 ? chain.length : res;
  return chain.slice(0, limit).some(isSynthSource);
}

/** 从词条 HTML 提取第一个 sound:// 资源键（href= 前缀限定，避开 BOOT_SCRIPT 字面量） */
export function firstSoundKey(html: string): string | null {
  const m = /href=["']sound:\/\/([^"']+)["']/i.exec(html);
  return m ? m[1] : null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 本地系统语音朗读一段：语音按「语言 + 口音」取女声槽（配置失效的语音自动跳过） */
async function speakViaTts(
  text: string,
  prefs: PronouncePrefs,
  accentHint: Accent = "",
): Promise<void> {
  const voiceId = await resolveVoiceForSource(text, prefs, "local", accentHint);
  await speak(text, { voiceId, rate: prefs.rate });
}

/** 单词发音上下文（各接入点按手头信息提供；缺的源自动跳过） */
export interface WordContext {
  prefs: PronouncePrefs;
  /** dict 源：惰性取 `sound://` 资源（生词卡需先查词条 HTML；返回 null = 该词典未收录） */
  loadDictSound?: () => Promise<{ dictId: string; key: string } | null>;
  /** webdict 源：在线音频地址（词条 webaudio 锚点给的绝对 URL） */
  audioUrl?: string;
  /** 口音提示（词条英 / 美发音按钮；决定英文选英音还是美音） */
  accent?: Accent;
  onStatus?: PronounceStatus;
}

/**
 * 单词朗读（父页播放）：按链逐项尝试，成功即返回；全失败抛错（调用方提示）。
 * 跳过条件：链中该源存在但上下文没提供对应资源（不算失败，继续下一项）。
 */
export async function speakWord(word: string, ctx: WordContext): Promise<void> {
  const target = word.trim();
  if (!target) return;
  // 新朗读取代旧朗读：停当前音频并作废在途合成 / 分句队列（单通道语义）
  stopSpeaking();
  const report = ctx.onStatus ?? (() => {});
  const failures: string[] = [];
  for (const source of wordChainOf(ctx.prefs)) {
    if (source === "dict") {
      if (!ctx.loadDictSound) continue;
      try {
        report({ text: "词典发音获取中…", kind: "info" });
        const res = await ctx.loadDictSound();
        if (!res) {
          failures.push("词典未收录发音");
          continue;
        }
        const data = await fetchSoundData(res.dictId, res.key);
        report(null);
        await playSoundData(data);
        return;
      } catch (e) {
        failures.push(`词典发音（${errText(e)}）`);
      }
    } else if (source === "webdict") {
      if (!ctx.audioUrl) continue;
      try {
        report({ text: "在线发音获取中…", kind: "info" });
        const data = await invoke<SoundData>("webdict_audio", { url: ctx.audioUrl });
        if (!data.base64) throw new Error("音频下载失败");
        report(null);
        await playSoundData(data);
        return;
      } catch (e) {
        failures.push(`在线发音（${errText(e)}）`);
      }
    } else if (source === "edge") {
      try {
        report({ text: "在线语音合成中…", kind: "info" });
        const voice = await resolveVoiceForSource(target, ctx.prefs, "edge", ctx.accent ?? "");
        if (!voice) {
          failures.push("在线语音未配置（六槽里没有 Edge 音源）");
          continue;
        }
        const data = await synthesizeEdge(target, voice, ctx.prefs.rate);
        report(null);
        await playSoundData(data);
        return;
      } catch (e) {
        failures.push(`在线语音（${errText(e)}）`);
      }
    } else if (source === "tts") {
      try {
        report({ text: "系统语音合成中…", kind: "info" });
        await speakViaTts(target, ctx.prefs, ctx.accent ?? "");
        report(null);
        return;
      } catch (e) {
        failures.push(`系统语音（${errText(e)}）`);
      }
    }
  }
  report(null);
  throw new Error(
    failures.length ? failures.join("；") : "没有可用的朗读源（设置页「发音」可调整）",
  );
}

/** 句子朗读（父页播放）：按句子链逐项尝试（edge 在线自然语音 → tts 本地），
 *  分句流水（逐句合成 + 下一句预取）；全部失败抛错（调用方提示）。
 *  `button` = 双按钮入口传入的朗读按钮（null = 无按钮，按语言口音取女声槽）。 */
export async function speakSentence(
  text: string,
  prefs: PronouncePrefs,
  onStatus?: PronounceStatus,
  button?: SayButton | null,
): Promise<void> {
  const target = text.trim();
  if (!target) return;
  const failures: string[] = [];
  for (const source of sentenceChainOf(prefs)) {
    if (source === "edge") {
      try {
        onStatus?.({ text: "在线语音合成中…", kind: "info" });
        const voice = await resolveVoiceForSource(target, prefs, "edge", "", button);
        if (!voice) {
          failures.push("在线语音未配置（六槽里没有 Edge 音源）");
          continue;
        }
        await speakEdgeQueued(target, voice, prefs.rate);
        onStatus?.(null);
        return;
      } catch (e) {
        failures.push(`在线语音（${errText(e)}）`);
      }
    } else if (source === "tts") {
      try {
        onStatus?.({ text: "系统语音合成中…", kind: "info" });
        const voiceId = await resolveVoiceForSource(target, prefs, "local", "", button);
        await speakQueued(target, { voiceId, rate: prefs.rate });
        onStatus?.(null);
        return;
      } catch (e) {
        failures.push(`系统语音（${errText(e)}）`);
      }
    }
  }
  onStatus?.(null);
  throw new Error(
    failures.length ? failures.join("；") : "没有可用的朗读源（设置页「发音」可调整）",
  );
}

/**
 * 单词发音（父页播放，**直接合成**，跳过词典 / 在线真人资源）：AI 词典原词按钮用——
 * 口音由 `accent` 指定（`""` = 按设置页「英文口音默认」），音源按语言与口音取女声槽
 * （传 `button` 时用该按钮的音色）。
 */
export async function speakWordByTts(
  text: string,
  prefs: PronouncePrefs,
  accent: Accent = "",
  onStatus?: PronounceStatus,
  button?: SayButton | null,
): Promise<void> {
  const target = text.trim();
  if (!target) return;
  stopSpeaking();
  onStatus?.({ text: "语音合成中…", kind: "info" });
  try {
    const data = await synthesizeWordData(target, prefs, "word", accent, button);
    if (!data?.base64) throw new Error("没有可用的合成语音源（设置页「发音」中启用）");
    onStatus?.(null);
    await playSoundData(data);
  } catch (e) {
    onStatus?.(null);
    throw e;
  }
}

/**
 * 帧内兜底：合成语音数据（**不播放**，由父页回帧播放）。
 * 链中两个合成源（edge / tts）都启用时按链序取前者，在线失败且本地可用则回落本地；
 * 返回 null = 链中无合成源（调用方按「无可用源」处理）；合成失败抛错。
 */
export async function synthesizeWordData(
  text: string,
  prefs: PronouncePrefs,
  scene: VoiceScene = "word",
  accentHint: Accent = "",
  button: SayButton | null = null,
): Promise<SoundData | null> {
  const target = text.trim();
  if (!target) return null;
  // 场景决定用哪条链：单词走 wordChain（含真人录音源），句子走 sentenceChain（仅合成源）
  const chain = scene === "sentence" ? sentenceChainOf(prefs) : wordChainOf(prefs);
  const edgeIdx = chain.indexOf("edge");
  const ttsIdx = chain.indexOf("tts");
  if (edgeIdx < 0 && ttsIdx < 0) return null;
  if (edgeIdx >= 0 && (ttsIdx < 0 || edgeIdx < ttsIdx)) {
    const voice = await resolveVoiceForSource(target, prefs, "edge", accentHint, button);
    if (voice) {
      try {
        return await synthesizeEdge(target, voice, prefs.rate);
      } catch (e) {
        if (ttsIdx < 0) throw e;
      }
    } else if (ttsIdx < 0) {
      return null;
    }
  }
  const voiceId = await resolveVoiceForSource(target, prefs, "local", accentHint, button);
  return synthesize(target, voiceId, prefs.rate);
}
