/**
 * Edge 在线语音（Read Aloud 接口；Rust 侧 `edge_tts.rs` 承担签名与 WebSocket）。
 *
 * 这批语音（Xiaoxiao / Aria / Yunxi …）与讲述人同源，但只对第一方应用开放，
 * 系统 TTS 接口枚举不到——这里按社区通行做法走 Edge 网页端接口：
 * 语音列表 HTTP 一次拉取（会话内缓存），合成走 WSS（首块约 300ms，边合成边返回）。
 *
 * 需联网；接口非官方，失败给出 `EDGE_TTS:` 前缀错误，由朗读链降级到下一源。
 */
import { invoke } from "@tauri-apps/api/core";
import { detectLang, speakQueuedWith, type SoundData } from "./tts";

export interface EdgeVoiceInfo {
  /** 语音 id（`zh-CN-XiaoxiaoNeural`） */
  shortName: string;
  /** 显示名（`Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)`） */
  friendlyName: string;
  locale: string;
  gender: string;
}

/** 会话内缓存（322 条 / 约 170KB，设置页与朗读链共用） */
let cache: EdgeVoiceInfo[] | null = null;

export async function listEdgeVoices(force = false): Promise<EdgeVoiceInfo[]> {
  if (!force && cache) return cache;
  const list = await invoke<EdgeVoiceInfo[]>("edge_tts_voices");
  cache = list;
  return list;
}

export async function synthesizeEdge(
  text: string,
  voice: string,
  rate?: number,
): Promise<SoundData> {
  return invoke<SoundData>("edge_tts_synthesize", {
    text,
    voice,
    rate: rate ?? null,
  });
}

/** 按语言挑在线语音（指定优先；否则同 locale 前缀第一个；都没有给 undefined） */
export function pickEdgeVoice(
  voices: EdgeVoiceInfo[],
  lang: "zh" | "en" | "other",
  configured?: string,
): string | undefined {
  if (configured && voices.some((v) => v.shortName === configured)) return configured;
  const prefix = lang === "zh" ? "zh" : lang === "en" ? "en" : "";
  if (!prefix) return undefined;
  return voices.find((v) => v.locale.toLowerCase().startsWith(prefix))?.shortName;
}

/** 按文本语言解析实际使用的在线语音（列表拉取失败 / 无匹配 → undefined，由链降级） */
export async function resolveEdgeVoice(
  text: string,
  configuredZh: string,
  configuredEn: string,
): Promise<string | undefined> {
  let voices: EdgeVoiceInfo[] = [];
  try {
    voices = await listEdgeVoices();
  } catch {
    return undefined;
  }
  const lang = detectLang(text);
  const configured = lang === "zh" ? configuredZh : lang === "en" ? configuredEn : "";
  return pickEdgeVoice(voices, lang, configured);
}

/** 分句流水朗读（与本地语音同语义：单通道 + 下一句预取 + 可被 stopSpeaking 打断） */
export async function speakEdgeQueued(text: string, voice: string, rate: number): Promise<void> {
  await speakQueuedWith(text, (part) => synthesizeEdge(part, voice, rate));
}
