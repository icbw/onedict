/**
 * 检查结果的展示常量：分类显示名与 severity 徽标配色。
 * 划词 bar 面板（ActionCheck）与主窗口检查页签共用，避免两处各写一份漂移。
 */
import type { CheckCategory, CheckSeverity } from "./finding";

export const CATEGORY_LABELS: Record<CheckCategory, string> = {
  layout: "排版",
  typo: "错别字",
  terminology: "术语",
  grammar: "语法",
  style: "文风",
  "ai-tell": "AI 腔",
};

export const SEVERITY_STYLES: Record<CheckSeverity, string> = {
  error: "bg-red-500/10 text-red-700",
  warning: "bg-amber-500/10 text-amber-700",
  info: "bg-slate-500/10 text-slate-600",
};
