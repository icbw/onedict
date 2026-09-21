/**
 * 语音路由：把「场景（单词 / 句子）+ 文本语言 + 口音提示」解析成一个具体音源。
 *
 * 两层配置（见偏好 `pronounce`）：
 * - **语音槽** `voiceSlots`：`zh-f` / `zh-m` / `en-us-f` / `en-us-m` / `en-gb-f` / `en-gb-m`，
 *   值为 `local:<语音id>` 或 `edge:<shortName>`（无「自动」态，缺槽由后端补默认）；
 * - **朗读按钮** `sayBtnA` / `sayBtnB`：并列的两个朗读按钮（例句 / 译文 / AI
 *   词典原词旁）只配置**英文口音倾向**（`us` / `gb`），性别按按钮位固定
 *   （按钮 1 = 女声、按钮 2 = 男声）；经 `buttonSlotFor` 按文本语言映射成槽。
 *
 * 解析顺序（每个源各自只消费自己类型的槽）：
 * 1. 朗读按钮映射命中且类型匹配 → 用它（仅双按钮入口传入）；
 * 2. 否则按 语言-口音 取女声槽（zh→zh-f；en+英→en-gb-f；en+美→en-us-f）——
 *    无按钮入口（词条发音兜底 / 生词卡 / 截图朗读）走这一条；
 * 3. **Edge 通道到此为止**（返回 undefined，由朗读链降级到本机引擎）；
 *    本机通道再退一步：按语言（+ 按钮性别）挑本机语音，挑不到交系统默认语音。
 */
import { detectLang, listVoices, type TextLang, type VoiceInfo } from "./tts";
import type { PronouncePrefs } from "../types/prefs";

/** 场景：单词发音 / 句子朗读 */
export type VoiceScene = "word" | "sentence";

/** 英文口音提示（`""` = 未指定，按偏好默认） */
export type Accent = "us" | "gb" | "";

/** 音源类型（槽值前缀）：本地系统语音 / Edge 在线语音 */
export type VoiceKind = "local" | "edge";

/** 解析槽值（`local:<id>` / `edge:<name>`）；非本前缀或空值 → null */
export function parseSlotValue(value: string | undefined): { kind: VoiceKind; id: string } | null {
  if (!value) return null;
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const kind = value.slice(0, idx);
  const id = value.slice(idx + 1);
  if (!id) return null;
  if (kind === "local" || kind === "edge") return { kind, id };
  return null;
}

/** 语言 + 口音 → locale 前缀（zh → zh；en+英 → en-gb；en+美/未定 → en-us；其他 → 空） */
function localePrefix(lang: TextLang, accent: Accent): string {
  if (lang === "zh") return "zh";
  if (lang === "en") return accent === "gb" ? "en-gb" : "en-us";
  return "";
}

/** 语言 + 口音 → 默认语音槽 key（"" = 无默认槽，直接走自动挑选） */
export function defaultSlot(lang: TextLang, accent: Accent): string {
  if (lang === "zh") return "zh-f";
  if (lang === "en") return accent === "gb" ? "en-gb-f" : "en-us-f";
  return "";
}

/** 朗读按钮的英文口音倾向（设置项；中文等其他语言不看这一项） */
export type SayAccent = "us" | "gb";

/**
 * 朗读按钮：并列两个，**性别按按钮位固定**——按钮 1（a）= 女声（红）、
 * 按钮 2（b）= 男声（蓝）；设置项只是英文口音倾向。这样两个按钮天然成对
 * （女 / 男各一），不需要在性别池里挑。
 */
export interface SayButton {
  which: "a" | "b";
  /** 英文口音倾向（仅英文文本生效） */
  accent: SayAccent;
  /** 固定性别（决定图标颜色：f = 红 / m = 蓝） */
  gender: "f" | "m";
}

/** 按钮设定归一：值限 `us` / `gb`，空 / 非法回落按钮位默认（按钮 1 = 美音、按钮 2 = 英音） */
export function sayButtonOf(accent: string | undefined, which: "a" | "b"): SayButton {
  const v = (accent ?? "").trim().toLowerCase();
  const fallback: SayAccent = which === "a" ? "us" : "gb";
  return {
    which,
    accent: v === "us" || v === "gb" ? v : fallback,
    gender: which === "a" ? "f" : "m",
  };
}

/** 双按钮（索引 0 = 按钮 1 / 1 = 按钮 2；渲染与播放共用同一结果） */
export function sayButtonsOf(prefs: PronouncePrefs): [SayButton, SayButton] {
  return [sayButtonOf(prefs.sayBtnA, "a"), sayButtonOf(prefs.sayBtnB, "b")];
}

/**
 * 按钮 → 播放槽（按**文本语言**）：
 * - 中文：固定性别对应的中文槽（`zh-f` / `zh-m`）——中文没有口音维度，不看英美倾向；
 * - 英文：倾向口音 + 固定性别（`en-us-f` / `en-gb-m` 之类）；
 * - 其他语言：`""`（不参与槽解析，回落自动挑选，仍带性别偏好）。
 */
export function buttonSlotFor(button: SayButton, lang: TextLang): string {
  if (lang === "zh") return `zh-${button.gender}`;
  if (lang === "en") return `en-${button.accent}-${button.gender}`;
  return "";
}

/** 按钮音色标签（悬停提示 / 设置页）：英文报「口音 · 性别」，其余语言只报性别 */
export function sayButtonLabel(button: SayButton, lang: TextLang): string {
  const gender = button.gender === "m" ? "男声" : "女声";
  if (lang !== "en") return gender;
  return `${button.accent === "gb" ? "英音" : "美音"} · ${gender}`;
}

/** 性别 → 图标颜色类（红 = 女声 / 蓝 = 男声；与帧内 CSS 同色值，改色须两处同步） */
export const SAY_GENDER_CLASS: Record<SayButton["gender"], string> = {
  f: "text-rose-600",
  m: "text-blue-600",
};

/**
 * 本机语音挑选（仅本机引擎）：同语言 +（按钮性别）池自然语音优先 → 同语言任意；
 * `undefined` = 不指定语音，交给系统默认语音（仍属本机引擎，不会绕回在线源）。
 */
function pickLocal(
  voices: VoiceInfo[],
  prefix: string,
  gender: "f" | "m" | "" = "",
): string | undefined {
  // 语言未知（非中英文本）：不猜语言，直接交系统默认语音
  if (!prefix) return undefined;
  const same = voices.filter((v) => v.language.toLowerCase().startsWith(prefix));
  const pool = gender ? same.filter((v) => v.gender.toLowerCase().startsWith(gender)) : same;
  if (pool.length) return (pool.find((v) => v.natural) ?? pool[0]).id;
  if (same.length) return (same.find((v) => v.natural) ?? same[0]).id;
  return undefined;
}

/**
 * 解析指定音源类型的语音 id。
 * @param text 待朗读文本（决定语言）
 * @param want 目标音源类型（本地 / Edge）
 * @param accentHint 口音提示（来自词条锚点上下文，如英式 / 美式发音按钮）
 * @param button 朗读按钮（双按钮入口传入；null = 无按钮，按语言口音取女声槽）
 * @returns 语音 id；undefined = 解析不到（调用方按朗读链降级到下一个源 / 本机引擎）
 */
export async function resolveVoiceForSource(
  text: string,
  prefs: PronouncePrefs,
  want: VoiceKind,
  accentHint: Accent = "",
  button: SayButton | null = null,
): Promise<string | undefined> {
  const lang = detectLang(text);
  const accent: Accent =
    accentHint || (lang === "en" ? ((prefs.enAccent as Accent) ?? "") : "");
  const prefix = localePrefix(lang, accent);
  const override = button ? buttonSlotFor(button, lang) : "";
  const keys: string[] = [];
  for (const key of [override, defaultSlot(lang, accent)]) {
    if (key && !keys.includes(key)) keys.push(key);
  }
  for (const key of keys) {
    const slot = parseSlotValue(prefs.voiceSlots?.[key]);
    if (slot && slot.kind === want) return slot.id;
  }
  // 槽里没有该类型的音源（缺失 / 类型不符）→ **不再另挑同类音色**：
  // Edge 通道就此打住，由朗读链降级到本机引擎（系统语音），
  // 本机通道再按语言（+ 按钮性别）挑本机语音，挑不到交系统默认语音
  if (want === "edge") return undefined;
  const gender = button?.gender ?? "";
  const voices = await listVoices().catch(() => [] as VoiceInfo[]);
  return pickLocal(voices, prefix, gender);
}
