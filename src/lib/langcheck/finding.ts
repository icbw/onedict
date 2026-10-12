/**
 * 语言检查统一 Finding 模型（规则层与 LLM 层同构；LC1 落地规则层）。
 *
 * 定位双轨：规则层带精确 span（UTF-16 下标，zhlint / 自建正则天然同单位），
 * LLM 层（LC3）只有 quote + prefix/suffix 锚点——两类结果在同一列表渲染。
 * 分类与 severity 的取值是「检查侧栏 + 划词 bar」双入口共用的稳定枚举。
 */

export type CheckCategory =
  /** 排版规范（中英空格 / 全半角标点等，zhlint） */
  | "layout"
  /** 错别字 / 拼写（LC2 词典驱动） */
  | "typo"
  /** 术语一致性（LC2 用户术语表） */
  | "terminology"
  /** 语法 / 搭配（LC3 LLM） */
  | "grammar"
  /** 文风可读性（句式冗余等） */
  | "style"
  /** AI 式表达特征（词表 / 句式） */
  | "ai-tell";

export type CheckSeverity = "info" | "warning" | "error";

export interface FindingSpan {
  /** UTF-16 code unit 下标（JS 字符串索引直接可用） */
  index: number;
  length: number;
}

export interface Finding {
  /** 稳定 id（ruleId + 序号；同文本重跑一致，幂等基线断言用） */
  id: string;
  ruleId: string;
  category: CheckCategory;
  severity: CheckSeverity;
  /** 人话描述（含修改建议；面板列表直接展示） */
  message: string;
  /** 精确定位（规则层必有；LC3 LLM 锚点失败时可能缺席 → 整体 nullable） */
  span: FindingSpan | null;
  /** 命中原文片段（尽量短） */
  quote: string;
  /** 锚点上下文（≤10 字；LLM 层定位与 UI 高亮共用） */
  prefix: string;
  suffix: string;
  /** 定位是否可靠（规则层恒 true；LC3 LLM 锚定降级时 false） */
  anchored: boolean;
  /** 单点建议替换（命中片段 → 新文本；null = 不可单点修复） */
  replacement: string | null;
  source: "rule" | "llm";
  fixable: boolean;
}

/** 上下文锚点的最大长度（前 / 后各取这么多字） */
export const CONTEXT_CHARS = 10;

/** 规则层 Finding 构造器：由精确 span 推导 quote / prefix / suffix。 */
export function ruleFinding(
  text: string,
  init: {
    ruleId: string;
    category: CheckCategory;
    severity: CheckSeverity;
    message: string;
    index: number;
    length: number;
    replacement?: string | null;
  },
  seq: number,
): Finding {
  const { index, length } = init;
  const safeIndex = Math.max(0, index);
  const safeEnd = Math.min(text.length, safeIndex + length);
  return {
    id: `${init.ruleId}#${seq}`,
    ruleId: init.ruleId,
    category: init.category,
    severity: init.severity,
    message: init.message,
    span: { index: safeIndex, length: Math.max(0, safeEnd - safeIndex) },
    quote: text.slice(safeIndex, safeEnd),
    prefix: text.slice(Math.max(0, safeIndex - CONTEXT_CHARS), safeIndex),
    suffix: text.slice(safeEnd, Math.min(text.length, safeEnd + CONTEXT_CHARS)),
    anchored: true,
    replacement: init.replacement ?? null,
    source: "rule",
    fixable: init.replacement != null && init.replacement !== text.slice(safeIndex, safeEnd),
  };
}
