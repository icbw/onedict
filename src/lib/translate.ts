/**
 * 翻译语言表（划词 AI 翻译动作、翻译 Tab 与截图翻译共用）。
 * code 持久化于偏好 translateLang / ocrTargetLang / ocrLang（源语言提示）/
 * translateSourceLang；promptName 进入翻译提示词。
 *
 * 语言清单与编码对齐 Cherry Studio 内置翻译语言表（AGPL 只读参考，未复制代码：
 * 20 种语言 langCode 相同），中文名取 cherry zh-cn 文案风格（"X文"）。
 * 国旗不在此表——Windows 无国旗 emoji 字体，由 components/LangSelect 用打包的
 * SVG（circle-flags，MIT）渲染。
 * 旧偏好值兼容：ocrLang 曾存系统 BCP-47 tag（en-US 等），sourceLangCompat 归一化。
 */
export interface TranslateLang {
  code: string;
  /** 中文名（cherry zh-cn 文案风格：简体中文/英文/日文…） */
  label: string;
  /** 翻译提示词中的语言名（英文，LLM 识别更稳） */
  promptName: string;
}

export const TARGET_LANGS: TranslateLang[] = [
  { code: "zh-cn", label: "简体中文", promptName: "Simplified Chinese" },
  { code: "zh-tw", label: "繁体中文", promptName: "Traditional Chinese" },
  { code: "en-us", label: "英文", promptName: "English" },
  { code: "ja-jp", label: "日文", promptName: "Japanese" },
  { code: "ko-kr", label: "韩文", promptName: "Korean" },
  { code: "fr-fr", label: "法文", promptName: "French" },
  { code: "de-de", label: "德文", promptName: "German" },
  { code: "it-it", label: "意大利文", promptName: "Italian" },
  { code: "es-es", label: "西班牙文", promptName: "Spanish" },
  { code: "pt-pt", label: "葡萄牙文", promptName: "Portuguese" },
  { code: "ru-ru", label: "俄文", promptName: "Russian" },
  { code: "pl-pl", label: "波兰文", promptName: "Polish" },
  { code: "ar-sa", label: "阿拉伯文", promptName: "Arabic" },
  { code: "tr-tr", label: "土耳其文", promptName: "Turkish" },
  { code: "th-th", label: "泰文", promptName: "Thai" },
  { code: "vi-vn", label: "越南文", promptName: "Vietnamese" },
  { code: "id-id", label: "印尼文", promptName: "Indonesian" },
  { code: "ur-pk", label: "乌尔都文", promptName: "Urdu" },
  { code: "ms-my", label: "马来文", promptName: "Malay" },
  { code: "uk-ua", label: "乌克兰文", promptName: "Ukrainian" },
];

export function targetLangByCode(code: string | null | undefined): TranslateLang {
  return TARGET_LANGS.find((l) => l.code === code) ?? TARGET_LANGS[0];
}

/** 旧值兼容：源语言偏好（ocrLang）曾存系统 BCP-47 tag（en-US/zh-Hans-CN/zh-HK），
 *  归一化为表 code；无匹配返回 ""（视为自动） */
export function sourceLangCompat(v: string | null | undefined): string {
  if (!v) return "";
  const s = v.toLowerCase();
  if (s === "zh-hans-cn" || s === "zh-hans") return "zh-cn";
  if (s === "zh-hant-tw" || s === "zh-hant" || s === "zh-hk") return "zh-tw";
  return TARGET_LANGS.some((l) => l.code === s) ? s : "";
}
