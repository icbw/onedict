/**
 * 划词栏动作系统（对齐 pickdict action_items）。
 * 内置动作目录（label/icon/ai 依赖）为前端常量；偏好只持久化 id/启停/搜索引擎
 * （Rust ActionItemPref，camelCase）。AI 动作（translate/explain/summary/refine）
 * 已进目录与偏好，模型服务配置就绪（aiReady）后在栏上点亮。
 *  自定义 AI 动作（id 形如 user-*，name/prompt/model 持久化）与内置动作
 * 同列表渲染、同启停排序——语义扩展自 pickdict SelectionActionItem。
 */
import type { LucideIcon } from "lucide-react";
import {
  BookOpenText,
  ClipboardCopy,
  FileQuestion,
  Languages,
  ScanText,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";

export interface ActionPref {
  id: string;
  enabled: boolean;
  searchEngine?: string;
  /** 自定义 AI 动作：栏上显示名 */
  name?: string;
  /** 自定义 AI 动作提示词（{{text}} 占位选中文本；缺省 = 纯文本直发） */
  prompt?: string;
  /** 动作级模型覆盖（留空用全局配置） */
  model?: string;
  /** 自定义 AI 动作图标（lucide 图标名，lucide-react/dynamic 动态渲染） */
  icon?: string;
  /** 动作级思考开关（默认非思考；实际生效 = 开关 && 激活卡「推理模型」标记） */
  allowThink?: boolean;
}

export interface ResolvedAction extends ActionPref {
  label: string;
  Icon: LucideIcon;
  /** AI 依赖动作（AI 配置就绪前不在栏上渲染） */
  ai: boolean;
  /** 自定义动作（不在内置目录，id 形如 user-*） */
  custom?: boolean;
}

const BUILTIN: Record<string, { label: string; Icon: LucideIcon; icon: string; ai?: boolean }> = {
  dict: { label: "查词", Icon: BookOpenText, icon: "book-open-text" },
  translate: { label: "翻译", Icon: Languages, icon: "languages", ai: true },
  explain: { label: "解释", Icon: FileQuestion, icon: "file-question", ai: true },
  summary: { label: "总结", Icon: ScanText, icon: "scan-text", ai: true },
  search: { label: "搜索", Icon: Search, icon: "search" },
  copy: { label: "复制", Icon: ClipboardCopy, icon: "clipboard-copy" },
  refine: { label: "润色", Icon: WandSparkles, icon: "wand-sparkles", ai: true },
};

/** 内置动作的当前图标名（lucide 命名；编辑弹窗预填用——未覆盖时显示内置图标） */
export function builtinIconName(id: string): string {
  return BUILTIN[id]?.icon ?? "";
}

/** 默认动作集（顺序/启停对齐 pickdict 默认；未落盘时使用） */
export const DEFAULT_ACTION_PREFS: ActionPref[] = [
  { id: "dict", enabled: true },
  { id: "translate", enabled: true },
  { id: "explain", enabled: true },
  { id: "summary", enabled: true },
  {
    id: "search",
    enabled: true,
    searchEngine: "Google|https://www.google.com/search?q={{queryString}}",
  },
  { id: "copy", enabled: true },
  { id: "refine", enabled: false },
];

/** AI 配置就绪判定（实现随模型卡重构迁至 lib/aiConfig，此处 re-export 保持兼容） */
export { aiReady } from "./aiConfig";

/** 合并偏好与内置目录：保偏好顺序，未知 id 丢弃，缺失内置项追加（未启用）；
 *  自定义动作（user-*）按偏好原序参与列表 */
export function resolveActions(prefs: ActionPref[] | null | undefined): ResolvedAction[] {
  const list = prefs && prefs.length > 0 ? prefs : DEFAULT_ACTION_PREFS;
  const out: ResolvedAction[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (seen.has(p.id)) continue;
    const b = BUILTIN[p.id];
    if (b) {
      seen.add(p.id);
      out.push({ ...p, label: b.label, Icon: b.Icon, ai: b.ai ?? false });
    } else if (p.id.startsWith("user-")) {
      seen.add(p.id);
      out.push({
        ...p,
        label: p.name || "自定义动作",
        Icon: Sparkles,
        ai: true,
        custom: true,
      });
    }
    // 其余未知 id（已删除的旧数据）丢弃
  }
  for (const [id, b] of Object.entries(BUILTIN)) {
    if (!seen.has(id)) {
      out.push({ id, enabled: false, label: b.label, Icon: b.Icon, ai: b.ai ?? false });
    }
  }
  return out;
}

/** 搜索引擎配置形如 "Google|https://...{{queryString}}"；返回可打开的 URL */
export function engineUrl(searchEngine: string | undefined, text: string): string | null {
  if (!searchEngine) return null;
  const url = searchEngine.split("|")[1];
  return url ? url.replace("{{queryString}}", encodeURIComponent(text)) : null;
}

/** 搜索引擎展示名（"Google|url" → "Google"） */
export function engineName(searchEngine: string | undefined): string {
  return searchEngine?.split("|")[0] ?? "";
}
