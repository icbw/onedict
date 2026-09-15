/**
 * 主窗口：左侧竖排图标导航（用户修订弃顶部 Tab：占高度且不利扩展）+
 * 右侧内容区。导航：词典 / 生词本 / 翻译 / 查词历史 中部，设置置底；
 * 查词历史页点词复用 lookupReq 管道跳词典页。
 * 品牌 = onedict 自有（无 cherry 资产）。Tab keep-alive 语义保留：全部页常挂载、
 * hidden 切换（切页不丢状态）；主窗口关闭 = 隐藏到托盘（托盘退出为唯一退出路径）。
 *划词调试台退役（埋点保留 Rust 日志侧），第四页为设置。
 * 用户修订：复习并入生词本（统计头 + 单元制 + 学习卡弹窗），
 * 导航删「复习」；生词本点词 → lookupReq 管道跳词典页查词（seq 去重防同词重放）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  BookMarked,
  BookOpenText,
  History,
  Languages,
  Settings,
} from "lucide-react";
import { Tooltip } from "@onedict/ui/components/tooltip";
import { cn } from "../lib/utils";
import { useUpdateAvailable } from "../lib/useUpdateAvailable";
import DictionaryTab from "./DictionaryTab";
import VocabularyTab from "./VocabularyTab";
import TranslateTab from "./TranslateTab";
import HistoryTab from "./HistoryTab";
import SettingsTab from "./SettingsTab";

type Tab = "dictionary" | "vocabulary" | "translate" | "history" | "settings";

/** 生词本→词典页的查词请求（seq 递增保证同词重复点击也触发） */
export interface LookupRequest {
  word: string;
  seq: number;
}

export default function MainApp() {
  const [tab, setTab] = useState<Tab>("dictionary");
  const [lookupReq, setLookupReq] = useState<LookupRequest | null>(null);
  // 启动检查命中（偏好「启动时检查更新」开启才可能发生）：在设置入口标点，进设置即收起
  const updateAvailable = useUpdateAvailable();
  const [updateSeen, setUpdateSeen] = useState(false);

  useEffect(() => {
    if (tab === "settings") setUpdateSeen(true);
  }, [tab]);

  /** 生词本点词 → 切词典页并查词 */
  const openLookup = useCallback((word: string) => {
    setTab("dictionary");
    setLookupReq((r) => ({ word, seq: (r?.seq ?? 0) + 1 }));
  }, []);

  return (
    <div className="flex h-screen w-full">
      {/* 左侧导航栏：中部功能入口 + 底部设置。
          顶部品牌章已删（与词典 tab 图标重复）；选中态 = 品牌色方块（原品牌章
          样式下放） */}
      <nav className="flex w-[52px] shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/30 py-3">
        <NavBtn
          icon={BookOpenText}
          label="词典"
          active={tab === "dictionary"}
          onClick={() => setTab("dictionary")}
        />
        <NavBtn
          icon={BookMarked}
          label="生词本"
          active={tab === "vocabulary"}
          onClick={() => setTab("vocabulary")}
        />
        <NavBtn
          icon={Languages}
          label="翻译"
          active={tab === "translate"}
          onClick={() => setTab("translate")}
        />
        <NavBtn
          icon={History}
          label="查词历史"
          active={tab === "history"}
          onClick={() => setTab("history")}
        />
        <div className="flex-1" />
        <NavBtn
          icon={Settings}
          label="设置"
          active={tab === "settings"}
          dot={updateAvailable && !updateSeen}
          onClick={() => setTab("settings")}
        />
      </nav>

      <div className="min-w-0 flex-1">
        {/* keep-alive：全部页常挂载、hidden 切换 —— 切页不卸载组件，
            查词结果/复习会话/设置态跨页保留；主窗口关闭 = 进程退出，state 随之清空。
            词典页传 active：词典管理变更的重查延迟到页激活时执行（用户
            反馈——设置页操作触发的重查不能拖慢切页速度） */}
        <div className={tab === "dictionary" ? "h-full" : "hidden"}>
          <DictionaryTab active={tab === "dictionary"} lookupReq={lookupReq} />
        </div>
        <div className={tab === "vocabulary" ? "h-full" : "hidden"}>
          <VocabularyTab onLookup={openLookup} />
        </div>
        <div className={tab === "translate" ? "h-full" : "hidden"}>
          <TranslateTab active={tab === "translate"} />
        </div>
        <div className={tab === "history" ? "h-full" : "hidden"}>
          <HistoryTab onLookup={openLookup} />
        </div>
        <div className={tab === "settings" ? "h-full" : "hidden"}>
          <SettingsTab active={tab === "settings"} />
        </div>
      </div>
    </div>
  );
}

function NavBtn({
  icon: Icon,
  label,
  active,
  onClick,
  dot = false,
}: {
  icon: typeof Settings;
  label: string;
  active: boolean;
  onClick: () => void;
  /** 未读点（新版本待查看） */
  dot?: boolean;
}) {
  return (
    <Tooltip content={label} placement="right">
      <button
        type="button"
        aria-label={label}
        aria-current={active || undefined}
        onClick={onClick}
        className={cn(
          "relative flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors",
          active
            ? "bg-primary text-white shadow-sm"
            : "hover:bg-accent/60 hover:text-foreground",
        )}
      >
        <Icon className="size-[18px]" />
        {dot && (
          <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary ring-2 ring-muted" />
        )}
      </button>
    </Tooltip>
  );
}
