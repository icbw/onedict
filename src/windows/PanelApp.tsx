/**
 * 划词动作面板窗口（label = action-panel）——多动作容器：
 * dict → 词典查词（DictionaryPanel），translate → AI 翻译（ActionTranslate），
 * explain/summary/refine 与自定义动作（user-*）→ 通用 AI 流式（ActionGeneral）。
 * 行为基线 pickdict ActionWindow（AGPL 只读对照，壳按 Tauri 机制重写）：
 * - 取词：listen selection://panel-text（Rust selection_open_panel 广播，含 actionId）
 * - 标题栏可拖拽（data-tauri-drag-region）+ 词头加生词本（幂等，仅查词会话）+
 *   pin 常驻 + 关闭；失焦自动隐藏在 Rust 侧（Focused(false) && !pinned → hide）
 * - 会话重置：每次 panel-text 到达重置 pin 状态与提示（pickdict per-session reset）
 *  视觉还原：rounded-lg + border-border + bg-popover 卡片、h-8 标题栏
 * （聚焦 bg-muted / 失焦 bg-secondary 渐变）+ ghost 图标按钮（Bookmark/Pin/X）；
 * 窗口操作照旧走 Rust command（capability 约定）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, BookmarkCheck, BookmarkPlus, Pin, X } from "lucide-react";
import { Button } from "@onedict/ui/components/button";
import { Input } from "@onedict/ui/components/input";
import { Tooltip } from "@onedict/ui/components/tooltip";
import type * as React from "react";
import { cn } from "../lib/utils";
import {
  goBackWord,
  goForwardWord,
  pushWord,
  resetWordNav,
  type WordNavState,
} from "../lib/wordNav";
import { resolveActions, type ResolvedAction } from "../lib/actions";
import type { PanelTextEvent } from "../types/selection";
import type { PrefsPayload } from "../types/prefs";
import ActionGeneral from "./panel/ActionGeneral";
import ActionTranslate from "./panel/ActionTranslate";
import DictionaryPanel from "./panel/DictionaryPanel";

/** pickdict ActionWindow 的 WindowButton 同款：ghost icon-sm 紧凑方形 */
const WindowButton = ({ className, ...props }: React.ComponentProps<typeof Button>) => (
  <Button
    type="button"
    variant="ghost"
    size="icon-sm"
    className={cn(
      "size-6 rounded border-0 bg-transparent p-0 text-muted-foreground shadow-none transition-colors hover:bg-accent hover:text-accent-foreground",
      className,
    )}
    {...props}
  />
);

/** 一次面板会话：触发动作 + 选中文本 + 动作解析结果（AI 会话异步补齐） */
interface PanelSession {
  /** 会话序号：同动作同文本再次触发时 key 相同会复用旧 AI 会话
   *  DOM（不重挂载、不重跑）——seq 使每次触发必然重挂重跑 */
  seq: number;
  actionId: string;
  text: string;
  /** AI 动作解析（label/prompt/model）；dict 不需要，解析失败为 undefined */
  action?: ResolvedAction | null;
}

export default function PanelApp() {
  const [session, setSession] = useState<PanelSession | null>(null);
  const [pinned, setPinned] = useState(false);
  const [inVocabulary, setInVocabulary] = useState(false);
  const [vocabHint, setVocabHint] = useState<string | null>(null);
  const [isWindowFocus, setIsWindowFocus] = useState(true);
  /** 顶栏词头输入框（顶栏直接可编辑，兜底划词捕获错误格式）；
   *  草稿随会话词头同步，Enter/失焦提交重查 */
  const [wordDraft, setWordDraft] = useState("");
  /** 查词导航栈：新会话重置；entry:// 跳词/帧内取词/词头改查入栈，
   *  标题栏后退/前进穿梭（仅查词会话可用） */
  const [nav, setNav] = useState<WordNavState>(() => resetWordNav(""));
  const contentRef = useRef<HTMLDivElement | null>(null);
  /** 会话递增序号（aiSessionKey 组成；见 PanelSession.seq） */
  const sessionSeq = useRef(0);

  useEffect(() => {
    // body margin/overflow 已由全局 app.css 统一处理（无框窗口标配）；
    // 标题栏明暗跟随窗口焦点（pickdict ActionWindow 行为）
    const onFocus = () => setIsWindowFocus(true);
    const onBlur = () => setIsWindowFocus(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<PanelTextEvent>("selection://panel-text", (e) => {
      const actionId = e.payload.actionId || "dict";
      const text = e.payload.text;
      // 每会话重置（pickdict per-session reset：老会话状态不带入新会话）；
      // 导航栈随会话重置（新划词是全新起点，不带上一会话历史）
      setPinned(false);
      setInVocabulary(false);
      setVocabHint(null);
      setSession({ seq: ++sessionSeq.current, actionId, text, action: undefined });
      setNav(resetWordNav(text));
      // AI 动作：按当前偏好解析动作定义（label/prompt/model；自定义动作配置可能
      // 刚被修改，面板总是取最新值）。dict 不需要解析。
      if (actionId !== "dict") {
        void invoke<PrefsPayload>("prefs_get")
          .then((p) => {
            const act = resolveActions(p.actionItems).find((a) => a.id === actionId) ?? null;
            // 仅当仍是同一会话时回填（快速连点防串）
            setSession((s) =>
              s && s.actionId === actionId && s.text === text ? { ...s, action: act } : s,
            );
          })
          .catch(() => {
            // 读取失败也落地（避免永久「加载中」），提示文案覆盖删除/失败两种情况
            setSession((s) =>
              s && s.actionId === actionId && s.text === text ? { ...s, action: null } : s,
            );
          });
      }
    });
    return () => {
      void unlisten.then((f) => f(), () => {});
    };
  }, []);

  const isDict = !session || session.actionId === "dict";
  const word = isDict ? (session?.text ?? "") : "";

  // 词典管理变更（启停/顺序/目录，dictionary-changed 广播）→ 面板重列词典并
  // 重查当前词。DictionaryPanel 的 lookupAll 由 [dicts, word] 驱动：同词重查时
  // word 不变，需以 reloadKey 递增重列（dicts 新引用）强制刷新——否则开关词典后
  // 重查同词复用旧结果（实测；主窗口词典页同款联动已有）
  const [dictReloadKey, setDictReloadKey] = useState(0);
  useEffect(() => {
    const un = listen("dictionary-changed", () => setDictReloadKey((k) => k + 1));
    return () => {
      void un.then((f) => f(), () => {});
    };
  }, []);

  // 当前词头是否已在生词本（竞态：仅接受最后一次的结果；仅查词会话）
  useEffect(() => {
    let cancelled = false;
    setInVocabulary(false);
    setVocabHint(null);
    if (isDict && word.trim()) {
      void invoke<boolean>("vocabulary_has", { word }).then((has) => {
        if (!cancelled) setInVocabulary(has);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [isDict, word]);

  // 新会话（跳词/新划词）内容区回到顶部（pickdict ActionWindow per-session reset 语义）
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [session?.actionId, session?.text]);

  const addToVocabulary = useCallback(() => {
    if (!word.trim()) return;
    invoke<{ created: boolean }>("vocabulary_add", { word })
      .then((r) => {
        setInVocabulary(true);
        setVocabHint(r.created ? "已加入生词本" : "已在生词本中");
      })
      .catch(() => setVocabHint("加入失败"));
  }, [word]);

  const togglePin = useCallback(() => {
    setPinned((p) => {
      void invoke("selection_set_panel_pinned", { pinned: !p });
      return !p;
    });
  }, []);

  const close = useCallback(() => {
    // 走 Rust 命令隐藏（前端 hide() 需要 core:window:allow-hide 权限，未授予）
    void invoke("selection_hide_panel");
  }, []);

  // 词条内链跳词 / 帧内取词（DictionaryPanel 回传）：复用 entry:// 跳词同路径并
  // 入导航栈（跳词 push 清空 forward，同浏览器语义）
  const handlePanelWord = useCallback((w: string) => {
    setSession({ seq: ++sessionSeq.current, actionId: "dict", text: w, action: undefined });
    setNav((s) => pushWord(s, w));
  }, []);

  // 词头输入框提交（Enter/失焦）：复用 entry:// 跳词同路径（改 session.text →
  // DictionaryPanel 因 word 变化自动重查，生词本按钮状态随 useEffect 刷新）+
  // 入导航栈；空词 / 与当前相同 = 还原草稿不动会话（兜底划词错误格式的场景：
  // 直接改完回车）
  const commitWordEdit = useCallback(() => {
    const t = wordDraft.trim();
    if (t && session && t !== session.text) {
      setSession({ seq: ++sessionSeq.current, actionId: "dict", text: t, action: undefined });
      setNav((s) => pushWord(s, t));
    } else {
      setWordDraft(session?.text ?? "");
    }
  }, [wordDraft, session]);

  // 后退/前进：cursor 在导航栈间移动并同步查词会话（仅查词会话入口可达）
  const navBack = () => {
    if (!nav.back.length) return;
    const target = nav.back[nav.back.length - 1];
    setNav(goBackWord);
    setSession({ seq: ++sessionSeq.current, actionId: "dict", text: target, action: undefined });
  };
  const navForward = () => {
    if (!nav.forward.length) return;
    const target = nav.forward[0];
    setNav(goForwardWord);
    setSession({ seq: ++sessionSeq.current, actionId: "dict", text: target, action: undefined });
  };

  // 词条内链跳词 / 会话重置后草稿同步（word 变化的非手输来源：entry:// 重查）
  useEffect(() => {
    setWordDraft(word);
  }, [word]);

  // 标题栏文案：查词会话 = 词头；AI 会话 = 动作名
  const headerTitle = isDict
    ? word || "…"
    : session.action === undefined
      ? "…"
      : session.action?.label ?? "动作已删除";

  // AI 会话 key：动作+会话序号唯一——seq 使同动作同文本再次触发也重挂重跑
  //（原 key 含 text，同文本复用旧会话 DOM 不重新生成）
  const aiSessionKey = session ? `${session.actionId}:${session.seq}` : "";

  return (
    <div
      className={cn(
        "relative m-1 box-border flex flex-col overflow-hidden rounded-lg border border-border bg-popover",
        // 视口高减去上下 margin（4×2）：保证根 div 不撑出 body 滚动
        "h-[calc(100vh-8px)]",
      )}
    >
      {/* 标题栏：拖拽区 + 词头/动作名 + 加生词本（仅查词） + pin + 关闭。
          onMouseDown：点击拖拽区/按钮时主动失焦词头输入框（触发提交）——
          拖拽开始后 webview 收不到后续 blur 事件（失焦不稳定） */}
      <div
        data-tauri-drag-region
        onMouseDown={() => {
          const el = document.activeElement;
          if (el instanceof HTMLInputElement) el.blur();
        }}
        className={cn(
          "flex h-8 shrink-0 flex-row items-center px-2 transition-colors duration-300",
          isWindowFocus ? "bg-muted" : "bg-secondary",
        )}
      >
        {isDict ? (
          <>
            {/*查词导航后退/前进（disabled 态跟随导航栈） */}
            <WindowButton
              disabled={nav.back.length === 0}
              onClick={navBack}
              className="ml-1"
              aria-label="后退"
            >
              <ArrowLeft className="size-3.5" />
            </WindowButton>
            <WindowButton
              disabled={nav.forward.length === 0}
              onClick={navForward}
              aria-label="前进"
            >
              <ArrowRight className="size-3.5" />
            </WindowButton>
            {/* 顶栏词头 = 常驻输入框（直接编辑兜底划词捕获错误格式；
               Enter/失焦提交重查，Esc 还原。宽度 = 标题栏一半——占满会吃掉拖拽区；
               输入框区域不参与窗口拖拽，bar 其余区域可拖） */}
            <Input
              value={wordDraft}
              onChange={(e) => setWordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitWordEdit();
                else if (e.key === "Escape") setWordDraft(word);
              }}
              onBlur={commitWordEdit}
              spellCheck={false}
              title="查词词头：Enter 重查，Esc 还原"
              className="ml-1 h-6 w-1/2 min-w-0 bg-white px-1.5 py-0 text-sm"
            />
          </>
        ) : (
          <span
            data-tauri-drag-region
            className="ml-1 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground text-sm font-normal"
          >
            {headerTitle}
          </span>
        )}
        {vocabHint && <span className="text-green-600 text-xs">{vocabHint}</span>}
        <div className="ml-auto flex items-center gap-1">
          {isDict && word.trim() && (
            <Tooltip
              content={inVocabulary ? "已在生词本中" : "加入生词本"}
              placement="bottom"
            >
              <WindowButton onClick={addToVocabulary}>
                {inVocabulary ? (
                  <BookmarkCheck className="size-[15px] text-green-600" />
                ) : (
                  <BookmarkPlus className="size-[15px]" />
                )}
              </WindowButton>
            </Tooltip>
          )}
          <Tooltip
            content={pinned ? "取消常驻" : "窗口常驻（失焦不隐藏）"}
            placement="bottom"
          >
            <WindowButton
              onClick={togglePin}
              className={pinned ? "bg-accent text-accent-foreground hover:bg-accent" : undefined}
            >
              <Pin
                className={cn(
                  "size-[13px] transition-transform",
                  pinned && "rotate-45 text-accent-foreground",
                )}
              />
            </WindowButton>
          </Tooltip>
          <Tooltip content="关闭" placement="bottom">
            <WindowButton
              onClick={close}
              className="hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="size-3.5" />
            </WindowButton>
          </Tooltip>
        </div>
      </div>

      {/* 内容区：按动作分发（查词词典 / AI 翻译 / 通用 AI 流式） */}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
        {isDict && (
          <DictionaryPanel word={word} onWordChange={handlePanelWord} variant="flat" reloadKey={dictReloadKey} />
        )}
        {!isDict && session.action === undefined && (
          <div className="p-4 text-muted-foreground text-sm">加载中…</div>
        )}
        {!isDict && session.action === null && (
          <div className="p-4 text-muted-foreground text-sm">
            未找到该动作的配置（可能已被删除或读取失败），可在设置 → 划词助手中检查。
          </div>
        )}
        {!isDict && session.action && session.actionId === "translate" && (
          <div className="p-4">
            <ActionTranslate
              key={aiSessionKey}
              text={session.text}
              prompt={session.action.prompt}
              model={session.action.model}
              allowThink={session.action.allowThink}
            />
          </div>
        )}
        {!isDict && session.action && session.actionId !== "translate" && (
          <div className="p-4">
            <ActionGeneral
              key={aiSessionKey}
              actionId={session.actionId}
              text={session.text}
              prompt={session.action.prompt}
              model={session.action.model}
              allowThink={session.action.allowThink}
            />
          </div>
        )}
      </div>
    </div>
  );
}
