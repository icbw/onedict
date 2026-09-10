/**
 * OCR 行级叠加翻译协议（二期）：
 * - 提示词 = actionPrompts.ts buildLineTranslatePrompt（提示词单一事实源）
 * - 本文件 = 流式输出「N. 译文」的解析（纯函数零依赖）
 *
 * 流式语义：useAiStream 每增量给全量累积串，useMemo 全量重解析（行数小零成本），
 * 部分行就绪即渲染对应叠加块。`degraded` = 当前累积串解析不到任何编号行——
 * **仅在 loading 结束后作为降级信号**（流式首 token 常为空/前导语，中途不得降级）；
 * 降级 = 模型不守编号格式，调用方回退全文翻译模式（叠加层不启用，主流程不阻塞）。
 */

/** 1-3 位行号 + 常见分隔符；容忍全角点/顿号/冒号 */
const LINE_RE = /^\s*(\d{1,3})\s*[.、)）:：]\s*(.+)$/;

export interface ParsedLineTranslations {
  /** 行号(1-based) → 已就绪译文（同号重出现取最后，容忍模型重写） */
  map: Map<number, string>;
  /** 当前累积串无任何编号行（仅在流式结束后作为 degraded 判定用） */
  degraded: boolean;
}

export function parseNumberedLines(content: string): ParsedLineTranslations {
  const map = new Map<number, string>();
  if (!content) return { map, degraded: false };
  for (const raw of content.split("\n")) {
    const line = stripCoords(stripTags(raw)).trim();
    // 容错：markdown 代码围栏行直接跳过（模型偶尔把输出包进代码块）
    if (!line || line.startsWith("```")) continue;
    const m = LINE_RE.exec(line);
    if (m) map.set(Number(m[1]), m[2].trim());
  }
  return { map, degraded: map.size === 0 };
}

/** 已解析译文按 1..lineCount 顺序拼全文（缺行跳过；全缺返回空串） */
export function joinTranslations(map: Map<number, string>, lineCount: number): string {
  const out: string[] = [];
  for (let i = 1; i <= lineCount; i++) {
    const t = map.get(i);
    if (t) out.push(t);
  }
  return out.join("\n");
}

/**
 * qwen-vl 系 grounding/OCR 标记清洗（实机验证：视觉模型在 OCR
 * 语义下会输出 box 坐标标记——标签对 / 特殊 token 字面量，未清洗时坐标串
 * 被当识别文本回填 = 叠加层「只见坐标不见文字」）：
 * - box/quad 标签对连坐标内容整剥（内容 = 坐标，无识别价值）
 * - ref/object_ref/ocr 包裹标签剥标签保留其中的文字
 * - qwen 特殊 token：box_start…box_end 对之间夹坐标内容，**连内容整剥**；
 *   ocr/object_ref 对内的文字保留，只剥标记本身；im/vision 边界剥除
 */
const GROUNDING_MARKUP_RE = /<(?:box)>[\s\S]*?<\/(?:box)>|<(?:quad)>[\s\S]*?<\/(?:quad)>/gi;
const GROUNDING_TAG_RE = /<\/?(?:ref|object_ref|ocr)>/gi;
const QWEN_BOX_RE = /<\|box_start\|>[\s\S]*?<\|box_end\|>/gi;
const QWEN_TOKEN_RE =
  /<\|(?:object_ref_start|object_ref_end|box_start|box_end|ocr_start|ocr_end|im_start|im_end|vision_start|vision_end)\|>/gi;

function stripTags(s: string): string {
  return s
    .replace(GROUNDING_MARKUP_RE, "")
    .replace(GROUNDING_TAG_RE, "")
    .replace(QWEN_BOX_RE, "")
    .replace(QWEN_TOKEN_RE, "");
}

/** 裸坐标残片（实机验证二轮：qwen-vl-ocr 编号行尾附旋转矩形/纯坐标
 * 行）：方括号数字组（至少一个逗号，容忍嵌套与圆括号）与圆括号数字对——
 * 识别文本不含纯数字坐标形态，误剥风险低；**仅文本路径使用**（JSON 路径坐标
 * 是合法值，先剥会破坏 JSON） */
const COORD_BRACKETS_RE = /\[[^\[\]]*\d[^\[\]]*,[^\[\]]*\d[^\[\]]*\]/g;
const COORD_PARENS_RE = /\(\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)+\s*\)/g;
/** TUPLE/LINE/BRACKETS/PARENS 剥除后的空括号残片（`[]` / `[,]` / `()` / `(,)`），
 * 来自元组被剥后剩空容器——不剥会污染识别文本行尾 */
const COORD_EMPTY_BRACKET_RE = /\[\s*,?\s*\]|\(\s*,?\s*\)/g;
/** 行内 4-5 元数字元组（实机验证四轮+五轮：qwen-vl-ocr 一行多组
 * `268,110,55,319,90 420,204,53,625,90 ...` + 截断尾巴 `334,)` + **分隔符
 * 抖动**如 `33,3 3,90`——分隔符放宽为 `[\s,]+` 容忍空白替逗号；全局不锚定
 * 行首行尾，逐组剥除 */
const COORD_TUPLE_RE = /-?\d+(?:\.\d+)?(?:[\s,]+-?\d+(?:\.\d+)?){3,4}/g;
/** 整行 4-5 元数字逗号行（单组形态：每行一个 5 元组；4 元 bbox 兼容） */
const COORD_LINE_RE =
  /^[ \t]*-?\d+(?:\.\d+)?(?:[ \t]*,[ \t]*-?\d+(?:\.\d+)?){3,4}[ \t]*$/gm;
/** 剥后行是坐标残片时整行丢——三种形态任一命中：
 * 1. 行末截断残片（`,)` `,]` `,`）
 * 2. 行首逗号残片（`,90`——TUPLE 部分剥离后尾部）
 * 3. 数字 token ≥ 4 整行只含噪声字符（坐标数据列表形态）
 * **不**对短数字行（< 4 数字）一刀切丢——保留「3, 14, 15」等合法短数据列表 */
function isCoordNoiseRow(s: string): boolean {
  if (!/^[\s\d,.\-+()\[\]]+$/.test(s)) return false;
  if (/[,)\]]\s*$/.test(s) || /^[ \t]*,/.test(s)) return true;
  const nums = s.match(/-?\d+(?:\.\d+)?/g);
  return nums !== null && nums.length >= 4;
}
/** 仅含 JSON 语法字符的残行（多行 JSON 提取失败回退逐行时的 `[` / `},` 等） */
const JSON_SYNTAX_ONLY_RE = /^[\][{},]+$/;

function stripCoords(s: string): string {
  return s
    .replace(COORD_TUPLE_RE, "")
    .replace(COORD_LINE_RE, "")
    .replace(COORD_BRACKETS_RE, "")
    .replace(COORD_PARENS_RE, "")
    .replace(COORD_EMPTY_BRACKET_RE, "");
}

/** 结构化输出的文本字段名宽容匹配（模型间字段名不统一：text/transcription/…） */
const JSON_TEXT_KEYS = ["text", "transcription", "content", "label", "value"] as const;

function jsonItemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    for (const k of JSON_TEXT_KEYS) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v;
    }
  }
  return "";
}

/** rotate_rect 字段宽容键名（qwen3.5-ocr rotate_rect 实测；驼峰/异名预防） */
const JSON_RECT_KEYS = ["rotate_rect", "rotateRect", "rotated_rect"] as const;

/** 从 JSON 项抽坐标数组：仅**数组形态 4-5 元全数字**（[cx,cy,w,h,(angle)]，
 *  对象形态键名未标定不猜；消费端 ocrAlign L2 另有归一化超界防御） */
function jsonItemRect(item: Record<string, unknown>): number[] | undefined {
  for (const k of JSON_RECT_KEYS) {
    const v = item[k];
    if (Array.isArray(v) && v.length >= 4 && v.length <= 5) {
      const nums = v.map((x) => (typeof x === "number" ? x : Number(x)));
      if (nums.every((n) => Number.isFinite(n))) return nums;
    }
  }
  return undefined;
}

/** AI OCR 结构化项（提取层输出； 解耦）：text = 识别文本；
 *  rect = 模型自带坐标（rotate_rect 归一化 0-1000 [cx,cy,w,h,(angle)]，
 *  格式未经实机验证标定——消费端 ocrAlign L2 有防御降级） */
export interface AiOcrItem {
  text: string;
  rect?: number[];
}

/**
 * AI OCR 输出宽容提取（**结构化项**数组 解耦扩展）：编号解析为空
 * 时的降级路径——OCR 专用模型（qwen-ocr / deepseek-ocr 等）常不守「N. text」行
 * 协议，直接输出纯识别文本。清洗链：剥 think 思考块（第三方网关常把思考标签混进
 * 正文，未闭合 = 其后全部视为思考剥除）→ 剥 grounding 标签（见 stripTags）→
 * JSON 路径（数组/逐行对象，坐标是合法值用原文**并保留 rotate_rect**）→ 文本
 * 路径剥坐标残片（见 stripCoords）→ 剥 markdown 代码围栏行 → 过滤空行；其余行
 * 原样保留（AI OCR 本意 = 识别文本回填，不因输出格式不符整丢弃）。
 * **JSON 结构化输出适配**（实测：qwen3.5-ocr 返回
 * `[{rotate_rect: [...], text: "..."}]` 坐标+文本数组）：整体解析 JSON 数组提取
 * 文本字段按序回填，**rotate_rect 一并保留**（结构化模型独立建行的位置来源，
 * 见 ocrAlign L2；字段名宽容见 jsonItemText/jsonItemRect），元素容忍纯字符串；
 * 截断/非 JSON 回退逐行；数组解析成功但无任何文本字段（纯坐标结构）返回空交
 * 上层报错（回退逐行 = 坐标 JSON 原文污染识别文本）。逐行 JSON 对象同理：
 * 提取到文本用之（带 rect 保 rect），纯坐标对象丢弃。
 */
export function extractOcrItems(content: string): AiOcrItem[] {
  if (!content) return [];
  // 清洗顺序（实机验证二轮）：think 剥除 → 标签剥除 → JSON 路径用
  // **原文**（坐标是 JSON 合法值，先剥会破坏结构，qwen3.5-ocr 依赖此路径）→
  // 文本逐行路径才剥坐标残片（qwen-vl-ocr 行尾坐标/纯坐标行）
  const lines = stripTags(
    content
      .replace(/<(?:think)>[\s\S]*?<\/(?:think)>/gi, "")
      .replace(/<(?:think)>[\s\S]*$/i, ""),
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```"));
  const joined = lines.join("\n");
  if (joined.startsWith("[")) {
    const fromArray = (src: string): AiOcrItem[] | null => {
      try {
        const arr: unknown = JSON.parse(src);
        if (!Array.isArray(arr)) return null;
        return arr
          .map((item): AiOcrItem => {
            const text = jsonItemText(item).trim();
            const rect =
              item && typeof item === "object"
                ? jsonItemRect(item as Record<string, unknown>)
                : undefined;
            return rect ? { text, rect } : { text };
          })
          .filter((it) => it.text.length > 0);
      } catch {
        return null;
      }
    };
    const direct = fromArray(joined);
    if (direct) return direct.length ? direct : [];
    // 截断修复（qwen-vl-ocr 默认 max_tokens 4096，坐标输出易截断）：截到最后
    // 一个完整对象补 `]` 重试
    const lastBrace = joined.lastIndexOf("}");
    if (lastBrace > 0) {
      const repaired = fromArray(joined.slice(0, lastBrace + 1) + "]");
      if (repaired) return repaired.length ? repaired : [];
    }
  }
  const out: AiOcrItem[] = [];
  for (const l of lines) {
    // JSON 对象行（完整含尾逗号/截断片段，含截断数组首元素 `[{`）：整体
    // parse 优先，失败用文本键值正则抽取；JSON 语法行提取不到文本即丢弃
    // （坐标残片不是识别文本）
    if ((l.startsWith("{") || l.startsWith("[{")) && l.includes('":')) {
      const cand = l.startsWith("[{") ? l.slice(1) : l;
      let item: Record<string, unknown> | null = null;
      try {
        item = JSON.parse(cand.replace(/,\s*$/, "")) as Record<string, unknown>;
      } catch {
        item = null;
      }
      if (item) {
        const text = jsonItemText(item).trim();
        if (text) {
          const rect = jsonItemRect(item);
          out.push(rect ? { text, rect } : { text });
        }
      } else {
        const m = /"(?:text|transcription|content|label|value)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(cand);
        if (m?.[1]) out.push({ text: m[1] });
      }
      continue;
    }
    // 纯 JSON 语法残行（多行 JSON 回退逐行的 `[` / `},` 等）丢弃
    if (JSON_SYNTAX_ONLY_RE.test(l)) continue;
    const stripped = stripCoords(l).trim();
    if (stripped && !isCoordNoiseRow(stripped)) out.push({ text: stripped });
  }
  return out;
}

/**
 * AI OCR 输出宽容提取（识别文本行数组）：extractOcrItems 的文本投影（历史
 * API，行为基线 test/ocrlines.mjs 消费）；结构化模型坐标保留走 extractOcrItems。
 */
export function extractOcrLines(content: string): string[] {
  return extractOcrItems(content).map((it) => it.text);
}
