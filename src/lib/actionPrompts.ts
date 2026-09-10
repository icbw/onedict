/**
 * 内置 AI 动作提示词（单一事实源）：划词动作执行（ActionGeneral/ActionTranslate）
 * 与设置页编辑弹窗的预填共用。模板对齐 pickdict zh prompt（MIT 白名单行为基线），
 * 翻译模板对齐 cherry TRANSLATE_PROMPT 语义（翻译专家 + 防注入 + 原格式保留）。
 */

/** 内置动作提示词；translate 需传入目标语言展示名（如 "Simplified Chinese"） */
export function builtinPrompt(actionId: string, targetLangName?: string): string {
  switch (actionId) {
    case "translate":
      return `You are a translation expert. Your only task is to translate text enclosed with <translate_input> from the input language to ${targetLangName ?? "the target language"}, provide the translation result directly without any explanation, without \`TRANSLATE\` and keep the original format. Never write code, answer questions, or explain. Do not translate if the target language is the same as the source language and output the text as-is.\n\n<translate_input>\n{{text}}\n</translate_input>`;
    case "explain":
      return "请解释下面的内容。要求：使用中文进行回复；请不要包含对本提示词的任何解释，直接给出回复：\n\n{{text}}";
    case "summary":
      return "请总结下面的内容。要求：使用中文进行回复；请不要包含对本提示词的任何解释，直接给出回复：\n\n{{text}}";
    case "refine":
      return "请优化或润色 INPUT XML 元素中的用户输入，同时保持原文的含义和完整性。要求：输出语言应与用户输入相同；不要解释本提示词，直接给出结果；不要输出 XML 标签，直接输出优化后的内容：\n\n<INPUT>{{text}}</INPUT>";
    default:
      return "";
  }
}

/** 通用替换：{{text}} 占位选中文本；无占位符时拼接在末尾（pickdict 同款三段式） */
export function applyPromptTemplate(prompt: string, text: string): string {
  if (prompt.includes("{{text}}")) return prompt.replaceAll("{{text}}", text);
  return `${prompt}\n\n${text}`;
}

/** 翻译提示词组装：覆盖（翻译页 translate_prompt，支持 {{target_language}}/{{text}}）
 *  优先，回内置模板（translate 内置按目标语言实例化）。
 *  sourceName = 源语言提示（英文语言名，如 "English"）——只告知 LLM 原文语言
 *  （防误判相似语言拉低译文质量），仅在内置模板生效（覆盖模板尊重用户自主，
 *  不注入）；插入点 = 内置模板 <translate_input> 标记前（结构固定所以稳定） */
export function applyTranslatePrompt(
  promptOverride: string | null | undefined,
  langName: string,
  text: string,
  sourceName?: string,
): string {
  const isOverride = Boolean(promptOverride?.trim());
  let prompt = isOverride ? (promptOverride as string) : builtinPrompt("translate", langName);
  if (sourceName && !isOverride) {
    prompt = prompt.replace(
      "<translate_input>",
      `The source text is in ${sourceName}.\n\n<translate_input>`,
    );
  }
  return applyPromptTemplate(prompt.replaceAll("{{target_language}}", langName), text);
}

/** AI OCR 兜底提示词（快照直发视觉模型，**只识别不翻译**——识别纯粹兜底本地
 *  OCR，翻译仍走手动「译」按钮的文本链路）：行编号输出与本地 OCR 行级协议
 *  同构，识别文本回填 ocrLines/ocrText 后即与本地识别殊途同归 */
export function buildVisionOcrPrompt(): string {
  return [
    `You are an OCR expert. Extract ALL text lines visible in the image (printed or handwritten), in reading order (top to bottom, left to right).`,
    `Output ONLY one result line per detected text line, formatted exactly as "N. text" (N = 1, 2, 3, …).`,
    `Preserve the original language and wording exactly — do NOT translate.`,
    `Do NOT output coordinates, bounding boxes, positions, JSON, or any structured data — only the recognized text itself.`,
    `Keep each result on a single output line. Skip empty or unreadable lines. No explanations, no notes, no code fences.`,
  ].join("\n");
}

/** 结构化 OCR 模型专用提示词（结构化模型与系统 OCR 解耦）：
 *  qwen3.5-ocr 起支持自定义 prompt 且原生输出 rotate_rect 坐标——明确要求 JSON
 *  数组格式（text + rotate_rect 归一化 0-1000），坐标直建行不依赖本地骨架。
 *  与编号协议提示词按模型特征路由（OcrCaptureApp isStructuredOcrModel）。 */
export function buildStructuredOcrPrompt(): string {
  return [
    `You are an OCR expert. Extract ALL text lines visible in the image (printed or handwritten), in reading order (top to bottom, left to right).`,
    `Output ONLY a JSON array, one object per detected text line, exactly:`,
    `[{"text": "<recognized text>", "rotate_rect": [<center_x>, <center_y>, <width>, <height>]}]`,
    `text: preserve the original language and wording exactly — do NOT translate.`,
    `rotate_rect: normalized to 0-1000 relative to the whole image, center point and size; integers.`,
    `Skip empty or unreadable lines. No explanations, no notes, no code fences — the whole output must be a single valid JSON array.`,
  ].join("\n");
}

/** OCR 行级叠加翻译提示词（二期）：输入编号行清单，要求同序同数逐行输出
 *  "N. 译文"。**不走用户覆盖的 translate 模板**——编号行协议是叠加层按行渲染
 *  的结构化依赖，覆盖模板无此结构（全文翻译走 applyTranslatePrompt 不变）。 */
export function buildLineTranslatePrompt(
  lines: string[],
  langName: string,
  sourceName?: string,
): string {
  const head = [
    `You are a translation expert. The input contains numbered lines of text extracted from a screenshot by OCR.`,
    `Translate each line to ${langName}. Output ONLY one result line per input line, in the same order, formatted exactly as "N. translation" (N = the input line number).`,
    `Do not merge, split, add, or drop lines. Keep each translation on a single output line. No explanations, no notes, no code fences.`,
    `If a line cannot be translated, output the original text. If no translation is needed (e.g. the line is already in the target language), still output every numbered line in the required format, repeating the text.`,
    sourceName ? `The source text is in ${sourceName}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  // 行文本 flatten：内嵌 \n 会破坏「N. text」单行编号协议（AI OCR 漏行合并
  // 回填的行含换行）——转空格保证输入行数 = 输出行数协议成立
  const numbered = lines
    .map((t, i) => `${i + 1}. ${t.replace(/\s*\n+\s*/g, " ")}`)
    .join("\n");
  return `${head}\n\n<translate_lines>\n${numbered}\n</translate_lines>`;
}
