/**
 *  AI 动作共享部件（动作面板泛化的公共底座）。
 * - useAiStream：流式会话状态机（pickdict ActionGeneral/ActionTranslate 的
 *   fetchResult/abort 语义收敛为单 hook；AbortError 静默，错降级展示）
 * - ShowOriginal：原文折叠（pickdict 同形）
 * - AiFooter：停止 / 重新生成 / 复制（pickdict WindowFooter 精简同形）
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { cn } from "../../lib/utils";
import {
  streamChat,
  type AiStreamConfig,
  type AiStreamMessage,
} from "../../services/aiStream";
import { Minimark } from "../../services/minimark";

export function useAiStream() {
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }, []);

  /** 会话重置（中止 + 清空内容/错误）——截图覆盖层复用窗口，每次唤起必须清
   *  上一轮流内容：否则残留译文按行号套在新截图上 = 观感「自动翻译」（实测 bug） */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setContent("");
    setError(null);
    setLoading(false);
  }, []);

  const run = useCallback(
    async (
      messages: AiStreamMessage[],
      config: AiStreamConfig,
      opts?: { scrollToBottom?: () => void },
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setContent("");
      setLoading(true);
      try {
        await streamChat(messages, config, controller.signal, (full) => {
          setContent(full);
          opts?.scrollToBottom?.();
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        // 新一轮已启动时不回拨新一轮的 loading
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    },
    [],
  );

  // 组件卸载中止在途流
  useEffect(() => () => abortRef.current?.abort(), []);

  return { content, error, loading, run, stop, reset };
}

/** 原文折叠块（pickdict original_show/original_hide 同形） */
export function ShowOriginal({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 复制反馈重置计时器（卸载清理） */
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );
  return (
    <>
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="flex cursor-pointer items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-primary"
      >
        <span>{show ? "隐藏原文" : "显示原文"}</span>
        <ChevronDown size={14} className={cn("transition-transform", show && "rotate-180")} />
      </button>
      {show && (
        <div className="mt-2 w-full break-words rounded bg-muted p-2 text-foreground-secondary text-xs whitespace-pre-wrap">
          {text}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                void invoke("clipboard_write", { text }).then(() => {
                  setCopied(true);
                  if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
                  copyTimer.current = window.setTimeout(() => {
                    copyTimer.current = null;
                    setCopied(false);
                  }, 1500);
                });
              }}
              className="cursor-pointer bg-transparent p-0 text-muted-foreground text-xs hover:text-primary"
            >
              {copied ? "已复制" : "复制原文"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** 流式正文（加载态 spinner + Minimark 渲染 + 错误条） */
export function AiBody({
  content,
  error,
  loading,
  className,
}: {
  content: string;
  error: string | null;
  loading: boolean;
  className?: string;
}) {
  return (
    <div className={cn("w-full", className)}>
      {loading && !content && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {content && (
        // select-text：app.css body 全局禁 accidental 选区，AI 输出区恢复可选中
        <div className="min-w-0 select-text break-words text-sm">
          <Minimark text={content} />
        </div>
      )}
      {error && (
        <div className="mt-3 break-all rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

/** 会话页脚：停止（生成中）/ 重新生成（空闲）+ 复制结果 */
export function AiFooter({
  loading,
  content,
  onStop,
  onRegenerate,
}: {
  loading: boolean;
  content: string;
  onStop: () => void;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  /** 复制反馈重置计时器（卸载清理） */
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );
  const copy = () => {
    if (!content) return;
    void invoke("clipboard_write", { text: content }).then(() => {
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1500);
    });
  };
  return (
    <div className="flex min-h-8 items-center justify-end gap-2 pt-2">
      {loading ? (
        <Button type="button" variant="outline" size="sm" onClick={onStop}>
          停止
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={onRegenerate}>
          重新生成
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" disabled={!content} onClick={copy}>
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  );
}
