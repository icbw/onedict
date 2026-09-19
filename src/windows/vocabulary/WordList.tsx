/**
 * 单元词表（虚拟滚动）。
 *
 * 词数超过阈值时启用 @tanstack/react-virtual：限高容器 + 绝对定位行，
 * 千词收词箱也只渲染可视区——取代此前「只渲染前 50 条 + 显示全部」的止血方案
 * （大单元常驻上千 DOM 节点，keep-alive 下不释放）。
 * 阈值以下保持自然流动（跟随页面滚动），避免小列表出现内滚动条。
 *
 * 行内交互与迁移前一致：点击词头跳词典页查词、hover 出「移入单元」与删除。
 * 高度经 measureElement 实测修正（长词换行/分隔线不按估算值错位）。
 */
import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FolderInput, Trash2 } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@onedict/ui/components/dropdown-menu";
import { dayKeyOf } from "../../lib/stats";
import type { VocabularyEntry } from "../../types/vocabulary";

/** 虚拟滚动阈值：超过即启用（约 40 行 ≈ 两屏） */
const VIRTUAL_THRESHOLD = 40;
/** 单行估算高度（py-2 + 两行文字）——实测值由 measureElement 修正 */
const ROW_HEIGHT = 53;
/** 虚拟滚动区最大高度 */
const MAX_LIST_HEIGHT = 520;

/** 词条可移入的目标单元（收词箱以 isInbox 标记） */
export interface WordListUnit {
  id: string;
  name: string;
  isInbox: boolean;
}

export default function WordList({
  entries,
  now,
  moveTargets,
  onLookup,
  onMove,
  onRemove,
}: {
  /** 词表（父组件已按加入时间倒序） */
  entries: VocabularyEntry[];
  /** 当前时间（到期判断；随刷新推进） */
  now: number;
  /** 移入单元的候选（含收词箱） */
  moveTargets: WordListUnit[];
  onLookup: (word: string) => void;
  onMove: (entryId: string, unitId: string) => void;
  onRemove: (entryId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualized = entries.length > VIRTUAL_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    enabled: virtualized,
  });

  // 空态文案由调用方区分（收词箱 / 自建单元），此处不渲染
  if (entries.length === 0) return null;

  /** 单行（含与上一行之间的分隔线；index 0 不出线） */
  const row = (entry: VocabularyEntry, index: number) => {
    const dueNow = entry.dueAt <= now;
    const targets = moveTargets.filter((u) => u.id !== entry.unitId);
    return (
      <div>
        {index > 0 && <div className="border-border-subtle border-t" />}
        <div className="group flex items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => onLookup(entry.word)}
              title={`查询 ${entry.word}`}
              className="block max-w-full cursor-pointer truncate text-left font-medium text-sm transition-colors hover:text-primary"
            >
              {entry.word}
            </button>
            <div className="text-muted-foreground text-xs">
              添加于 {dayKeyOf(entry.addedAt)}
              {" · "}
              {dueNow ? (
                <span className="text-orange-600">待复习</span>
              ) : (
                `到期 ${dayKeyOf(entry.dueAt)}`
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none"
                aria-label="移入单元"
                title="移入单元"
              >
                <FolderInput className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>移入单元</DropdownMenuLabel>
                {targets.map((u) => (
                  <DropdownMenuItem key={u.id} onClick={() => onMove(entry.id, u.id)}>
                    {u.isInbox ? "收词箱" : u.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="删除"
              title="从生词本删除"
              onClick={() => onRemove(entry.id)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    );
  };

  if (!virtualized) {
    return (
      <>
        {entries.map((entry, i) => (
          <div key={entry.id}>{row(entry, i)}</div>
        ))}
      </>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="overflow-y-auto"
      style={{ height: Math.min(entries.length * ROW_HEIGHT, MAX_LIST_HEIGHT) }}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const entry = entries[item.index];
          return (
            <div
              key={entry.id}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row(entry, item.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
