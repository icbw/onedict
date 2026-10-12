/**
 * 收词语境管理弹窗（M4 隐私收口）：查看 / 编辑 / 清除。
 *
 * 语境可能含敏感内容（工作文档、私聊），本弹窗是用户对已存语境的控制入口：
 * - 查看：来源应用 / 捕获时间 / 采集方式 + 原句高亮词形（sentenceHighlight 复用）；
 * - 编辑：原句可改（≤500 字；清空 = 降级态仅来源元数据）。修改原句后挖空定位
 *   与中文对译失效（Rust 侧丢越界偏移 / 清 sentenceZh），编辑态小字提示；
 * - 清除：context 整体删除 + 卡面对译连带清（二次确认）。
 *
 * sense（释义快照）与语境独立，不随清除联动；保存/清除成功后由
 * vocabulary-changed 事件驱动父级刷新，进行中的复习会话为快照、下次生效。
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PencilLine, Trash2 } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Textarea } from "@onedict/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@onedict/ui/components/dialog";
import { sentenceHighlight } from "../../lib/vocabContext";
import type { VocabularyEntry } from "../../types/vocabulary";

/** 采集方式显示名（kind 值见 Rust EntryContext） */
const KIND_LABELS: Record<string, string> = {
  selection: "划词",
  clipboard: "剪贴板",
  manual: "手动",
};

/** 语境句长上限（与 Rust CONTEXT_SENTENCE_MAX_CHARS 对齐；超长入库截断） */
const SENTENCE_MAX = 500;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ContextDialog({
  entry,
  onClose,
}: {
  entry: VocabularyEntry;
  onClose: () => void;
}) {
  const ctx = entry.context;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(ctx?.sentence ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ctx) return null;

  const hl = sentenceHighlight(ctx.sentence, ctx.wordOffset);
  const kind = KIND_LABELS[ctx.kind] ?? ctx.kind;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("vocabulary_context_set", {
        id: entry.id,
        context: { ...ctx, sentence: draft.trim() },
      });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const clear = async () => {
    if (
      !window.confirm(
        `清除「${entry.word}」的收词语境？原句与来源记录将一并删除（词条与释义保留）。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await invoke("vocabulary_context_set", { id: entry.id, context: null });
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex flex-col gap-4">
        <div className="flex items-center gap-2.5 pr-8">
          <DialogTitle className="truncate text-base font-semibold">
            收词语境 · {entry.word}
          </DialogTitle>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-[10px]">
            {kind}
          </span>
        </div>

        {/* 元数据（只读）：来源应用 + 捕获时间 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-xs">
          {ctx.sourceApp && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground/60">来源</span>
              <span className="max-w-48 truncate text-foreground/80">{ctx.sourceApp}</span>
            </span>
          )}
          {ctx.capturedAt > 0 && (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground/60">捕获于</span>
              <span className="text-foreground/80">{fmtTime(ctx.capturedAt)}</span>
            </span>
          )}
        </div>

        {/* 原句：查看态高亮词形 / 编辑态 textarea */}
        {editing ? (
          <div className="space-y-1.5">
            <Textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, SENTENCE_MAX))}
              className="min-h-24 resize-y text-sm leading-relaxed"
              spellCheck={false}
              placeholder="原句（清空 = 仅保留来源记录）"
            />
            <p className="text-muted-foreground/70 text-[11px]">
              修改原句后，复习挖空定位与中文对译可能失效；{draft.trim().length}/{SENTENCE_MAX} 字
            </p>
          </div>
        ) : (
          <div className="rounded-md bg-muted/50 px-3 py-2.5 select-text">
            {ctx.sentence ? (
              <p className="text-sm leading-relaxed break-words text-foreground/90">
                {hl ? (
                  <>
                    {hl.before}
                    <span className="rounded bg-amber-500/25 px-0.5 font-medium text-foreground">
                      {hl.hit}
                    </span>
                    {hl.after}
                  </>
                ) : (
                  ctx.sentence
                )}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">（无原句，仅来源记录）</p>
            )}
          </div>
        )}

        {error && <p className="text-destructive text-xs">{error}</p>}

        {/* 操作区 */}
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="h-8"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraft(ctx.sentence);
                  setError(null);
                }}
              >
                取消
              </Button>
              <Button type="button" className="h-8" disabled={busy} onClick={() => void save()}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => {
                  setDraft(ctx.sentence);
                  setEditing(true);
                  setError(null);
                }}
              >
                <PencilLine className="size-3.5" />
                编辑原句
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-8 gap-1.5 text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => void clear()}
              >
                <Trash2 className="size-3.5" />
                清除语境
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
