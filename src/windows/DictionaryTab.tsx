/**
 * 词典 Tab：**全部词典并行查询 + 折叠分区**（每次查询后未命中词典默认折叠，
 * pickdict LookupPage 策略——不做单词典 Select 再查词）。
 * 查询管线复用划词面板的 DictionaryPanel（collapsible 形态，iframe 沙箱渲染 +
 * entry:// 重查 + sound:// 发音 + 高度自适应 token 门禁，同构单实现）。
 *
 * 生词卡接入：当前词头可加入生词本（幂等），vocabulary-changed 驱动状态刷新。
 * 查词历史：Rust history.json 持久化（history_list/add/clear + history-changed 广播；
 * 仅记显式查询，不含内链跳词）。词典目录设置迁设置页，此处监听 dictionary.root-changed
 * 广播刷新词典。词典管理变更触发的重查**延迟到本页激活时**执行（active prop）——
 * 设置页操作不拖慢切页速度。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, BookmarkCheck, BookmarkPlus, Search, X } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Input } from "@onedict/ui/components/input";
import { Tooltip } from "@onedict/ui/components/tooltip";
import { cn } from "../lib/utils";
import { useWordNav } from "../lib/wordNav";
import { initSpxDecoder } from "../services/spxDecoder";
import speexCode from "../vendor/speex/speex.min.js?raw";
import type { HistoryEntry } from "../types/history";
import DictionaryPanel, { type SoundHint } from "./panel/DictionaryPanel";

export default function DictionaryTab({
  active = true,
  lookupReq = null,
}: {
  active?: boolean;
  /** 生词本点词跳转来的查词请求（MainApp lookupReq 管道；seq 变化即触发） */
  lookupReq?: { word: string; seq: number } | null;
}) {
  /** 输入框草稿；Enter 提交为 word 触发查询（DictionaryPanel 监听 word） */
  const [input, setInput] = useState("");
  /** 查词导航栈（跳词/新查询入栈，顶栏后退/前进穿梭）——word 单一事实源 */
  const { word, canBack, canForward, navigate, back: navBack, forward: navForward } = useWordNav();
  const [inVocabulary, setInVocabulary] = useState(false);
  /**
   * 统一临时提示位（历史行右侧）：加入生词本 / 发音状态等瞬时信息都显示在
   * 这里，4s 自动消失、换词即清——不再各处流内插行挤压词典布局
   * （实测：vocabHint 常驻不消失 / 发音提示挤词典位置）。
   */
  const [hint, setHint] = useState<{ text: string; kind: "success" | "error" | "info" } | null>(
    null,
  );
  const hintTimer = useRef<number | null>(null);
  /** 查词历史（Rust history.json 持久化，最近优先；仅记显式查询，不含内链跳词） */
  const [history, setHistory] = useState<string[]>([]);
  /** 词典目录变更后驱动 DictionaryPanel 重列词典（dictionary.root-changed 广播驱动） */
  const [dictsVersion, setDictsVersion] = useState(0);
  /** 变更延后标记：本页非激活时只记 dirty，激活时再应用（重查不拖慢切页） */
  const dirtyRef = useRef(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);

  // speex wasm 预热（幂等；正式解码管线在 DictionaryPanel，独立 webview 各自 init）
  useEffect(() => {
    void initSpxDecoder({
      code: speexCode,
      evaluate: (code) =>
        new Function(`${code}\n;return typeof SpeexFactory !== "undefined" ? SpeexFactory : undefined;`)(),
      logError: (m) => console.error(m),
    }).catch((e) => {
      console.error(`spx decoder init failed, .spx will serve raw bytes: ${String(e)}`);
    });
  }, []);

  //词典目录/启停/顺序在设置页维护；监听变更广播 → DictionaryPanel 重列词典。
  // 非激活时只记 dirty（hidden 页里 iframe 重查既不可见又抢主线程），激活时应用——
  // 「设置页开词典 → 切词典页」先完成切换再刷新，响应延迟不再影响切页速度
  useEffect(() => {
    const unlisten = listen("dictionary-changed", () => {
      if (active) {
        setDictsVersion((v) => v + 1);
      } else {
        dirtyRef.current = true;
      }
    });
    return () => {
      void unlisten.then((f) => f(), () => {});
    };
  }, [active]);

  // 页激活时应用积压的词典变更（重查发生在切换渲染之后，不阻塞切页）
  useEffect(() => {
    if (active && dirtyRef.current) {
      dirtyRef.current = false;
      setDictsVersion((v) => v + 1);
    }
  }, [active]);

  // 拉取历史 + 监听变更广播（Rust 持久化；发起窗口也收广播，统一由此刷新 state）
  const reloadHistory = useCallback(() => {
    void invoke<HistoryEntry[]>("history_list")
      .then((list) => setHistory(list.map((e) => e.word)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    reloadHistory();
    const un = listen("history-changed", reloadHistory);
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, [reloadHistory]);

  // 提交查询：记入历史（Rust history_add 幂等去重 + 广播回刷本地 state）；
  // 入导航栈（输入框新查询与历史点击同为显式跳词，开新分支）
  const commit = useCallback(
    (target: string) => {
      const t = target.trim();
      if (!t) return;
      navigate(t);
      void invoke("history_add", { word: t }).catch(() => {});
    },
    [navigate],
  );

  // 词条内链跳词 / 帧内取词（DictionaryPanel 回传）：入导航栈，同步输入框
  const handleWordChange = useCallback(
    (w: string) => {
      navigate(w);
      setInput(w);
    },
    [navigate],
  );

  // 输入框草稿跟随导航（后退/前进/跳词后同步；导航不动栈时 word 不变无副作用）
  useEffect(() => {
    setInput(word);
  }, [word]);

  // 生词本点词 → 外部查词请求（显式跳词入导航栈；pushWord 同词幂等）
  useEffect(() => {
    if (lookupReq) {
      navigate(lookupReq.word);
    }
  }, [lookupReq, navigate]);

  // 查询/跳词后结果区回到顶部（pickdict per-session reset 语义）
  useEffect(() => {
    resultsRef.current?.scrollTo({ top: 0 });
  }, [word]);

  // 当前词头是否已在生词本（竞态：仅接受最后一次的结果）
  const checkInVocabulary = useCallback((target: string) => {
    let cancelled = false;
    setInVocabulary(false);
    if (target) {
      void invoke<boolean>("vocabulary_has", { word: target }).then((has) => {
        if (!cancelled) setInVocabulary(has);
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => checkInVocabulary(word), [word, checkInVocabulary]);

  // 生词本任何变更（复习页删除等）→ 刷新当前词头的加入状态
  useEffect(() => {
    const unlisten = listen("vocabulary-changed", () => {
      if (word) {
        void invoke<boolean>("vocabulary_has", { word }).then(setInVocabulary).catch(() => {});
      }
    });
    return () => {
      void unlisten.then((f) => f(), () => {});
    };
  }, [word]);

  const clearHint = useCallback(() => {
    if (hintTimer.current !== null) {
      window.clearTimeout(hintTimer.current);
      hintTimer.current = null;
    }
    setHint(null);
  }, []);

  /** 临时提示：4s 自动消失（重复显示重置计时） */
  const showHint = useCallback(
    (text: string, kind: "success" | "error" | "info" = "info") => {
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
      setHint({ text, kind });
      hintTimer.current = window.setTimeout(() => {
        hintTimer.current = null;
        setHint(null);
      }, 4000);
    },
    [],
  );

  // 卸载清理提示计时器
  useEffect(
    () => () => {
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    },
    [],
  );

  // 换词后旧提示已过时（加入生词本/发音状态都只对当前词有意义）→ 立即清除
  useEffect(() => {
    clearHint();
  }, [word, clearHint]);

  /** DictionaryPanel 发音状态上抛 → 统一临时提示位（null = 发音完成清除） */
  const handleSoundStatus = useCallback(
    (h: SoundHint | null) => {
      if (h) showHint(h.text, h.kind);
      else clearHint();
    },
    [showHint, clearHint],
  );

  // 幂等加词（vocabulary.add 语义：已存在返回已有条目 created=false）
  const addToVocabulary = () => {
    if (!word) return;
    invoke<{ entry: unknown; created: boolean }>("vocabulary_add", { word })
      .then((r) => {
        setInVocabulary(true);
        showHint(r.created ? "已加入生词本" : "已在生词本中", "success");
      })
      .catch((e) => showHint(`加入失败：${String(e)}`, "error"));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 搜索区 */}
      <div className="shrink-0 px-6 pt-4 pb-2">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
          <div className="flex items-center gap-2">
            {/*查词导航后退/前进（disabled 态跟随导航栈） */}
            <Tooltip content="后退" placement="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!canBack}
                onClick={navBack}
                aria-label="后退"
              >
                <ArrowLeft className="size-[15px]" />
              </Button>
            </Tooltip>
            <Tooltip content="前进" placement="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!canForward}
                onClick={navForward}
                aria-label="前进"
              >
                <ArrowRight className="size-[15px]" />
              </Button>
            </Tooltip>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(input);
                }}
                placeholder="输入词头，回车查词（全部词典并行）"
                className="pl-8 pr-8"
                autoFocus
                spellCheck={false}
              />
              {/* 清空输入框（灰色叉号，有草稿时显示）。定位类必须挂在 Tooltip 的
                  wrapper 上（classNames.placeholder）——Tooltip 复合组件包一层
                  relative inline-block wrapper，button 的 absolute 会相对这层塌缩
                  wrapper 而非输入框容器（实测：叉号偏下根因） */}
              {input && (
                <Tooltip
                  content="清空"
                  placement="bottom"
                  classNames={{ placeholder: "absolute top-1/2 right-2 -translate-y-1/2" }}
                >
                  <button
                    type="button"
                    aria-label="清空输入框"
                    onClick={() => setInput("")}
                    className="flex size-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </Tooltip>
              )}
            </div>
            {word && (
              <Tooltip
                content={inVocabulary ? "已在生词本中" : "加入生词本"}
                placement="bottom"
              >
                <Button type="button" variant="ghost" size="icon-sm" onClick={addToVocabulary}>
                  {inVocabulary ? (
                    <BookmarkCheck className="size-[15px] text-green-600" />
                  ) : (
                    <BookmarkPlus className="size-[15px]" />
                  )}
                </Button>
              </Tooltip>
            )}
          </div>

          {/* 历史词（限 8 条、总宽 ≤2/3 单行截断）+ 统一临时提示位（右侧）
              —— 实测：临时提示不再流内插行，历史不再无限换行 */}
          {(history.length > 0 || hint) && (
            <div className="flex items-center gap-3">
              {history.length > 0 && (
                <div className="flex min-w-0 max-w-[66%] items-center gap-1.5 overflow-hidden">
                  <span className="shrink-0 text-muted-foreground text-xs">历史</span>
                  {history.slice(0, 8).map((h) => (
                    <button
                      key={h}
                      type="button"
                      onClick={() => commit(h)}
                      title={`查询 ${h}`}
                      className="max-w-[160px] cursor-pointer truncate rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {h}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => void invoke("history_clear").catch(() => {})}
                    title="清空历史"
                    className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-muted-foreground text-xs hover:text-foreground"
                  >
                    清空
                  </button>
                </div>
              )}
              {hint && (
                <div
                  role="status"
                  title={hint.text}
                  className={cn(
                    "ml-auto shrink-0 max-w-[30%] truncate text-xs",
                    hint.kind === "success" && "text-green-600",
                    hint.kind === "error" && "text-destructive",
                    hint.kind === "info" && "text-muted-foreground",
                  )}
                >
                  {hint.text}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 结果区：多词典折叠分区（DictionaryPanel collapsible 形态） */}
      <div ref={resultsRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {word.trim() ? (
            <DictionaryPanel
              word={word}
              onWordChange={handleWordChange}
              variant="card"
              reloadKey={dictsVersion}
              onStatus={handleSoundStatus}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 pt-16 text-center text-foreground-tertiary">
              <Search className="size-8 opacity-40" />
              <p className="text-sm">输入词头回车查询；全部词典并行，未命中的默认折叠</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
