/**
 * 学习卡复习弹窗（生词本重构）。
 * 溯源：复习调度（applySm2）与释义渲染（dictFrame）沿用自 pickdict (MIT) 的移植；
 * 弹窗与翻牌形态为本仓重构（原 ReviewTab 已删）。
 * 3D 翻牌卡：正面 = 单词大字（点击/Space 翻面），背面 = 第一部启用词典释义
 * （iframe 沙箱渲染，同 ReviewTab 翻面管线）。四档 SM-2 评分（Space 已翻面时 =
 * 良好），「重来」回队尾重学；←→ 浏览切卡（浏览不评分）；顶部进度条 + n/m。
 * 会话队列由父组件按范围组装（全部到期 / 单元到期，dueAt 升序）后经 session 传入，
 * 打开时重置会话并缓存启用词典列表（翻面免重复拉取）。
 *
 * 发音（追加）：
 * - 背面修复：BOOT_SCRIPT 点 sound:// 回传 `onedict-sound`，本组件此前未监听
 *   （发音按钮点了没反应的根因）——现监听 message（event.source 匹配释义帧，
 *   沙箱 opaque origin 读不到内部 DOM）→ fetchSoundData 取字节（.spx wasm 解码）
 *   → 父页直接 Audio 播放（点击手势在父页链路内，不回传帧）。
 * - 正面发音：单词面无词典 HTML，点按钮按需 lookup（第一部启用词典，结果缓存
 *   htmlRef 供翻面复用）→ 提取第一个 `href="sound://…"` 资源键 → 同链路播放；
 *   帧内取词 / entry:// 内链保持「卡面不查词」——由 DictionaryPanel 的消息
 *   source 校验强制保证（复习卡帧不在词典帧注册表内，其 onedict-word/
 *   onedict-entry 消息被丢弃；原「无监听者天然 no-op」前提不成立——主窗词典 Tab
 *   keep-alive 常驻监听）。
 * - 自动发音：偏好 `reviewAutoPronounce`（设置页词典子页开关，prefs-changed 实时
 *   跟随）开启时卡片出现自动读词；无用户手势的自动播放被 WebView2 拦截时降级提示。
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Volume2,
} from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Tooltip } from "@onedict/ui/components/tooltip";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@onedict/ui/components/dialog";
import { cn } from "../../lib/utils";
import { applySm2, type ReviewGrade } from "../../services/sm2";
import { buildSrcdoc } from "../../services/dictFrame";
import { fetchSoundData } from "../../services/dictSound";
import { playSoundData, stopSpeaking } from "../../services/tts";
import { firstSoundKey, speakWord } from "../../services/pronounce";
import type { DictMeta, LookupResult } from "../../types/dictionary";
import type { PrefsPayload, PronouncePrefs } from "../../types/prefs";
import type { VocabularyEntry } from "../../types/vocabulary";

/** 会话类型：轮次复习（记单元轮次）/ 抽查（记抽查记录）/ 专项（不确定词，仅练习） */
export type SessionKind = "round" | "check" | "focus";

export interface ReviewSession {
  /** 复习范围显示名（「全部生词」/ 单元名 / 「单元名 · 抽查」） */
  scopeLabel: string;
  /** 初始队列（父组件组装：到期优先 → 不确定补齐 → 熟词抽查） */
  queue: VocabularyEntry[];
  /** 来源单元（null = 全部生词；轮次 / 抽查记录需要） */
  unit: { id: string; name: string; round: number } | null;
  kind: SessionKind;
  /** 会话开始时间（轮次记录用） */
  startedAt: number;
}

/** 会话完成小结（父组件据此提交单元轮次 / 抽查记录） */
export interface SessionSummary {
  kind: SessionKind;
  unitId: string | null;
  unitName: string | null;
  /** 本轮入场词数 */
  size: number;
  /** 四档评分次数 */
  grades: Record<ReviewGrade, number>;
  /** 评过「重来」的词（去重；下一轮优先） */
  againWords: string[];
  /** 评过「重来 / 困难」的词（去重；抽查漏词统计） */
  missedWords: string[];
  startedAt: number;
  completedAt: number;
}

/** 四档评分 → 按钮（同 pickdict ReviewPage 映射；key = 数字快捷键） */
const GRADE_BUTTONS: Array<{
  grade: ReviewGrade;
  label: string;
  variant: "destructive" | "outline" | "default" | "secondary";
  key: string;
}> = [
  { grade: "again", label: "重来", variant: "destructive", key: "1" },
  { grade: "hard", label: "困难", variant: "outline", key: "2" },
  { grade: "good", label: "良好", variant: "default", key: "3" },
  { grade: "easy", label: "简单", variant: "secondary", key: "4" },
];

const KEY_TO_GRADE: Record<string, ReviewGrade> = {
  "1": "again",
  "2": "hard",
  "3": "good",
  "4": "easy",
};

export default function ReviewDialog({
  session,
  onClose,
  onComplete,
  onFocusAgain,
}: {
  session: ReviewSession | null;
  onClose: () => void;
  /** 队列清空（完成一轮）时回调一次——记录提交由父组件负责 */
  onComplete?: (summary: SessionSummary) => void;
  /** 完成态「再来一轮（不确定词）」——父组件用同单元的不确定词重建会话 */
  onFocusAgain?: () => void;
}) {
  const open = session !== null;
  const [queue, setQueue] = useState<VocabularyEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);
  /** 四档评分次数（完成态展示 + 轮次记录同源） */
  const [gradeCounts, setGradeCounts] = useState<Record<ReviewGrade, number>>({
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
  });
  /** 评过「重来」/「重来或困难」的词（去重；完成小结用） */
  const againWordsRef = useRef(new Set<string>());
  const missedWordsRef = useRef(new Set<string>());
  /** 完成回调只触发一次（队列清空后 effect 可能重跑） */
  const completedRef = useRef(false);
  const revealSeq = useRef(0);
  const dictsRef = useRef<DictMeta[]>([]);
  /** 背面释义 iframe（event.source 匹配出发帧，sound:// 消息只认它） */
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** 当前卡释义 html 缓存（正面发音复用翻面的 lookup，免二次查询） */
  const htmlRef = useRef<string | null>(null);
  /** 发音请求 token（切卡后丢弃在途播放，防止上一张卡的音串场） */
  const speakSeq = useRef(0);
  const [soundHint, setSoundHint] = useState<string | null>(null);
  /** 学习卡自动发音偏好（设置页词典子页开关；prefs-changed 实时跟随） */
  const [autoPronounce, setAutoPronounce] = useState(false);
  /** 发音偏好（朗读源链 / 语音 / 语速；null = 未读到，发音按钮给提示） */
  const [pronounce, setPronounce] = useState<PronouncePrefs | null>(null);
  /** 启用词典缓存就绪标记（打开会话后 dictionary_list 异步返回置位——
   *  首张卡自动发音必须等它：effect 跑得比 IPC 快，词典未就绪会静默退出） */
  const [dictsReady, setDictsReady] = useState(false);

  // 偏好读取 + 广播同步（SettingsTab 开关即改即推）
  useEffect(() => {
    const load = () => {
      void invoke<PrefsPayload>("prefs_get")
        .then((p) => {
          setAutoPronounce(p.reviewAutoPronounce ?? false);
          setPronounce(p.pronounce ?? null);
        })
        .catch(() => {});
    };
    load();
    const un = listen("prefs-changed", load);
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, []);

  // 打开会话：重置状态 + 缓存启用词典（翻面查释义用；会话中不重复拉取）
  useEffect(() => {
    if (!session) return;
    setQueue(session.queue);
    setIndex(0);
    setRevealed(false);
    setHtml(null);
    setReviewedCount(0);
    setGradeCounts({ again: 0, hard: 0, good: 0, easy: 0 });
    againWordsRef.current = new Set();
    missedWordsRef.current = new Set();
    completedRef.current = false;
    revealSeq.current++;
    speakSeq.current++;
    htmlRef.current = null;
    setSoundHint(null);
    dictsRef.current = [];
    setDictsReady(false);
    void invoke<DictMeta[]>("dictionary_list")
      .then((dicts) => {
        dictsRef.current = dicts.filter((d) => d.enabled);
        setDictsReady(true);
      })
      .catch(() => {
        setDictsReady(true); // 失败也置位（卡面可翻，发音按钮会给出提示）
      });
  }, [session]);

  const current = queue[index];
  const done = index >= queue.length;
  const progress = queue.length === 0 ? 100 : (Math.min(index, queue.length) / queue.length) * 100;

  // 完成回调：队列清空即汇总一次（父组件提交轮次 / 抽查记录；专项练习不落记录）
  useEffect(() => {
    if (!open || !done || !session || completedRef.current) return;
    completedRef.current = true;
    onComplete?.({
      kind: session.kind,
      unitId: session.unit?.id ?? null,
      unitName: session.unit?.name ?? null,
      size: session.queue.length,
      grades: gradeCounts,
      againWords: [...againWordsRef.current],
      missedWords: [...missedWordsRef.current],
      startedAt: session.startedAt,
      completedAt: Date.now(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在队列清空瞬间触发一次
  }, [open, done, session]);

  // 播放（父页 Audio：正面按钮与自动发音无用户手势链路；被拦截时提示重试）。
  // 统一走 services/tts 的单通道播放器——词典资源音频与系统语音合成共用一条通道，
  // 自动发音与手动按钮、背面喇叭并发时不叠音。
  const playBase64 = (mime: string, base64: string) => {
    stopSpeaking();
    void playSoundData({ mime, base64 }).catch((err) => {
      setSoundHint(err instanceof Error ? err.message : String(err));
    });
  };

  // 关窗即停（发音不比窗口活得久）
  useEffect(() => {
    if (open) return;
    stopSpeaking();
  }, [open]);

  // 发音：走朗读源链（本地词典录音 → 在线音频 → 系统语音；设置页「发音」可配）。
  // 词典资源键惰性取——翻过面直接用缓存 HTML，未翻面才 lookup（第一部启用词典）；
  // 无 MDD 发音的词由链兜底到系统语音（此前直接提示「未收录」）。
  const speak = async () => {
    const card = queue[index];
    if (!card) return;
    const prefs = pronounce;
    if (!prefs) {
      setSoundHint("发音配置尚未就绪，请稍候再试");
      return;
    }
    const seq = ++speakSeq.current;
    const report = (hint: { text: string; kind: "info" | "error" } | null) => {
      if (seq === speakSeq.current) setSoundHint(hint?.text ?? null);
    };
    try {
      await speakWord(card.word, {
        prefs,
        loadDictSound: async () => {
          const dictId = dictsRef.current[0]?.id;
          if (!dictId) return null;
          let entryHtml = htmlRef.current;
          if (entryHtml == null) {
            const result = await invoke<LookupResult>("dictionary_lookup", {
              dictId,
              word: card.word,
            });
            if (speakSeq.current !== seq) return null;
            entryHtml = result.html;
            htmlRef.current = entryHtml;
          }
          const key = entryHtml ? firstSoundKey(entryHtml) : null;
          return key ? { dictId, key } : null;
        },
        onStatus: report,
      });
    } catch (err) {
      report({ text: err instanceof Error ? err.message : String(err), kind: "error" });
    }
  };

  // 自动发音：卡片出现（含浏览切卡、「重来」回队尾重现）即读词；
  // 必须等词典缓存就绪——打开会话首张卡的 current.id 变化早于 dictionary_list 返回，
  // 不加 dictsReady 会静默错过首张（实测）
  useEffect(() => {
    if (!open || done || !autoPronounce || !current || !dictsReady) return;
    void speak();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 闭包经 deps 覆盖刷新（current.id 变化即新卡）
  }, [open, done, autoPronounce, current?.id, dictsReady]);

  // 翻面：第一部启用词典查词渲染（递增 token 使进行中的渲染结果失效）
  const reveal = async () => {
    if (!current) return;
    const seq = ++revealSeq.current;
    setRevealed(true);
    setHtml(null);
    if (dictsRef.current.length === 0) return;
    const result = await invoke<LookupResult>("dictionary_lookup", {
      dictId: dictsRef.current[0].id,
      word: current.word,
    });
    if (revealSeq.current !== seq) return;
    setHtml(result.html);
    htmlRef.current = result.html;
  };

  // 换卡公共清理：翻面态/释义/发音缓存与在途播放全部失效
  const resetCard = () => {
    revealSeq.current++;
    speakSeq.current++;
    stopSpeaking();
    setRevealed(false);
    setHtml(null);
    htmlRef.current = null;
    setSoundHint(null);
  };

  // 评分：SM-2 前端计算，Rust 只持久化；「重来」回队尾重学
  const grade = async (g: ReviewGrade) => {
    const card = queue[index];
    if (!card) return;
    resetCard();
    const next = applySm2(card, g);
    const updated = await invoke<VocabularyEntry>("vocabulary_review", {
      id: card.id,
      next: { ...next, grade: g }, // 学习统计：评分随调度一并提交记录
    });
    setReviewedCount((n) => n + 1);
    setGradeCounts((counts) => ({ ...counts, [g]: counts[g] + 1 }));
    if (g === "again") againWordsRef.current.add(card.word);
    if (g === "again" || g === "hard") missedWordsRef.current.add(card.word);
    if (g === "again") {
      setQueue((q) => [...q, updated]);
      // index 不动 → 自动进入下一张（队首让位）；仅剩该卡时原地重现
    } else {
      setIndex((i) => i + 1);
    }
  };

  // 浏览切卡（不评分）：±1 clamp
  const step = (delta: number) => {
    resetCard();
    setIndex((i) => Math.min(Math.max(i + delta, 0), queue.length - 1));
  };

  // 背面发音：iframe 内点 sound:// → BOOT_SCRIPT 回传 onedict-sound → 此处取字节
  // 直接父页播放（此前未监听该消息 = 「发音按钮没反应」的根因）
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; key?: string } | null;
      if (d?.type !== "onedict-sound" || typeof d.key !== "string" || !d.key) return;
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      const dictId = dictsRef.current[0]?.id;
      if (!dictId) return;
      setSoundHint("发音获取中…");
      fetchSoundData(dictId, d.key)
        .then((data) => {
          setSoundHint(null);
          playBase64(data.mime, data.base64);
        })
        .catch((err) => {
          setSoundHint(err instanceof Error ? err.message : String(err));
        });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // 键盘：Space 翻面/良好、1-4 评分（翻面后）、←→ 浏览；Esc 关闭由 Dialog 自带
  useEffect(() => {
    if (!open || done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (!revealed) void reveal();
        else void grade("good");
      } else if (revealed && KEY_TO_GRADE[e.key]) {
        e.preventDefault();
        void grade(KEY_TO_GRADE[e.key]);
      } else if (e.key === "ArrowLeft") {
        step(-1);
      } else if (e.key === "ArrowRight") {
        step(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 闭包经 deps 覆盖刷新（open/done/revealed/index/queue）
  }, [open, done, revealed, index, queue]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        size="xl"
        closeOnOverlayClick={false}
        className="flex flex-col gap-3"
      >
        {/* 头部：范围 + 进度计数 */}
        <div className="flex items-center justify-between gap-3">
          <DialogTitle className="truncate font-medium text-muted-foreground text-sm">
            复习 · {session?.scopeLabel ?? ""}
          </DialogTitle>
          {!done && (
            <span className="shrink-0 tabular-nums text-muted-foreground text-xs">
              {index + 1} / {queue.length}
            </span>
          )}
        </div>

        {/* 进度条 */}
        <div className="h-1 w-full shrink-0 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <CheckCircle2 className="size-10 text-green-600" />
            <div className="font-semibold text-lg">
              {session?.kind === "check" ? "抽查完成" : "本次复习完成"}
            </div>
            <p className="text-muted-foreground text-sm">
              {session?.kind === "check"
                ? `抽查 ${reviewedCount} 词，${missedWordsRef.current.size} 词未通过`
                : `共复习 ${reviewedCount} 张（「重来」的卡片已回队尾重学）`}
            </p>
            {/* 四档分布（与单元轮次记录同源） */}
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              {(
                [
                  ["again", "重来", "#dc2626"],
                  ["hard", "困难", "#d97706"],
                  ["good", "良好", "#16a34a"],
                  ["easy", "简单", "#2563eb"],
                ] as const
              ).map(([key, label, color]) => (
                <span
                  key={key}
                  className="flex items-center gap-1.5 text-muted-foreground text-xs"
                >
                  <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
                  {label} {gradeCounts[key]}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {onFocusAgain && session?.kind !== "focus" && missedWordsRef.current.size > 0 && (
                <Button type="button" variant="outline" onClick={onFocusAgain}>
                  再来一轮（不确定 {missedWordsRef.current.size} 词）
                </Button>
              )}
              <Button type="button" onClick={onClose}>
                完成
              </Button>
            </div>
          </div>
        ) : (
          current && (
            <>
              {/* 3D 翻牌卡 */}
              <div className="shrink-0 [perspective:1600px]">
                <div
                  className={cn(
                    "relative h-[340px] w-full transition-transform duration-500 [transform-style:preserve-3d]",
                    revealed && "[transform:rotateY(180deg)]",
                  )}
                >
                  {/* 正面：单词 + 发音 */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => void reveal()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void reveal();
                    }}
                    className={cn(
                      "absolute inset-0 flex flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-card [backface-visibility:hidden]",
                      revealed ? "pointer-events-none" : "cursor-pointer select-text",
                    )}
                  >
                    <div className="max-w-full px-10 text-center break-words font-semibold text-foreground text-4xl">
                      {current.word}
                    </div>
                    <div className="flex items-center gap-2">
                      <Tooltip content="发音" placement="bottom">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          aria-label="发音"
                          onClick={(e) => {
                            e.stopPropagation(); // 不触发翻面
                            void speak();
                          }}
                        >
                          <Volume2 className="size-4" />
                        </Button>
                      </Tooltip>
                      <span className="text-muted-foreground text-xs">
                        按 Space 或点击卡片显示释义
                      </span>
                    </div>
                  </div>

                  {/* 背面：释义（iframe 沙箱，白底；帧内发音按钮经 onedict-sound 消息播放） */}
                  <div className="absolute inset-0 overflow-hidden rounded-2xl border border-border bg-white [backface-visibility:hidden] [transform:rotateY(180deg)]">
                    {html ? (
                      <iframe
                        ref={iframeRef}
                        title={`review-card-${current.id}`}
                        sandbox="allow-scripts"
                        // allow="autoplay"：卡面发音在帧内 new Audio(...).play()，沙箱帧
                        // 是 opaque origin ⇒ 缺这条会被权限策略拒（NotAllowedError）
                        allow="autoplay"
                        // say:false —— 复习卡帧只听 onedict-sound，不接 onedict-speak：
                        // 注入例句朗读按钮只会是「点了没反应」的哑按钮
                        srcDoc={buildSrcdoc(html, undefined, { say: false })}
                        className="block h-full w-full border-0 bg-white"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-foreground-tertiary text-sm">
                        该词未被词典收录
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 操作区：浏览 + 翻面/评分 */}
              <div className="flex shrink-0 items-center gap-2">
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="上一张"
                    disabled={index === 0}
                    onClick={() => step(-1)}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="下一张"
                    disabled={index >= queue.length - 1}
                    onClick={() => step(1)}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
                {!revealed ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 flex-1"
                    onClick={() => void reveal()}
                  >
                    <Eye className="size-4" />
                    显示释义
                  </Button>
                ) : (
                  <div className="grid flex-1 grid-cols-4 gap-2">
                    {GRADE_BUTTONS.map(({ grade: g, label, variant, key }) => (
                      <Button
                        key={g}
                        type="button"
                        variant={variant}
                        className="h-9"
                        title={`快捷键 ${key}`}
                        onClick={() => void grade(g)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>

              {/* 发音状态行（min-h 占位防跳动；悬浮 pill 在 Dialog 内会遮评分按钮） */}
              <div className="h-4 shrink-0 text-center text-muted-foreground text-xs">
                {soundHint}
              </div>
            </>
          )
        )}
      </DialogContent>
    </Dialog>
  );
}
