/** 在线词典前端注册表（内置目录；启停/排序并入统一 dictItems 列表，id 前缀 `web-`）。
 *  id 与 Rust 侧 src-tauri/src/webdict/mod.rs 的 build_url 注册表对齐；
 *  显示名/实现/样式由本目录定义（不落盘）。 */
import baseCss from "./styles/base.css?raw";
import cambridgeCss from "./styles/cambridge.css?raw";
import youdaoCss from "./styles/youdao.css?raw";
import { cambridgeSearch, cambridgeWordFromUrl } from "./cambridge";
import { youdaoSearch, youdaoWordFromUrl } from "./youdao";
import type { DictItemPref } from "../../types/prefs";

export interface WebDictResult {
  /** 已消毒、已拼装的分区 HTML（进 iframe srcdoc） */
  html: string;
}

export interface WebDictDef {
  id: string;
  label: string;
  /** 来源页 URL（错误态「在浏览器中打开」入口） */
  srcPage: (word: string) => string;
  search: (word: string) => Promise<WebDictResult>;
  /** 词条帧样式（base 通用在前 + 词典私有在后，vite ?raw 内联注入 srcdoc） */
  css: string;
}

export const WEB_DICTS: Record<string, WebDictDef> = {
  "web-youdao": {
    id: "web-youdao",
    label: "有道词典",
    srcPage: (w) =>
      `https://dict.youdao.com/w/${encodeURIComponent(w.replace(/\s+/g, " "))}`,
    search: youdaoSearch,
    css: baseCss + youdaoCss,
  },
  "web-cambridge": {
    id: "web-cambridge",
    label: "剑桥词典",
    srcPage: (w) =>
      `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encodeURIComponent(
        w.replace(/\s+/g, " "),
      )}`,
    search: cambridgeSearch,
    css: baseCss + cambridgeCss,
  },
};

/** 统一 dictItems 列表 → 在线条目（id 前缀 `web-`，序随统一列表）。
 *  null = 内置目录默认全启用；内置目录新增源自动补尾（默认启用）。
 *  设置页与查询侧共用同一合并语义。 */
export function webItemsFromDictItems(
  items: DictItemPref[] | null | undefined,
): DictItemPref[] {
  if (items == null) {
    return Object.keys(WEB_DICTS).map((id) => ({ id, enabled: true }));
  }
  const list = items.filter((i) => i.id.startsWith("web-"));
  for (const id of Object.keys(WEB_DICTS)) {
    if (!list.some((i) => i.id === id)) list.push({ id, enabled: true });
  }
  return list;
}

/** 真外链 → 查询词（词典外链「转内部查词」模式）：
 *  ① 各源词链接钩子（youdao 站内 /w/、word=、q=）；② 通用 URL query 词参数；
 *  ③ 链接文本（BOOT_SCRIPT 随 onedict-external 附带，≤40 字且非 URL 形态）。
 *  全部落空返回 null（版权页/来源站等非词链接不动）。 */
export function wordFromExternalLink(url: string, text?: string): string | null {
  const w = youdaoWordFromUrl(url) ?? cambridgeWordFromUrl(url);
  if (w) return w;
  try {
    const u = new URL(url);
    const q = u.searchParams.get("word") ?? u.searchParams.get("q") ?? u.searchParams.get("query");
    if (q && q.trim()) return q.trim();
  } catch {
    /* 非 URL 形态 */
  }
  const t = (text || "").trim();
  if (t && t.length <= 40 && !/^https?:\/\//i.test(t) && !t.includes(" ")) {
    return t;
  }
  return null;
}
