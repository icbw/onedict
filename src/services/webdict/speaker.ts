/** 在线词典发音锚点：把音频节点替换成统一占位锚点（对齐 saladict Speaker 手法），
 *  点击由帧内 BOOT_SCRIPT 解析 `webaudio://` 后委托父页 `webdict_audio` 下载回播。
 *  各引擎共用，故独立成模块（喇叭形状取自 Material volume_up 图标，Apache-2.0）。 */
const SPEAKER_PATH =
  "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z";

/** 音标标签 → 口音标记（"UK" / "英" → gb；"US" / "美" → us；其他 = 未知）。
 *  锚点只有 URL 时帧内无从判断英 / 美（音频资源缺失的合成兜底会读错音色），
 *  故由生成端把标签语义转成标记带给帧内。 */
export function accentFromLabel(label: string): "gb" | "us" | "" {
  if (/英|英式|british|\buk\b|en[-_]?gb/i.test(label)) return "gb";
  if (/美|美式|american|\bus\b|en[-_]?us/i.test(label)) return "us";
  return "";
}

/** 发音喇叭锚点 HTML（url 为完整绝对地址；accent = 词条英 / 美发音标记） */
export function speaker(url: string, accent: "gb" | "us" | "" = ""): string {
  const mark = accent ? ` data-accent="${accent}"` : "";
  return `<a class="webdict-Speaker"${mark} href="webaudio://${encodeURIComponent(url)}" aria-label="播放发音"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="${SPEAKER_PATH}"/></svg></a>`;
}
