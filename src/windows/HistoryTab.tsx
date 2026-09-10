/**
 * 查词历史独立页：Rust history.json（200 条上限，最近优先）
 * 的完整视图——词典页顶部 chips 只露出最近 8 条。搜索过滤 / 点击查词 / 单条删除 /
 * 清空；数据由 history-changed 广播驱动刷新（发起窗口也收，统一广播驱动 state）。
 * 点击行 = 重新查询：与词典页顶部历史 chips 同语义（history_add 幂等 count+1 置顶）
 * + MainApp lookupReq 管道切词典页（与生词本点词同路径）。
 * 记录边界沿用仅记显式查询（内链跳词/生词本点词不入）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { History, SearchX, X } from "lucide-react";
import { Input } from "@onedict/ui/components/input";
import {
  SettingGroup,
  SettingsContentColumn,
} from "../components/SettingsPrimitives";
import type { HistoryEntry } from "../types/history";

/** 最近时间标签：今天 → HH:mm，否则 YYYY-MM-DD HH:mm（cherry formatCreatedAt 简化） */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export default function HistoryTab({ onLookup }: { onLookup: (word: string) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");

  // 拉取 + 监听变更广播（历史页/词典页/清空同源，统一广播刷新）
  const reload = useCallback(() => {
    void invoke<HistoryEntry[]>("history_list").then(setEntries).catch(() => {});
  }, []);
  useEffect(() => {
    reload();
    const un = listen("history-changed", reload);
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, [reload]);

  /** 本地过滤：词头包含（大小写不敏感），保最近优先序 */
  const filtered = useMemo(() => {
    if (entries === null) return [];
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.word.toLowerCase().includes(q));
  }, [entries, query]);

  /** 点击行 = 重新查询：置顶计数（与词典页 chips 一致）+ 跳词典页 */
  const lookup = (word: string) => {
    void invoke("history_add", { word }).catch(() => {});
    onLookup(word);
  };

  const loaded = entries !== null;

  return (
    <SettingsContentColumn>
      {/* 头部：标题 + 计数 + 搜索 + 清空 */}
      <SettingGroup className="flex items-center gap-3">
        <History className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-semibold text-[15px]">查词历史</span>
        {loaded && entries.length > 0 && (
          <span className="shrink-0 text-muted-foreground text-xs">{entries.length} 词</span>
        )}
        <div className="flex-1" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索词头…"
          spellCheck={false}
          className="h-8 w-[180px] shrink-0"
        />
        {loaded && entries.length > 0 && (
          <button
            type="button"
            onClick={() => void invoke("history_clear").catch(() => {})}
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-muted-foreground text-xs transition-colors hover:text-foreground"
          >
            清空
          </button>
        )}
      </SettingGroup>

      {/* 列表：最近优先；行点击查词，hover 露单条删除 */}
      {loaded && entries.length > 0 && (
        <SettingGroup className="p-0">
          {filtered.map((e) => (
            <div
              key={e.normKey}
              className="group flex items-center border-border border-b last:border-b-0"
            >
              <button
                type="button"
                onClick={() => lookup(e.word)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/50"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{e.word}</span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {e.count > 1 ? `${e.count} 次` : ""}
                </span>
                <span className="w-[124px] shrink-0 text-right text-muted-foreground text-xs tabular-nums">
                  {fmtTime(e.lastAt)}
                </span>
              </button>
              <button
                type="button"
                title="删除该条"
                onClick={(ev) => {
                  ev.stopPropagation();
                  void invoke("history_remove", { word: e.word }).catch(() => {});
                }}
                className="mr-2 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 py-12 text-muted-foreground">
              <SearchX className="size-5" />
              <span className="text-xs">没有匹配「{query.trim()}」的历史</span>
            </div>
          )}
        </SettingGroup>
      )}

      {loaded && entries.length === 0 && (
        <SettingGroup>
          <p className="text-muted-foreground text-sm">
            暂无查词历史——在词典页输入词头查询后自动记录（仅记显式查询）。
          </p>
        </SettingGroup>
      )}
    </SettingsContentColumn>
  );
}
