/**
 * 本地系统朗读（WinRT `Windows.Media.SpeechSynthesis`，Rust 侧 `tts.rs`）。
 *
 * 语音库与「讲述人 → 选择语音」同源（OneCore），Natural / HD 语音都在内；
 * 合成为本地内存 WAV（不走网络），播放沿用项目既有单通道通道（播新停旧）。
 *
 * 朗读源选择不在这里——链式决策在 `pronounce.ts`；本模块只管「给文本和语音，
 * 合成并播出来」。长文本经 `speakQueued` 分句流水（逐句合成 + 下一句预取），
 * 避免整段合成干等。
 */
import { invoke } from "@tauri-apps/api/core";
import { detectTextLang, type TextLang } from "./textLang";

/** 语音条目（Rust `tts_voices`） */
export interface VoiceInfo {
  id: string;
  name: string;
  /** BCP-47 语言标签（en-US / zh-CN …） */
  language: string;
  gender: string;
  /** 显示名含 Natural（Natural / Natural HD 语音） */
  natural: boolean;
  description: string;
}

/** 合成结果（与 dictionary_sound / webdict_audio 同构） */
export interface SoundData {
  base64: string | null;
  mime: string;
}

/** 文本语言（决定选哪个语音；判据单一事实源见 `services/textLang.ts`） */
export type { TextLang };

export interface SpeakOptions {
  /** 指定语音 id；缺省按语言自动选（Natural 优先） */
  voiceId?: string;
  /** 语速 0.5–1.5（1.0 = 原速） */
  rate?: number;
  /** 语音失效回退时的通知（回退系统默认语音后仍会播完） */
  onVoiceFallback?: () => void;
}

/** 一次朗读请求的时序 token：新请求 / 停止使在途响应与队列全部失效 */
let speakSeq = 0;
let currentAudio: HTMLAudioElement | null = null;
/** 当前播放的结算函数（停止 / 被新播放抢占时调用：等待方视作播放结束，不悬挂） */
let currentSettle: (() => void) | null = null;

/** 起播看门狗：媒体解析出时长却迟迟不推进播放（系统音频输出阻塞的典型表现，
 *  见 2026-09-19 排查记录）时，主动结算为错误——否则 await 永远悬挂，
 *  单通道下后续朗读全部排队干等，用户只看到「点了没反应」。 */
const START_TIMEOUT_MS = 4000;

/** 释放音频元素（清源 + load 让解码资源即时归还；长会话反复播放不堆积） */
function releaseAudio(audio: HTMLAudioElement): void {
  try {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } catch {
    /* 元素已不可用，忽略 */
  }
}

/** 停掉当前音频并结算其播放 promise（停止与「新播放抢占」共用） */
function interruptCurrent(): void {
  const audio = currentAudio;
  const settle = currentSettle;
  currentAudio = null;
  currentSettle = null;
  if (audio) releaseAudio(audio);
  settle?.();
}

/** 语音列表缓存（会话内一次；设置页可 force 刷新） */
let voicesCache: VoiceInfo[] | null = null;

export async function listVoices(force = false): Promise<VoiceInfo[]> {
  if (!force && voicesCache) return voicesCache;
  const voices = await invoke<VoiceInfo[]>("tts_voices");
  voicesCache = voices;
  return voices;
}

export async function synthesize(
  text: string,
  voiceId?: string,
  rate?: number,
): Promise<SoundData> {
  return invoke<SoundData>("tts_synthesize", {
    text,
    voiceId: voiceId ?? null,
    rate: rate ?? null,
  });
}

/** 停止当前朗读（在途合成与分句队列一并作废） */
export function stopSpeaking(): void {
  speakSeq += 1;
  interruptCurrent();
}

export function isSpeaking(): boolean {
  return currentAudio !== null;
}

/** 文本语言判定（判据与常数见 `services/textLang.ts`，帧内分段用同一套判据） */
export function detectLang(text: string): TextLang {
  return detectTextLang(text);
}

/** 按语言挑语音：指定的优先（失效则忽略）；否则同语言第一个 Natural → 同语言任意 → 系统默认 */
export function pickVoice(
  voices: VoiceInfo[],
  lang: TextLang,
  configured?: string,
): string | undefined {
  if (configured && voices.some((v) => v.id === configured)) return configured;
  const prefix = lang === "zh" ? "zh" : lang === "en" ? "en" : "";
  if (!prefix) return undefined;
  const same = voices.filter((v) => v.language.toLowerCase().startsWith(prefix));
  return (same.find((v) => v.natural) ?? same[0])?.id;
}

/** 分句（中英句末标点 + 换行断句；超长句按 120 字硬切）——长文朗读的基本单位 */
export function splitSentences(text: string, limit = 120): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const rough = cleaned.match(/[^。！？!?；;…\n]+[。！？!?；;…]?/g) ?? [cleaned];
  const out: string[] = [];
  for (const seg of rough) {
    const s = seg.trim();
    if (!s) continue;
    if (s.length <= limit) {
      out.push(s);
    } else {
      for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit));
    }
  }
  return out;
}

/** 播放一段 base64 音频（单通道：起播前先停上一条——资源音频与合成音频共用一条通道）。
 *  导出供朗读链播放词典 / 在线资源音频。被抢占时 Promise 立即结算（不悬挂），
 *  分句队列由 `stopSpeaking` 的 seq 递增判定退出。
 *  两条失败保障：① 媒体 `error` 事件 / 自动播放被拒 → 立即 reject；
 *  ② **起播看门狗**——媒体解析出时长却不推进播放（`stalled`）时，超时判失败并提示，
 *  不让 await 悬挂（该故障与系统音频输出相关，见 logs/2026-09-19）。 */
export function playSoundData(data: SoundData): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!data.base64) {
      reject(new Error("合成结果为空"));
      return;
    }
    interruptCurrent();
    const audio = new Audio(`data:${data.mime};base64,${data.base64}`);
    currentAudio = audio;
    let settled = false;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    const stopWatchdog = () => {
      if (startTimer !== null) {
        clearTimeout(startTimer);
        startTimer = null;
      }
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      stopWatchdog();
      if (currentAudio === audio) {
        currentAudio = null;
        currentSettle = null;
      }
      releaseAudio(audio);
      finish();
    };
    currentSettle = () => settle(resolve);
    audio.addEventListener("ended", () => settle(resolve));
    audio.addEventListener("error", () =>
      settle(() => reject(new Error("音频播放失败（媒体不可解码或输出设备异常）"))),
    );
    startTimer = setTimeout(() => {
      if (settled || audio.currentTime > 0) return;
      settle(() =>
        reject(new Error("音频未能开始播放（系统音频输出异常，请检查输出设备后重试）")),
      );
    }, START_TIMEOUT_MS);
    audio.play().catch(() =>
      settle(() => reject(new Error("浏览器阻止了自动播放，请再点一次朗读按钮"))),
    );
  });
}

/** 按语言解析实际语音（含失效回退）：返回 voiceId（undefined = 系统默认）与是否发生回退 */
export async function resolveVoice(
  text: string,
  configuredZh: string,
  configuredEn: string,
): Promise<{ voiceId?: string; fallback: boolean }> {
  const lang = detectLang(text);
  let voices: VoiceInfo[] = [];
  try {
    voices = await listVoices();
  } catch {
    // 语音列表拿不到（系统异常）：退回系统默认语音，仍能读
    return { voiceId: undefined, fallback: false };
  }
  const configured = lang === "zh" ? configuredZh : lang === "en" ? configuredEn : "";
  const voiceId = pickVoice(voices, lang, configured);
  return { voiceId, fallback: Boolean(configured) && voiceId !== configured };
}

/**
 * 朗读一段文本（单段；长文请用 speakQueued）。
 * 语义：先停上一条，再合成播放；被后续请求 / stopSpeaking 取代则静默放弃。
 */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const target = text.trim();
  if (!target) return;
  stopSpeaking();
  const seq = speakSeq;
  const data = await synthesize(target, opts.voiceId, opts.rate);
  if (seq !== speakSeq) return;
  await playSoundData(data);
}

/**
 * 分句流水朗读（长文）：逐句合成并顺序播放，下一句在播上一句时预取；
 * 任一句失败即中断并抛出（首句失败 = 完全没出声，调用方提示）。
 */
export async function speakQueued(text: string, opts: SpeakOptions = {}): Promise<void> {
  await speakQueuedWith(text, (part) => synthesize(part, opts.voiceId, opts.rate));
}

/**
 * 通用分句流水：逐句经 `synthOne` 合成并顺序播放，下一句在播上一句时预取；
 * 任一句失败即中断并抛出。新请求 / `stopSpeaking` 使队列退出（seq 门禁）。
 * 本地系统语音（本模块）与 Edge 在线语音（`edgeTts.ts`）共用这套队列语义。
 */
export async function speakQueuedWith(
  text: string,
  synthOne: (part: string) => Promise<SoundData>,
): Promise<void> {
  const parts = splitSentences(text);
  if (parts.length === 0) return;
  stopSpeaking();
  const seq = speakSeq;
  let prefetch: Promise<SoundData> | null = null;
  for (let i = 0; i < parts.length; i += 1) {
    if (seq !== speakSeq) return;
    const pending = prefetch ?? synthOne(parts[i]);
    prefetch = i + 1 < parts.length ? synthOne(parts[i + 1]) : null;
    // 预取失败沿用主流程 await 抛出；这里补挂空 catch 防 unhandled rejection
    prefetch?.catch(() => {});
    const data = await pending;
    if (seq !== speakSeq) return;
    await playSoundData(data);
  }
}
