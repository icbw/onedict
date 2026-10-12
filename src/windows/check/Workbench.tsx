/**
 * 检查工作台：编辑区 / 结果双栏（外壳持有文本与 findings，本组件纯展示 + 局部交互）。
 *
 * 编辑区内联高亮用「镜像叠加」实现：镜像 div（与 textarea 同字体度量，
 * whitespace-pre-wrap + break-words）在后渲染 findings 波浪线与选中高亮并撑起
 * 高度，textarea 绝对定位铺满其上、文字透明、容器整体滚动（无滚动同步问题）。
 * IME 组字期textarea 文字临时恢复可见（组合文本不出现在镜像里，不恢复则
 * 组字内容不可见——中文输入的硬需求），期间镜像文字转透明避免重影。
 *
 * 结果点击 → 镜像内对应 mark 滚动居中 + textarea 选区带过去（可直接键入替换）。
 * 文本与 findings 未同步（停顿窗口内）时隐藏波浪线并禁用修复，避免旧偏移
 * 误导；忽略/白名单键控不受窗口影响。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { Loader2, Wand2 } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { cn } from "../../lib/utils";
import { CATEGORY_LABELS, SEVERITY_STYLES } from "../../lib/langcheck/labels";
import type { CheckSeverity, Finding } from "../../lib/langcheck/finding";

/** "all" 或六分类之一（当前侧栏只暴露规则层能产出的五类，语法类留给 LLM 层接入） */
export type CategoryFilter = "all" | "layout" | "typo" | "terminology" | "grammar" | "style" | "ai-tell";

const SEVERITY_DECOR: Record<CheckSeverity, string> = {
  error: "decoration-red-500",
  warning: "decoration-amber-500",
  info: "decoration-slate-400",
};

interface Segment {
  text: string;
  finding?: Finding;
}

/** 由 findings（按位置升序、跳过重叠与越界）切出的镜像文本段 */
function buildSegments(text: string, findings: Finding[]): Segment[] {
  const segs: Segment[] = [];
  let cursor = 0;
  for (const f of findings) {
    if (!f.span || f.span.length <= 0) continue;
    const start = f.span.index;
    const end = start + f.span.length;
    if (start < cursor || end > text.length) continue;
    if (start > cursor) segs.push({ text: text.slice(cursor, start) });
    segs.push({ text: text.slice(start, end), finding: f });
    cursor = end;
  }
  if (cursor < text.length) segs.push({ text: text.slice(cursor) });
  return segs;
}

export interface WorkbenchProps {
  category: CategoryFilter;
  text: string;
  /** 已过滤忽略项的全量 findings（分类过滤在组件内做，镜像标记不受分类影响） */
  findings: Finding[];
  checking: boolean;
  /** findings 是否对应当前文本（停顿窗口内为 false） */
  fresh: boolean;
  selectedId: string | null;
  ignoredCount: number;
  onText: (text: string) => void;
  onSelect: (id: string | null) => void;
  onFix: (f: Finding) => void;
  onFixAll: (list: Finding[]) => void;
  onIgnore: (ruleId: string, quote: string) => void;
  onWhitelist: (word: string) => void;
}

export default function Workbench(props: WorkbenchProps) {
  const { category, text, findings, checking, fresh, selectedId, ignoredCount } = props;

  const list = useMemo(
    () => (category === "all" ? findings : findings.filter((f) => f.category === category)),
    [findings, category],
  );
  const fixable = useMemo(
    () => list.filter((f) => f.fixable && f.replacement !== null),
    [list],
  );

  // 停顿窗口内偏移不可信 → 镜像退化为纯文本（保留高度支撑）
  const segments = useMemo(
    () => (fresh ? buildSegments(text, findings) : [{ text }]),
    [fresh, text, findings],
  );

  // IME 组字期：textarea 文字可见、镜像文字透明
  const [composing, setComposing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const selectedFinding = useMemo(
    () => findings.find((f) => f.id === selectedId) ?? null,
    [findings, selectedId],
  );

  // 结果点击 → 滚动到镜像 mark 居中 + 选区带过去（可直接键入替换）
  useEffect(() => {
    if (!selectedId || !selectedFinding) return;
    const el = mirrorRef.current?.querySelector<HTMLElement>(
      `[data-finding-id="${selectedId}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (fresh && selectedFinding.span) {
      const ta = taRef.current;
      if (ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(
          selectedFinding.span.index,
          selectedFinding.span.index + selectedFinding.span.length,
        );
      }
    }
  }, [selectedId, selectedFinding, fresh]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* 编辑区：滚动容器 + 镜像（撑高）+ 透明 textarea */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-border">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="relative min-h-full">
              <div
                ref={mirrorRef}
                aria-hidden
                className={cn(
                  "p-4 font-sans text-sm leading-6 break-words whitespace-pre-wrap select-none",
                  composing && "text-transparent",
                )}
              >
                {segments.map((seg, i) =>
                  seg.finding ? (
                    <mark
                      key={seg.finding.id}
                      data-finding-id={seg.finding.id}
                      className={cn(
                        "rounded-sm bg-transparent underline decoration-wavy underline-offset-4",
                        SEVERITY_DECOR[seg.finding.severity],
                        selectedId === seg.finding.id && "bg-amber-400/45 no-underline",
                      )}
                    >
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
                {/* 空文本时给镜像一个最小行高，placeholder 区不塌陷 */}
                {text.length === 0 && <span>&#8203;</span>}
              </div>
              <textarea
                ref={taRef}
                value={text}
                spellCheck={false}
                placeholder="粘贴或输入要检查的文本——停顿后自动检查；结果点击可定位到原文"
                onChange={(e) => props.onText(e.currentTarget.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={(e) => {
                  setComposing(false);
                  props.onText(e.currentTarget.value);
                }}
                className={cn(
                  "absolute inset-0 w-full resize-none overflow-hidden rounded-none border-0 bg-transparent p-4 font-sans text-sm leading-6 break-words outline-none",
                  composing ? "text-foreground" : "text-transparent",
                )}
              />
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-muted-foreground text-xs">
            <span>{text.length} 字</span>
            <span>{fresh ? "结果与文本同步" : "文本已改动，重新检查中…"}</span>
          </div>
        </div>

        {/* 结果列表 */}
        <div className="flex w-[380px] shrink-0 flex-col">
          <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              {checking && <Loader2 className="size-3.5 animate-spin" />}
              {checking ? "检查中…" : `发现 ${list.length} 处`}
            </span>
            {ignoredCount > 0 && (
              <span className="text-muted-foreground/70 text-xs">已忽略 {ignoredCount} 处</span>
            )}
            {fresh && fixable.length > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto h-6 gap-1 px-2 text-xs"
                onClick={() => props.onFixAll(list)}
              >
                <Wand2 className="size-3" />
                全部修复（{fixable.length}）
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {list.length === 0 ? (
              <p className="rounded-md bg-muted/50 px-3 py-4 text-center text-muted-foreground text-sm">
                {text.trim()
                  ? category === "all"
                    ? "未发现问题。"
                    : "该分类下未发现问题。"
                  : "输入或粘贴文本后自动检查。"}
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {list.map((f) => (
                  <ResultItem
                    key={f.id}
                    finding={f}
                    selected={f.id === selectedId}
                    fresh={fresh}
                    onSelect={props.onSelect}
                    onFix={props.onFix}
                    onIgnore={props.onIgnore}
                    onWhitelist={props.onWhitelist}
                  />
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultItem({
  finding: f,
  selected,
  fresh,
  onSelect,
  onFix,
  onIgnore,
  onWhitelist,
}: {
  finding: Finding;
  selected: boolean;
  fresh: boolean;
  onSelect: (id: string | null) => void;
  onFix: (f: Finding) => void;
  onIgnore: (ruleId: string, quote: string) => void;
  onWhitelist: (word: string) => void;
}) {
  const canFix = fresh && f.fixable && f.replacement !== null;
  return (
    <li
      className={cn(
        "cursor-pointer rounded-md border px-2.5 py-2 transition-colors",
        selected ? "border-primary/50 bg-primary/5" : "border-border-subtle hover:bg-accent/40",
      )}
      onClick={() => onSelect(f.id)}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-medium text-[10px] leading-4",
            SEVERITY_STYLES[f.severity],
          )}
        >
          {CATEGORY_LABELS[f.category]}
        </span>
        {/* 上下文：前缀 + 命中高亮 + 后缀（无定位条目退化显示 quote） */}
        <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {f.span ? (
            <>
              {f.prefix}
              <span className="rounded bg-amber-500/25 px-0.5 font-medium text-foreground">
                {f.quote}
              </span>
              {f.suffix}
            </>
          ) : (
            f.quote
          )}
        </p>
      </div>
      <p className="mt-1 text-[13px] leading-snug break-words text-foreground/90">{f.message}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {canFix && (
          <MiniBtn
            onClick={(e) => {
              e.stopPropagation();
              onFix(f);
            }}
          >
            修复
          </MiniBtn>
        )}
        <MiniBtn
          onClick={(e) => {
            e.stopPropagation();
            onIgnore(f.ruleId, f.quote);
          }}
        >
          忽略
        </MiniBtn>
        {f.ruleId === "spell" && (
          <MiniBtn
            onClick={(e) => {
              e.stopPropagation();
              onWhitelist(f.quote.toLowerCase());
            }}
          >
            白名单
          </MiniBtn>
        )}
        {!fresh && (
          <span className="text-muted-foreground/60 text-[10px]">文本已改动，待重新检查</span>
        )}
      </div>
    </li>
  );
}

/** 结果条目内的小动作按钮（不打断条目点击选中） */
function MiniBtn({ children, onClick }: { children: ReactNode; onClick: (e: MouseEvent) => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded px-1.5 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}
