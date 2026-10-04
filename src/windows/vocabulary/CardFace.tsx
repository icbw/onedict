/**
 * 生词卡背面卡面（规则化渲染，接替词典整页 iframe）。
 *
 * 数据分层：
 * - 语境义主位：entry.sense（释义级收藏快照）+ entry.context 原句（词形 amber 高亮，
 *   sentenceHighlight 纯函数）——永远来自真实语境，不受 AI 可用性影响；
 * - 常用释义：entry.card.senses（收藏后前端管线整理，services/vocabCard.ts）——
 *   **复用词典内容**：本地 O8C（牛津高阶双解）→ 在线剑桥/必应/有道（结构化释义 +
 *   例句），词典源全空才 AI 兜底（source="ai"，卡面标注）；词性 chip 按词性着色
 *   （对齐词典排版惯例），每条释义带来源徽标；
 * - 词典例句区：entry.card.sentences（bing 例句区等非义项绑定的例句，原文 + 对译）；
 * - 中文对译：卡级开关（默认隐藏——对译是拐杖，回忆时不应先看到），控制原句对译
 *   与例句对译显隐；纯前端态，不落偏好。
 *
 * 降级（card 缺失）：AI 未配置给配置指引；已配置 = 整理失败或在途，可手动重试
 * （vocabulary_card_generate → 前端管线 force 重跑），结果经 vocabulary-card 事件
 * 回灌刷新。
 *
 * 排版对齐主界面 token（语境义 primary 徽标 / border-subtle 分隔 / muted 次级层）；
 * 文本可选中（全局 user-select:none 需显式恢复）。发音经父组件链路（词典录音 →
 * TTS 合成），本组件不自持音频。
 */
import { useState } from "react";
import { BookOpenText, Languages, RefreshCw, Volume2 } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Tooltip } from "@onedict/ui/components/tooltip";
import { cn } from "../../lib/utils";
import { sentenceHighlight } from "../../lib/vocabContext";
import type { CardSense, VocabularyEntry } from "../../types/vocabulary";

/** 来源词典显示名（web- 前缀 = 在线源；本地直接 id；ai = AI 兜底） */
const SOURCE_LABELS: Record<string, string> = {
  "web-cambridge": "剑桥",
  "web-bing": "必应",
  "web-youdao": "有道",
  O8C: "牛津高阶",
  ai: "AI",
};

function sourceLabel(source: string | null): string {
  if (!source) return "";
  return SOURCE_LABELS[source] ?? source;
}

/** 词性 chip 着色（对齐词典排版惯例：名词蓝 / 动词绿 / 形容词琥珀 / 副词紫） */
function posClass(pos: string): string {
  const p = pos.toLowerCase();
  if (p.startsWith("n")) return "bg-sky-500/10 text-sky-700";
  if (p.startsWith("v")) return "bg-emerald-500/10 text-emerald-700";
  if (p.startsWith("adj")) return "bg-amber-500/10 text-amber-700";
  if (p.startsWith("adv")) return "bg-violet-500/10 text-violet-700";
  return "bg-slate-500/10 text-slate-600";
}

export default function CardFace({
  entry,
  aiReady,
  onSpeakWord,
  onSpeakSentence,
  onRetry,
  onLookup,
}: {
  entry: VocabularyEntry;
  /** AI 配置就绪（降级态文案分流：未配置 vs 整理失败/在途） */
  aiReady: boolean;
  /** 词头发音（父组件：词典录音 → 在线 → 系统语音链） */
  onSpeakWord: () => void;
  /** 句子朗读（父组件：句子合成链 + voice-cache） */
  onSpeakSentence: (text: string) => void;
  /** 重新整理（vocabulary_card_generate → 前端管线 force 重跑） */
  onRetry: () => void;
  /** 词典页查看（MainApp lookupReq 管道；复习会话保留） */
  onLookup: (word: string) => void;
}) {
  const [showZh, setShowZh] = useState(false);
  const card = entry.card;
  const sense = entry.sense;
  const sentence = entry.context?.sentence?.trim() ?? "";
  const hl = sentence
    ? sentenceHighlight(entry.context!.sentence, entry.context!.wordOffset)
    : null;
  const hasContext = !!sense || !!sentence;
  const hasSenses = !!card && card.senses.length > 0;
  const hasDictSentences = !!card && card.sentences.length > 0;
  const hasZh =
    !!card &&
    (!!card.sentenceZh ||
      card.senses.some((s) => s.exampleZh) ||
      card.sentences.some((s) => s.zh));
  /** AI 兜底条目存在才在底部标注（AI 内容须明确标注） */
  const hasAiContent = !!card && (card.senses.some((s) => s.source === "ai") || card.source === "ai");

  return (
    <div className="flex h-full flex-col overflow-hidden px-5 py-3 text-left select-text">
      {/* 词头行：word + 音标 + 发音 / 对译开关 */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle pb-2">
        <span className="min-w-0 truncate font-semibold text-2xl text-foreground">
          {entry.word}
        </span>
        {card?.phonetic && (
          <span className="min-w-0 truncate font-mono text-muted-foreground text-sm">
            {card.phonetic}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tooltip content="发音" placement="bottom">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="发音"
              onClick={onSpeakWord}
            >
              <Volume2 className="size-4" />
            </Button>
          </Tooltip>
          {hasZh && (
            <Tooltip content={showZh ? "隐藏中文对译" : "显示中文对译"} placement="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="中文对译"
                onClick={() => setShowZh((v) => !v)}
                className={cn(showZh && "bg-primary/10 text-primary hover:bg-primary/15")}
              >
                <Languages className="size-4" />
              </Button>
            </Tooltip>
          )}
        </span>
      </div>

      {/* 内容区：语境义主位 + 常用释义 + 词典例句 + 降级态 */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-2.5">
        {hasContext && (
          <section className="space-y-1.5">
            {sense && (
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-[10px] text-primary leading-4">
                  语境义{sourceLabel(sense.dictId) ? ` · ${sourceLabel(sense.dictId)}` : ""}
                </span>
                <p className="min-w-0 flex-1 text-[15px] leading-snug break-words text-foreground">
                  {sense.definition}
                </p>
              </div>
            )}
            {sentence && (
              <div className="space-y-0.5">
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
                    sentence
                  )}
                </p>
                {showZh && card?.sentenceZh && (
                  <p className="text-muted-foreground text-xs leading-relaxed break-words">
                    {card.sentenceZh}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {hasSenses && (
          <section className="space-y-2">
            <div className="font-medium text-muted-foreground/70 text-[10px] tracking-widest">
              常用释义
            </div>
            <ol className="space-y-2.5">
              {card!.senses.map((s, i) => (
                <SenseItem key={i} index={i} sense={s} showZh={showZh} onSpeakSentence={onSpeakSentence} />
              ))}
            </ol>
          </section>
        )}

        {hasDictSentences && (
          <section className="space-y-2">
            <div className="font-medium text-muted-foreground/70 text-[10px] tracking-widest">
              词典例句
            </div>
            <ol className="space-y-2">
              {card!.sentences.map((s, i) => (
                <li key={i} className="space-y-0.5">
                  <div className="flex items-start gap-1.5">
                    <p className="min-w-0 flex-1 text-muted-foreground text-xs leading-relaxed break-words">
                      {s.en}
                    </p>
                    <button
                      type="button"
                      title="朗读例句"
                      aria-label="朗读例句"
                      onClick={() => onSpeakSentence(s.en)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-primary"
                    >
                      <Volume2 className="size-3" />
                    </button>
                  </div>
                  {showZh && s.zh && (
                    <p className="pl-4 text-muted-foreground/60 text-xs leading-relaxed break-words">
                      {s.zh}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* 降级态：无卡面数据（语境义与原句照常展示，语境化能力不受影响） */}
        {!card && (
          <div className="flex flex-col items-start gap-1.5 rounded-md bg-muted/50 px-3 py-2.5">
            {aiReady ? (
              <span className="text-muted-foreground text-xs">
                常用释义尚未整理（收藏后自动进行，仅此一次）
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">
                未配置 AI 且词典无释义（词典中可查看完整内容）
              </span>
            )}
            {aiReady && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={onRetry}
              >
                <RefreshCw className="size-3" />
                重新整理
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 底部：来源标注（AI 内容须明确标注）+ 词典页入口 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle pt-1.5">
        {card && (
          <span className="text-muted-foreground/60 text-[10px]">
            {hasAiContent ? "释义来自词典，含 AI 兜底" : "释义与例句来自词典"}
          </span>
        )}
        <button
          type="button"
          onClick={() => onLookup(entry.word)}
          className="ml-auto flex items-center gap-1 text-muted-foreground/60 text-[10px] transition-colors hover:text-primary"
        >
          <BookOpenText className="size-3" />
          词典中查看
        </button>
      </div>
    </div>
  );
}

/** 单条释义：词性 chip（按词性着色）+ 中文释义 + 英文定义 + 绑定例句 + 来源徽标 */
function SenseItem({
  index,
  sense,
  showZh,
  onSpeakSentence,
}: {
  index: number;
  sense: CardSense;
  showZh: boolean;
  onSpeakSentence: (text: string) => void;
}) {
  return (
    <li className="space-y-0.5">
      <div className="flex items-start gap-2">
        <span className="w-4 shrink-0 text-right text-muted-foreground/50 text-xs leading-5 tabular-nums">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug break-words text-foreground">
            {sense.definition}
          </p>
          {sense.definitionEn && (
            <p className="text-muted-foreground/80 text-xs leading-snug break-words italic">
              {sense.definitionEn}
            </p>
          )}
        </div>
        <span className="ml-1 flex shrink-0 items-center gap-1">
          {sense.pos && (
            <span
              className={cn(
                "rounded px-1 py-0.5 font-medium text-[10px] leading-4",
                posClass(sense.pos),
              )}
            >
              {sense.pos}
            </span>
          )}
          {sense.source && (
            <span className="text-muted-foreground/50 text-[10px]">{sourceLabel(sense.source)}</span>
          )}
        </span>
      </div>
      {sense.example && (
        <div className="flex items-start gap-1.5 pl-6">
          <p className="min-w-0 flex-1 text-muted-foreground text-xs leading-relaxed break-words">
            {sense.example}
          </p>
          <button
            type="button"
            title="朗读例句"
            aria-label="朗读例句"
            onClick={() => onSpeakSentence(sense.example!)}
            className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-primary"
          >
            <Volume2 className="size-3" />
          </button>
        </div>
      )}
      {sense.example && showZh && sense.exampleZh && (
        <p className="pl-6 text-muted-foreground/60 text-xs leading-relaxed break-words">
          {sense.exampleZh}
        </p>
      )}
    </li>
  );
}
