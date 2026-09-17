/**
 *  划词栏：动作系统（对齐 pickdict SelectionToolbarView 药丸形——AGPL 只读对照
 * 重写）。logo 段 + 动作按钮列（icon+label，hover bg-accent + primary 变色）；
 * 选中文本不再预览（pickdict 同形，文本经 Rust SHARED.last_text 供面板取用）。
 * 动作集自偏好解析（lib/actions 内置目录 + 自定义 AI 动作）；AI 动作在模型服务
 * 配置就绪（aiReady）后点亮，点击经 selection_open_panel(actionId) 打开动作面板。
 * 动作分发：copy→剪贴板（成功态 2s）；search→系统浏览器（完成收起）；
 * dict/translate/explain/summary/refine/自定义→动作面板；quote→主窗口查词页。
 * 内容尺寸自适应：前端量 pill 尺寸上报 Rust set_size（0.5px 描边 + 紧投影）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Power } from "lucide-react";
import {
  aiReady,
  engineUrl,
  resolveActions,
  type ResolvedAction,
} from "../lib/actions";
import ToolbarPill from "../components/ToolbarPill";
import type { PrefsPayload } from "../types/prefs";
import type { SelectionEvent } from "../types/selection";

/** 开关提示条事件（Rust show_toggle_notice 广播） */
interface NoticeEvent {
  text: string;
  /** 自动隐藏时长（与 Rust 定时一致；前端同时用它清本地态） */
  ttlMs: number;
}

export default function ToolbarApp() {
  const [event, setEvent] = useState<SelectionEvent | null>(null);
  const [prefs, setPrefs] = useState<PrefsPayload | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 开关提示条文案（非 null = 本窗口正被当作提示条用） */
  const [notice, setNotice] = useState<string | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const noticeTimer = useRef<number>(0);
  const copiedTimer = useRef<number>(0);
  /** 偏好就绪状态（事件回调读 ref，避免闭包读到滞后值） */
  const readyRef = useRef(false);
  /** 首载失败重试标记（最多一次） */
  const retriedRef = useRef(false);
  /** 重试计时器（卸载清理） */
  const retryTimer = useRef<number>(0);

  /** 偏好加载（首载 / prefs-changed / ai-changed / 未就绪补拉共用）。
   *  时序竞态修复：Rust 端偏好初始化可能在窗口首帧之后，此时 `prefs_get`
   *  返回 Err（不再静默给默认值）——旧实现把它当作「无偏好」按内置默认集渲染，
   *  于是动作栏只显示非 AI 三项、与设置页不一致（用户实机验证）。 */
  const loadPrefs = useCallback(() => {
    void invoke<PrefsPayload>("prefs_get")
      .then((p) => {
        readyRef.current = true;
        setPrefs(p);
      })
      .catch(() => {
        readyRef.current = false;
        setPrefs(null);
        if (retriedRef.current) return;
        retriedRef.current = true;
        retryTimer.current = window.setTimeout(loadPrefs, 500);
      });
  }, []);

  useEffect(() => {
    // 透明窗口：theme.css 的 body 白底需手动透明
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.margin = "0";
    // pill 布局保持原样（量尺走影子层，见量尺注释），溢出视口的部分不产生滚动条
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    const unlisten = listen<SelectionEvent>("selection://text-selected", (e) => {
      setEvent(e.payload);
      // 真实划词接管本窗口：撤下可能仍挂着的开关提示条（同一轮 setState，
      // 不会出现「先闪一帧提示条再变浮标」）
      window.clearTimeout(noticeTimer.current);
      setNotice(null);
      // 划词 = 天然重试点：偏好仍未就绪时补拉（首载失败/竞态的长尾兜底）
      if (!readyRef.current) loadPrefs();
    });
    loadPrefs();
    // 动作配置（prefs-changed）/ AI 配置（ai-changed）变更即时刷新点亮状态
    const unPrefs = listen("prefs-changed", loadPrefs);
    const unAi = listen("ai-changed", loadPrefs);
    // 紧凑模式直推（携带新值）：渲染切换不依赖 prefs-changed 间链条路
    const unCompact = listen<boolean>("toolbar://compact", (e) => {
      setPrefs((prev) => (prev ? { ...prev, toolbarCompact: e.payload } : prev));
    });
    // 划词开关提示条（Rust 定时隐藏窗口；前端同步清态，避免下次复用时残留）
    const unNotice = listen<NoticeEvent>("selection://notice", (e) => {
      setNotice(e.payload.text);
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(null), e.payload.ttlMs);
    });
    return () => {
      void unlisten.then((f) => f());
      void unPrefs.then((f) => f(), () => {});
      void unAi.then((f) => f(), () => {});
      void unCompact.then((f) => f(), () => {});
      void unNotice.then((f) => f(), () => {});
      window.clearTimeout(copiedTimer.current);
      window.clearTimeout(retryTimer.current);
      window.clearTimeout(noticeTimer.current);
    };
  }, [loadPrefs]);

  // 内容尺寸自适应：影子量尺层（与 pill 同构的 offscreen 副本）尺寸上报 Rust 调整窗口。
  // 量尺反馈锁死两轮根因（rect 被窗口钳制 → 紧凑切换）：
  // pill 宽度跟随视口时 rect/scrollWidth 都可能量出被钳宽度（label 还会被 flex
  // 压缩后自裁剪，父容器看不到溢出），上报 → set_size → 再量 → 永久锁死；
  // w-max 直接改 pill 布局语义又引入「恒为全动作自然宽」的回归（实测）。
  // 根治 = pill 布局保持原样，量尺改测影子层：fixed 移出视口 + w-max + nowrap +
  // visibility:hidden（offsetWidth 仍可测量），宽度恒为当前渲染内容的自然宽，
  // 与窗口尺寸完全解耦——紧凑/动作增减/复制态切换全部确定正确。
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    // margin: 2px 3px 5px 3px（上 右 下 左）
    void invoke("selection_set_toolbar_size", {
      width: Math.ceil(el.offsetWidth + 6),
      height: Math.ceil(el.offsetHeight + 7),
    }).catch(() => {});
  }, [event, prefs, copiedId]);

  // 提示条尺寸（独立通道上报：写的是提示条量尺，不动划词浮标的首帧尺寸记忆）
  useLayoutEffect(() => {
    const el = noticeRef.current;
    if (!el) return;
    void invoke("selection_notice_size", {
      width: Math.ceil(el.offsetWidth + 6),
      height: Math.ceil(el.offsetHeight + 7),
    }).catch(() => {});
  }, [notice]);

  // 提示条优先于动作栏：它是本窗口当前的唯一内容（真实划词已在事件回调里撤下它）
  if (notice) {
    return (
      <div
        ref={noticeRef}
        className="m-[2px_3px_5px_3px] inline-flex h-9 w-max select-none items-center gap-2 whitespace-nowrap rounded-[10px] bg-card px-3 text-card-foreground shadow-[0_2px_3px_rgb(50_50_50_/_0.1)]"
      >
        <Power className="size-4 text-primary" />
        <span className="text-sm">{notice}</span>
      </div>
    );
  }

  // 偏好未就绪时不渲染：旧实现按内置默认集兜底，呈现的是「假设的偏好」而非用户配置
  // （动作数与设置页不一致的直接来源）。未就绪窗口极短，由 loadPrefs
  // 的重试与划词补拉保证尽快恢复。
  if (!event || !prefs) {
    return null;
  }

  // AI 动作仅在模型服务配置就绪后点亮（内置 ai 项 + 自定义项同规则）
  const aiOk = aiReady(prefs.ai);
  const compact = prefs.toolbarCompact;
  const visible = resolveActions(prefs.actionItems).filter(
    (a) => a.enabled && (!a.ai || aiOk),
  );

  const hideToolbar = () => void invoke("selection_hide_toolbar");

  const handleAction = (a: ResolvedAction) => {
    const text = event.text;
    switch (a.id) {
      case "copy":
        void invoke("clipboard_write", { text })
          .then(() => {
            setCopiedId(a.id);
            window.clearTimeout(copiedTimer.current);
            copiedTimer.current = window.setTimeout(() => setCopiedId(null), 2000);
          })
          .catch(() => {});
        break;
      case "search": {
        const url = engineUrl(a.searchEngine, text);
        if (!url) return;
        void invoke("open_external", { url })
          .then(hideToolbar)
          .catch(() => {});
        break;
      }
      case "dict": {
        const [x, y] = event.refPoint;
        void invoke("selection_open_panel", { x, y });
        break;
      }
      default:
        // AI 动作（内置 translate/explain/summary/refine 与自定义 user-*）：打开动作面板
        if (a.ai) {
          const [x, y] = event.refPoint;
          void invoke("selection_open_panel", { x, y, actionId: a.id });
        }
        break;
    }
  };

  return (
    <>
      {/* 影子量尺层：与真身同构（ToolbarPill），offscreen + w-max + invisible
          （visibility:hidden 的 offsetWidth 仍可测量）——宽度恒为当前渲染内容的
          自然宽，与窗口尺寸完全解耦 */}
      <ToolbarPill
        ref={measureRef}
        actions={visible}
        compact={compact}
        copiedId={copiedId}
        onAction={handleAction}
        className="invisible pointer-events-none fixed left-[-9999px] top-0 z-[-1] w-max whitespace-nowrap"
      />
      <ToolbarPill
        actions={visible}
        compact={compact}
        copiedId={copiedId}
        onAction={handleAction}
        className="m-[2px_3px_5px_3px] overflow-hidden bg-card shadow-[0_2px_3px_rgb(50_50_50_/_0.1)]"
      />
    </>
  );
}
