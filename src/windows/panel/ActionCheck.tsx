/**
 * 查检动作视图（划词面板，LC1）：选中即检——规则层本地同步执行（毫秒级、
 * 零网络、零 AI 依赖），渲染统一 Finding 列表。
 *
 * 面板场景 = 文本在别处：修复以「复制」承载——单条复制建议替换文本；
 * 「合并复制修复后全文」= applyFixes 应用全部可修复项，用户回原应用粘贴覆盖。
 * 不可单点修复的条目（句式 / 结构问题）只提示，无复制按钮。
 * LC3 将在头部追加「LLM 深查」按钮（语法层，ai_stream 流式）。
 */
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCheck, Copy } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Tooltip } from "@onedict/ui/components/tooltip";
import { cn } from "../../lib/utils";
import { applyFixes, runRuleChecks } from "../../lib/langcheck/engine";
import { CATEGORY_LABELS, SEVERITY_STYLES } from "../../lib/langcheck/labels";
import type { Finding } from "../../lib/langcheck/finding";

export default function ActionCheck({ text }: { text: string }) {
  const findings = useMemo(() => runRuleChecks(text), [text]);
  const fixable = findings.filter((f) => f.fixable && f.replacement !== null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (content: string, key: string) => {
    void invoke("clipboard_write", { text: content })
      .then(() => {
        setCopied(key);
        window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="flex w-full flex-col gap-3">
      {/* 统计 + 批量操作 */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {findings.length > 0 ? `发现 ${findings.length} 处` : "未发现明显问题"}
        </span>
        {fixable.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto h-7 gap-1.5 text-xs"
            onClick={() => copy(applyFixes(text, findings), "all")}
          >
            {copied === "all" ? <CheckCheck className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied === "all" ? "已复制" : `合并复制修复后全文（${fixable.length} 处）`}
          </Button>
        )}
      </div>

      {/* findings 列表 */}
      {findings.length === 0 ? (
        <p className="rounded-md bg-muted/50 px-3 py-4 text-center text-muted-foreground text-sm">
          排版与用语规则未发现问题。
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {findings.map((f) => (
            <FindingItem key={f.id} finding={f} copied={copied === f.id} onCopy={copy} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** 单条：徽标行（分类 + 级别）+ 上下文高亮（前缀 + 命中 + 后缀）+ 消息 + 复制建议 */
function FindingItem({
  finding,
  copied,
  onCopy,
}: {
  finding: Finding;
  copied: boolean;
  onCopy: (content: string, key: string) => void;
}) {
  const f = finding;
  return (
    <li className="rounded-md border border-border-subtle px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-medium text-[10px] leading-4",
            SEVERITY_STYLES[f.severity],
          )}
        >
          {CATEGORY_LABELS[f.category]}
        </span>
        {/* 上下文：前缀 + 命中高亮 + 后缀（无定位的 LLM 条目退化显示 quote） */}
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
        {f.fixable && f.replacement !== null && (
          <Tooltip content={copied ? "已复制" : "复制建议"} placement="bottom">
            <button
              type="button"
              aria-label="复制建议"
              onClick={() => onCopy(f.replacement ?? "", f.id)}
              className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-primary"
            >
              {copied ? <CheckCheck className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          </Tooltip>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-snug break-words text-foreground/90">
        {f.message}
        {f.replacement !== null && f.fixable && (
          <span className="text-muted-foreground">
            {" "}（建议：{f.quote ? "「" : ""}
            {f.quote}
            {f.quote ? "」→" : "→"}「{f.replacement === "" ? "删除" : f.replacement}」）
          </span>
        )}
      </p>
    </li>
  );
}
