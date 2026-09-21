/**
 *  翻译 Tab（左侧导航功能组末位）：语言栏（自动检测 → 目标语言）+ 双栏流式
 * （输入/输出）+ 复制/交换——通用翻译页范式（AGPL 只读参考，未复制代码）。
 * 右上角「翻译设置」弹出面板：模型切换 / 默认提示词（可见可改，
 * {{target_language}}/{{text}} 占位）/ 允许思考开关（页级；实际生效还需路由卡
 * 标记为推理模型）。默认使用「模型服务」的全局默认模型；默认强制非思考换快响应。
 *
 * 模型选择（跨卡 + 化石态修复）：候选项 = **全部已配置卡**的模型
 * （与设置页「默认模型」下拉同范式，「模型 · 卡名」分组），值存 `providerId:model`
 * 并随请求传 provider 路由该卡端点/Key/协议（无前缀旧值 = 跟随激活卡，天然兼容）。
 * 翻译可用性 = 路由卡端点 + 生效模型齐备——与「全局默认模型是否设置」解耦。
 * 本页 keep-alive 常挂载：首载失败保持占位 + 500ms 静默重试一次 + 激活时补拉
 * （与设置页模型服务同款三板斧，防首载化石态定格「未配置模型服务」）。
 *
 *  翻译历史：Rust translate-history.json 持久化
 * （translate_history_list/add/clear + translate-history-changed 广播；每次成功
 * 完成的翻译记一条，半途停止/空输出不入）。历史入口在语言栏（时钟图标 Popover：
 * 语言徽标 + 时间 + 原文/译文单行预览），点击回填
 * 原文/译文并同步目标语言偏好。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowRight,
  Check,
  History,
  Languages,
  Loader2,
  Settings2,
  Volume2,
  X,
} from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Textarea } from "@onedict/ui/components/textarea";
import { Tooltip } from "@onedict/ui/components/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onedict/ui/components/popover";
import { Switch } from "@onedict/ui/components/switch";
import {
  applyTranslatePrompt,
  builtinPrompt,
} from "../lib/actionPrompts";
import { modelThinking, routeCard, splitDictModel } from "../lib/aiConfig";
import { providerPresetById } from "../lib/aiProviders";
import { targetLangByCode } from "../lib/translate";
import LangSelect from "../components/LangSelect";
import { streamChat } from "../services/aiStream";
import { Minimark } from "../services/minimark";
import { speakSentence, type PronounceHint } from "../services/pronounce";
import { detectLang } from "../services/tts";
import { SAY_GENDER_CLASS, sayButtonLabel, sayButtonsOf } from "../services/voiceRouter";
import type { TranslateHistoryEntry } from "../types/history";
import type { AiPrefs, PrefsPayload, PronouncePrefs } from "../types/prefs";

export default function TranslateTab({ active = true }: { active?: boolean }) {
  /** AI 配置快照（跨卡模型分组与路由判定的唯一来源） */
  const [ai, setAi] = useState<AiPrefs | null>(null);
  /** 首帧偏好加载完成（未完成前下拉按「加载中」呈现，防默认态闪跳与误判） */
  const [loaded, setLoaded] = useState(false);
  /** 首载失败重试标记（最多一次；仍失败才按未配置呈现） */
  const retriedRef = useRef(false);
  const [langCode, setLangCode] = useState("zh-cn");
  /** 源语言（"" = 自动检测； 原「自动检测」死元素改为可指定，
   *  仅作为翻译提示告知 LLM 原文语言） */
  const [sourceCode, setSourceCode] = useState("");
  // 页级配置（translateModel/translatePrompt/translateAllowThink 偏好）
  const [modelOverride, setModelOverride] = useState("");
  const [promptOverride, setPromptOverride] = useState("");
  const [allowThink, setAllowThink] = useState(false);
  /** 发音偏好（朗读译文；null = 未读到） */
  const [pronounce, setPronounce] = useState<PronouncePrefs | null>(null);
  /** 朗读状态提示（合成中 / 失败；完成清空） */
  const [speakHint, setSpeakHint] = useState<PronounceHint | null>(null);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 翻译历史（Rust 持久化，最近优先）
  const [history, setHistory] = useState<TranslateHistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  /** 复制反馈重置计时器（卸载清理） */
  const copyTimer = useRef<number | null>(null);

  // 偏好加载 + ai-changed / prefs-changed 即时刷新
  const load = useCallback(() => {
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => {
        setAi(p.ai);
        if (p.translateLang) setLangCode(p.translateLang);
        setSourceCode(p.translateSourceLang || "");
        setModelOverride(p.translateModel ?? "");
        setPromptOverride(p.translatePrompt ?? "");
        setAllowThink(p.translateAllowThink);
        setPronounce(p.pronounce ?? null);
        setLoaded(true);
      })
      .catch(() => {
        // 实机验证（「重启后仍显示未配置模型服务」）：keep-alive
        // 常挂载下启动期首载偶发失败被旧实现静默吞掉 → 整页定格空态，直到保存
        // 模型卡（ai-changed 驱动重载）或重启才恢复。保持未就绪占位 + 500ms 静默
        // 重试一次（与设置页模型服务同款三板斧）。
        if (retriedRef.current) {
          setLoaded(true);
          return;
        }
        retriedRef.current = true;
        setTimeout(load, 500);
      });
  }, []);

  useEffect(() => {
    load();
    const unAi = listen("ai-changed", load);
    const unPrefs = listen("prefs-changed", load);
    return () => {
      void unAi.then((f) => f(), () => {});
      void unPrefs.then((f) => f(), () => {});
    };
  }, [load]);

  /** 模型绑定解析：`providerId:model`（无前缀旧值 = 纯模型名 → 跟随激活卡，零迁移） */
  const { provider: boundProvider, model: boundModel } = splitDictModel(modelOverride);
  const globalModel = ai?.model?.trim() ?? "";
  /** 实际路由卡（绑定卡优先，否则激活卡）——请求路由与思考门禁共用 */
  const route = routeCard(ai, modelOverride);
  const routeEndpoint = route?.endpoint.trim() ?? "";
  /** 实际生效模型（请求缺省由 Rust 回退全局默认，此处对齐展示与门禁） */
  const effectiveModel = boundModel || globalModel;
  /** 翻译可用 = 路由卡端点 + 生效模型齐备（与「全局默认模型是否设置」解耦） */
  const canTranslate = !!routeEndpoint && !!effectiveModel;
  /** 思考门禁 = 页开关 && 路由卡实际模型的推理标记（逐模型） */
  const cardThinking = modelThinking(route, effectiveModel);
  /** 跨卡模型分组（全部已配置卡；规则与设置页「默认模型」下拉同源） */
  const modelGroups = (ai?.providers ?? []).filter(
    (c) => c.models.length > 0 && c.endpoint.trim(),
  );
  const knownModelValues = new Set(
    modelGroups.flatMap((c) => c.models.map((e) => `${c.id}:${e.id}`)),
  );

  /** 主窗 tab 激活自愈：keep-alive 挂载下首载若定格为空（失败/竞态），进入翻译页
   *  时补拉一次；判据 = 路由端点仍缺失（正常配置与全新安装只多一次轻量 invoke） */
  useEffect(() => {
    if (active && loaded && !routeEndpoint) load();
  }, [active, loaded, routeEndpoint, load]);

  const changeLang = (code: string) => {
    setLangCode(code);
    void invoke("prefs_set_translate_lang", { lang: code }).catch(() => {});
  };

  const changeSource = (code: string) => {
    setSourceCode(code);
    void invoke("prefs_set_translate_source_lang", { lang: code || null }).catch(() => {});
  };

  // 翻译历史：拉取 + 广播刷新（发起窗口也收，统一由广播驱动 state）
  const reloadHistory = useCallback(() => {
    void invoke<TranslateHistoryEntry[]>("translate_history_list")
      .then(setHistory)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reloadHistory();
    const un = listen("translate-history-changed", reloadHistory);
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, [reloadHistory]);

  /** 页级配置保存（一次提交三项；ai-changed 由 Rust 端在 set_ai 时广播——本命令
   *  不动 ai 字段故补发拉取即可） */
  const saveConfig = (model: string, prompt: string, think: boolean) => {
    void invoke("prefs_set_translate_config", {
      model: model.trim() || null,
      prompt: prompt.trim() || null,
      allowThink: think,
    }).catch(() => {});
  };

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }, []);

  /** 历史回填：原文/译文填入双栏并同步目标语言偏好（cherry reuse 语义） */
  const applyHistory = (entry: TranslateHistoryEntry) => {
    stop();
    setHistoryOpen(false);
    setInput(entry.sourceText);
    setOutput(entry.targetText);
    setError(null);
    changeLang(entry.targetLang);
  };

  const translate = useCallback(() => {
    const text = input.trim();
    if (!text || loading) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setOutput("");
    setLoading(true);
    // 模型：页级绑定（含卡路由）> 全局默认（缺省由 Rust 回退全局）；
    // 思考：页开关 && 路由卡实际模型的推理标记
    const noThink = !(allowThink && cardThinking);
    const langName = targetLangByCode(langCode).promptName;
    // 源语言提示（"" = 自动检测不注入）：告知 LLM 原文语言防误判相似语言
    const sourceName = sourceCode ? targetLangByCode(sourceCode).promptName : undefined;
    const prompt = applyTranslatePrompt(promptOverride, langName, text, sourceName);
    let finalText = "";
    void streamChat(
      [{ role: "user", content: prompt }],
      // provider 仅在模型绑定完整时随传（残缺绑定值不误路由到别家卡端点）
      { model: boundModel || undefined, noThink, provider: boundModel ? boundProvider : undefined },
      controller.signal,
      (full) => {
        finalText = full;
        setOutput(full);
      },
    )
      .then(() => {
        // 成功完成的翻译入历史（半途停止走 AbortError 不入；空输出 Rust 侧兜底忽略）
        if (finalText.trim()) {
          void invoke("translate_history_add", {
            sourceText: text,
            targetText: finalText,
            sourceLang: null,
            targetLang: langCode,
          }).catch(() => {});
        }
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      });
  }, [
    input,
    langCode,
    sourceCode,
    loading,
    promptOverride,
    allowThink,
    boundModel,
    boundProvider,
    cardThinking,
  ]);

  // 卸载中止在途流
  useEffect(() => () => abortRef.current?.abort(), []);

  // 卸载清理复制反馈计时器
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  // 流式输出跟随滚动到底
  useEffect(() => {
    const el = outputRef.current;
    if (el && loading) el.scrollTop = el.scrollHeight;
  }, [output, loading]);

  /** 朗读译文（分句流水播放，状态经 speakHint 提示）：双按钮 = 按钮 1 女声 /
   *  按钮 2 男声（图标颜色即性别：红 / 蓝），英文口音倾向见设置页 */
  const sayPair = pronounce ? sayButtonsOf(pronounce) : null;

  const speakOutput = async (which: "a" | "b") => {
    if (!pronounce || !output.trim()) return;
    const button = sayButtonsOf(pronounce)[which === "b" ? 1 : 0];
    try {
      await speakSentence(output, pronounce, setSpeakHint, button);
    } catch (e) {
      setSpeakHint({ text: e instanceof Error ? e.message : String(e), kind: "error" });
    }
  };

  const copy = () => {
    if (!output) return;
    void invoke("clipboard_write", { text: output }).then(() => {
      setCopied(true);
      //  计时器随组件卸载清理（keep-alive 页频繁切页不留悬挂 setState）
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1500);
    });
  };

  const clear = () => {
    stop();
    setInput("");
    setOutput("");
    setError(null);
  };

  const targetLang = targetLangByCode(langCode);
  /** 提示词预览（设置面板展示当前生效模板；内置按目标语言实例化） */
  const promptPreview =
    promptOverride.trim() ||
    builtinPrompt("translate", targetLang.promptName);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 语言栏 + 翻译设置 */}
      <div className="shrink-0 border-border border-b px-6 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2">
          {/* 源语言（原「自动检测」死元素 → 可指定；cherry TranslateLanguageBar 语义） */}
          <div className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-sm">
            <Languages className="size-4 shrink-0 text-muted-foreground" />
            <LangSelect
              value={sourceCode}
              auto="自动检测"
              disabled={loading}
              onChange={changeSource}
              className="bg-transparent py-0.5 pr-1 text-sm"
            />
          </div>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          <LangSelect
            value={targetLang.code}
            disabled={loading}
            onChange={changeLang}
            className="min-w-[130px] justify-between rounded-md bg-muted px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          />
          <div className="flex-1" />
          <span className="truncate text-muted-foreground text-xs">
            {!loaded
              ? "配置加载中…"
              : routeEndpoint
                ? `模型：${effectiveModel || "未选择模型"}`
                : "未配置模型服务"}
          </span>
          {/* 翻译历史（语言徽标 + 时间 + 原文/译文单行预览；点击回填双栏并同步
              目标语言） */}
          <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
            <Tooltip content="翻译历史" placement="bottom">
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="翻译历史">
                  <History className="size-4" />
                </Button>
              </PopoverTrigger>
            </Tooltip>
            <PopoverContent align="end" className="w-[420px] p-0">
              <div className="flex items-center justify-between border-border border-b px-3 py-2">
                <span className="text-foreground text-sm font-medium">
                  翻译历史（{history.length}）
                </span>
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void invoke("translate_history_clear").catch(() => {})}
                    className="cursor-pointer bg-transparent p-0 text-muted-foreground text-xs transition-colors hover:text-foreground"
                  >
                    清空
                  </button>
                )}
              </div>
              <div className="max-h-[480px] overflow-y-auto p-1.5">
                {history.length === 0 ? (
                  <div className="py-10 text-center text-muted-foreground text-xs">
                    暂无翻译历史
                  </div>
                ) : (
                  history.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => applyHistory(h)}
                      className="flex w-full cursor-pointer flex-col gap-1 rounded-md p-2.5 text-left transition-colors hover:bg-accent"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-muted px-1 py-px text-muted-foreground text-xs">
                          自动检测
                        </span>
                        <ArrowRight className="size-3 text-muted-foreground" />
                        <span className="rounded bg-primary/10 px-1 py-px text-primary text-xs">
                          {targetLangByCode(h.targetLang).label}
                        </span>
                        <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                          {formatHistoryTime(h.createdAt)}
                        </span>
                      </div>
                      <p className="line-clamp-1 text-muted-foreground text-sm">
                        {h.sourceText}
                      </p>
                      <p className="line-clamp-1 text-foreground text-sm">{h.targetText}</p>
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>
          {/* 翻译设置面板（模型/提示词/思考，页级配置） */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="翻译设置"
                title="翻译设置"
              >
                <Settings2 className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96">
              <div className="flex flex-col gap-4">
                <div className="text-foreground text-sm font-medium">翻译设置</div>
                <div className="flex flex-col gap-1.5">
                  <div className="text-foreground text-sm">模型</div>
                  {/* 文案：解释标签只留动态默认模型 */}
                  <div className="text-muted-foreground text-xs">
                    {globalModel ? `默认模型为 ${globalModel}` : "默认模型未设置"}
                  </div>
                  <select
                    value={modelOverride}
                    onChange={(e) => {
                      setModelOverride(e.target.value);
                      saveConfig(e.target.value, promptOverride, allowThink);
                    }}
                    disabled={!loaded || modelGroups.length === 0}
                    className="h-8 w-full cursor-pointer rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value="">默认模型{globalModel ? `（${globalModel}）` : ""}</option>
                    {/* 历史值兜底：已不在任何卡列表中的旧绑定原样列出（不静默改写） */}
                    {modelOverride && !knownModelValues.has(modelOverride) && (
                      <option value={modelOverride}>{modelOverride}</option>
                    )}
                    {/* 全部已配置卡分组（值 = providerId:model → 请求按该卡路由） */}
                    {modelGroups.map((c) => {
                      const cardName = providerPresetById(c.id)?.name ?? c.id;
                      return (
                        <optgroup key={c.id} label={cardName}>
                          {c.models.map((e) => (
                            <option key={`${c.id}:${e.id}`} value={`${c.id}:${e.id}`}>
                              {e.id} · {cardName}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  {loaded && modelGroups.length === 0 && (
                    <div className="text-muted-foreground text-xs">
                      尚无可用模型（设置 → 模型服务 → 拉取模型列表后点选添加）
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="text-foreground text-sm">提示词</div>
                  <div className="text-muted-foreground text-xs">
                    {"留空使用内置模板；支持 {{target_language}} 与 {{text}} 占位符"}
                  </div>
                  <Textarea
                    value={promptOverride}
                    onChange={(e) => setPromptOverride(e.target.value)}
                    onBlur={() => saveConfig(modelOverride, promptOverride, allowThink)}
                    rows={6}
                    placeholder={promptPreview}
                    className="max-h-44 min-h-20 resize-y px-2 py-1.5 text-xs"
                  />
                  {promptOverride.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        setPromptOverride("");
                        saveConfig(modelOverride, "", allowThink);
                      }}
                      className="cursor-pointer self-start bg-transparent p-0 text-muted-foreground text-xs hover:text-foreground"
                    >
                      恢复内置模板
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3">
                  {/* 文案：解释标签删净，语义移入开关 hover */}
                  <div className="text-foreground text-sm">允许思考</div>
                  <Tooltip content="支持推理模型开启思考模式" placement="top">
                    <Switch
                      checked={allowThink}
                      onCheckedChange={(v) => {
                        setAllowThink(v);
                        saveConfig(modelOverride, promptOverride, v);
                      }}
                    />
                  </Tooltip>
                </div>
                {allowThink && !cardThinking && (
                  <p className="rounded bg-muted/60 px-2.5 py-1.5 text-muted-foreground text-xs">
                    当前模型未标记「推理」能力，思考不会生效；可在设置 → 模型服务的卡内为该模型打标。
                  </p>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* 双栏（左输入右输出，流式填充；段落式翻译不设 max-w，
          宽度随窗口拉伸显示尽可能多的内容——） */}
      <div className="grid min-h-0 w-full flex-1 grid-cols-2 gap-4 px-6 py-4">
        <div className="flex min-h-0 flex-col gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) translate();
            }}
            placeholder="输入要翻译的文本…（Ctrl+Enter 翻译）"
            className="min-h-0 flex-1 resize-none text-sm"
          />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">{input.length} 字符</span>
            <div className="flex items-center gap-2">
              {(input || output) && (
                <Tooltip content="清空" placement="top">
                  <Button type="button" variant="ghost" size="icon-sm" onClick={clear} aria-label="清空">
                    <X className="size-4" />
                  </Button>
                </Tooltip>
              )}
              {loading ? (
                <Button type="button" variant="outline" size="sm" onClick={stop}>
                  <Loader2 className="size-4 animate-spin" />
                  停止
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={translate}
                  disabled={!input.trim() || !loaded || !canTranslate}
                >
                  翻译
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-2">
          <div
            ref={outputRef}
            className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-background p-3"
          >
            {loading && !output && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
            {output && (
              <div className="min-w-0 break-words text-sm">
                <Minimark text={output} />
              </div>
            )}
            {!output && !loading && !error && (
              <div className="flex h-full items-center justify-center text-foreground-tertiary text-sm">
                翻译结果将显示在这里
              </div>
            )}
            {error && (
              <div className="break-all rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                {error}
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            {speakHint && (
              <span
                className={
                  speakHint.kind === "error"
                    ? "mr-auto text-destructive text-xs"
                    : "mr-auto text-muted-foreground text-xs"
                }
              >
                {speakHint.text}
              </span>
            )}
            {(["a", "b"] as const).map((which, i) => {
              const info = sayPair?.[i];
              const tip = info ? `朗读译文（${sayButtonLabel(info, detectLang(output))}）` : "朗读译文";
              return (
                <Button
                  key={which}
                  type="button"
                  variant="outline"
                  size="sm"
                  title={tip}
                  aria-label={tip}
                  onClick={() => void speakOutput(which)}
                  disabled={!output || loading}
                >
                  <Volume2
                    className={
                      info
                        ? `size-4 ${SAY_GENDER_CLASS[info.gender]}`
                        : "size-4 text-muted-foreground"
                    }
                  />
                </Button>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copy}
              disabled={!output || loading}
            >
              {copied ? (
                <>
                  <Check className="size-4 text-primary" />
                  已复制
                </>
              ) : (
                "复制"
              )}
            </Button>
          </div>
        </div>
      </div>

      {loaded && !canTranslate && (
        <div className="shrink-0 px-6 pb-3">
          <p className="mx-auto max-w-3xl text-muted-foreground text-xs">
            {routeEndpoint
              ? "请在右上角「翻译设置」中选择翻译模型。"
              : "需要先在「设置 → 模型服务」启用模型卡并设置默认模型。"}
          </p>
        </div>
      )}
    </div>
  );
}

/** 历史时间标签：今天 → HH:mm，否则 MM-dd HH:mm（cherry formatCreatedAt 简化） */
function formatHistoryTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}
