/**
 * 文本语言判定（单一事实源）：决定选哪个音色槽，也决定朗读按钮的悬停提示。
 *
 * | 判据 | 结果 |
 * |---|---|
 * | CJK（汉字 / 假名 / 谚文）占比 ≥ 30% | `zh` |
 * | 含拉丁字母或数字、且无其他文字系统 | `en` |
 * | 其余（西里尔 / 阿拉伯 / 纯符号…） | `other`（走系统默认语音） |
 *
 * 「其他文字系统」= 重音拉丁、希腊、西里尔、希伯来、阿拉伯、天城文——全角标点、
 * 弯引号、emoji 不算（中英混排里太常见，判成 other 会丢掉语言槽）。
 *
 * 帧脚本（`dictFrame.ts` 的 BOOT_SCRIPT）**不能 import**，故那里有一份等价实现
 * （`saySegmentsOf` 内部自持）；两者一致性由 `node test/frame.mjs` 断言守住。
 */
export type TextLang = "zh" | "en" | "other";

/** CJK：汉字扩展 A / 基本区、假名、谚文、兼容表意文字（与帧内逐字判定同范围） */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

/** 其他文字系统（非拉丁字母）：命中即 not-en */
const NON_LATIN_SCRIPT_RE =
  /[\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f]/;

export function detectTextLang(text: string): TextLang {
  const dense = text.replace(/\s+/g, "");
  if (!dense) return "other";
  const cjk = (dense.match(CJK_RE) ?? []).length;
  if (cjk / dense.length >= 0.3) return "zh";
  // 无拉丁字母 / 数字（纯符号、纯西里尔…）→ 交系统默认语音
  if (!/[a-zA-Z0-9]/.test(dense)) return "other";
  if (NON_LATIN_SCRIPT_RE.test(dense)) return "other";
  return "en";
}
