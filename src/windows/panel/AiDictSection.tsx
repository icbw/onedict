/**
 *  AI 词典：词典内置「AI 词典」在线词典形态——与划词翻译同一条 AI 管线
 * （Rust ai_stream 流式代理），集成在查词结果中（DictionaryPanel 尾部分区，
 * 主窗口查词页与划词动作面板共用）。系统提示词可配置（偏好 ai.dictPrompt），
 * 思考开关 = 偏好 ai.dictAllowThink（词典子页）&& 激活卡推理模型标记（门禁）。
 * 折叠行为与本地词典分区一致（栏头切换）；AI 未配置或开关关闭时整区不渲染。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Sparkles, Volume2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { streamChat, type AiStreamMessage } from "../../services/aiStream";
import { Minimark } from "../../services/minimark";
import { aiReady } from "../../lib/actions";
import { dictRouteCard, modelThinking, splitDictModel } from "../../lib/aiConfig";
import { speakWordByTts, type PronounceHint } from "../../services/pronounce";
import { detectLang } from "../../services/tts";
import { SAY_GENDER_CLASS, sayButtonLabel, sayButtonsOf } from "../../services/voiceRouter";
import type { PrefsPayload, PronouncePrefs } from "../../types/prefs";

/** 内置默认系统提示词（偏好 ai.dictPrompt 为空时使用） */
export const DEFAULT_AI_DICT_PROMPT = [
  "你是一部严谨的双语词典。针对用户给出的词条，用 Markdown 输出：",
  "1. 读音（英文词有把握时给 IPA，中文词给拼音）；",
  "2. 词性与简明释义（中文为主，多义项编号列出）；",
  "3. 1–2 个例句（原文 + 中文翻译）。",
  "词条可能是词、词组或短句：固定表达按词条释义；一般句子给出翻译与要点讲解。",
  "词头由应用显示，不要重复输出词条本身。",
  "除以上内容外不要输出任何无关说明。",
].join("\n");

export default function AiDictSection({
  word,
  variant = "card",
}: {
  word: string;
  /** card = 边框卡片分区（主窗口）；flat = 通栏（动作面板） */
  variant?: "card" | "flat";
}) {
  const [configured, setConfigured] = useState(false); // AI 配置就绪且 AI 词典启用
  const [prompt, setPrompt] = useState<string>(DEFAULT_AI_DICT_PROMPT);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [noThink, setNoThink] = useState(true);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /** 发音偏好（AI 词典双语朗读按钮用；null = 未读到） */
  const [pronounce, setPronounce] = useState<PronouncePrefs | null>(null);
  /** 朗读状态提示（合成中 / 失败） */
  const [speakHint, setSpeakHint] = useState<PronounceHint | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 请求轮次：快速跳词时旧流结果丢弃 */
  const seqRef = useRef(0);

  // 配置加载 + ai-changed 即时刷新（设置页改动后无需重开窗口）
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => {
          if (cancelled) return;
          const ok = aiReady(p.ai) && (p.ai?.dictEnabled ?? false);
          setConfigured(ok);
          setPrompt(p.ai?.dictPrompt?.trim() ? p.ai.dictPrompt : DEFAULT_AI_DICT_PROMPT);
          // 模型路由：dictModel 绑定卡优先（ai_stream provider 参数），否则全局默认模型
          const { provider: pid, model: m } = splitDictModel(p.ai?.dictModel);
          setProvider(pid);
          setModel(m ?? (p.ai?.model?.trim() || undefined));
          // 思考：词典弹窗开关 && 路由卡实际模型的推理标记（门禁，逐模型）
          setNoThink(
            !((p.ai?.dictAllowThink ?? false) && modelThinking(dictRouteCard(p.ai), m ?? p.ai?.model)),
          );
          setPronounce(p.pronounce ?? null);
        })
        .catch(() => {});
    };
    load();
    const unlisten = listen("ai-changed", load);
    return () => {
      cancelled = true;
      void unlisten.then((f) => f(), () => {});
    };
  }, []);

  // 流式查询（word 变化即重开一轮；未配置不请求）
  useEffect(() => {
    abortRef.current?.abort();
    const target = word.trim();
    if (!target || !configured) {
      setContent("");
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setContent("");
    setLoading(true);
    const messages: AiStreamMessage[] = [
      { role: "system", content: prompt },
      { role: "user", content: target },
    ];
    void streamChat(
      messages,
      { model, noThink, provider },
      controller.signal,
      (full) => {
        if (seq !== seqRef.current) return;
        setContent(full);
      },
    )
      .catch((err) => {
        if (seq !== seqRef.current) return;
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [word, configured, prompt, model, provider, noThink]);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  /** 原词朗读双按钮：按钮 1 女声 / 按钮 2 男声（图标颜色即性别：红 / 蓝）。
   *  直接合成（不走词典真人资源）——原词由本区自己渲染，与 AI 输出无关 */
  const sayPair = pronounce ? sayButtonsOf(pronounce) : null;

  const speakWordOut = async (which: "a" | "b") => {
    if (!pronounce) return;
    const button = sayButtonsOf(pronounce)[which === "b" ? 1 : 0];
    try {
      await speakWordByTts(word, pronounce, "", setSpeakHint, button);
    } catch (e) {
      setSpeakHint({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    }
  };

  if (!configured || !word.trim()) return null;

  return (
    <div className={cn(variant === "card" && "overflow-hidden rounded-md border border-border")}>
      <div
        className={cn(
          "flex w-full items-center gap-1 text-muted-foreground text-xs",
          variant === "card" ? "bg-muted px-3 py-1" : "bg-muted/60 px-3 py-1",
        )}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={toggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
        >
          <ChevronDown
            className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
          />
          <Sparkles className="size-3 shrink-0" />
          <span className="flex-1 truncate">AI 词典</span>
          {loading && <span className="text-foreground-tertiary">生成中…</span>}
        </button>
      </div>
      {!collapsed && (
        // select-text：app.css body 全局禁 accidental 选区，AI 输出区恢复可选中
        // （复制释义/例句是查词场景刚需 实测）
        <div className="min-w-0 select-text break-words px-3 py-2 text-sm">
          {/* 词头由程序渲染（不依赖 AI 输出）：原词 + 两个原词朗读按钮
              （按钮 1 女声 / 按钮 2 男声；英文口音倾向见设置页） */}
          <div className="mb-1.5 flex items-center gap-2 border-border border-b pb-1.5">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{word}</span>
            {(["a", "b"] as const).map((which, i) => {
              const info = sayPair?.[i];
              const tip = info
                ? `朗读原词（${sayButtonLabel(info, detectLang(word))}）`
                : "朗读原词";
              return (
                <button
                  key={which}
                  type="button"
                  title={tip}
                  aria-label={tip}
                  onClick={() => void speakWordOut(which)}
                  className="shrink-0 cursor-pointer rounded px-1 py-0.5 leading-none opacity-70 transition-opacity hover:opacity-100"
                >
                  <Volume2
                    className={cn(
                      "size-3.5",
                      info ? SAY_GENDER_CLASS[info.gender] : "text-muted-foreground",
                    )}
                  />
                </button>
              );
            })}
          </div>
          {speakHint && (
            <div
              className={cn(
                "mb-1 text-xs",
                speakHint.kind === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {speakHint.text}
            </div>
          )}
          {content && <Minimark text={content} />}
          {loading && !content && (
            <div className="py-2 text-foreground-tertiary text-xs">AI 词典生成中…</div>
          )}
          {error && (
            <div className="break-all rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[13px] text-destructive">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
