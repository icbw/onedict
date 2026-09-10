/**
 * 截图翻译折叠 bar（PixPin 式工具条）——应用覆盖层（OcrCaptureApp）与设置页
 * 「截图助手」预览共用同一组件（与划词助手 ToolbarPill 预览同一模式：所见即所得，
 * 以后新增功能按钮在此同步出现）。
 *
 * 布局（增系统识别）：[目标▾] [↺] | [译] [ScanText 识别] [✨AI] [TextSelect 复制] [Languages 切换] | [▾] [×]
 * - 目标下拉点开面板内切换，会话级临时（设置页 = 默认入口），偏离默认时显示 ↺ 还原
 * - 「译」= 单字按钮，中性配色不强调（主操作高频，视觉应轻）
 * - ScanText 图标 = 系统识别（Windows OCR 对当前快照跑识别； 截图
 *   默认不自动识别后为手动入口）；Sparkles = AI 识别（只识别不翻译，
 *   进行中图标转圈——loading 语义只属翻译按钮，二者互斥）
 * - TextSelect 图标 = 复制当前文字（OCR 原文）
 * - Languages 图标 = 切换译文/原文叠加（激活态 = 图标主题色，无底色块）
 * - 全部图标按钮 hover = 灰底 + 图标主题强调色（对齐主题）
 * - ▾ 展开翻译详情卡；× 关闭（退出只走 Esc/×，对齐主流截图工具）
 */
import { ChevronDown, Copy, Languages, Loader2, RotateCcw, ScanText, Sparkles, TextSelect, X } from "lucide-react";
import { cn } from "../lib/utils";
import LangSelect from "./LangSelect";

type Props = {
  /** 目标语言 code（"" = 自动译为中文） */
  targetValue: string;
  /** 默认目标（还原按钮的还原目标；与 targetValue 一致时不显示还原） */
  defaultTarget: string;
  loading: boolean;
  /** AI OCR 进行中（✨ 按钮转圈；与 loading 互斥——loading 只代表翻译流，
   *  AI OCR 复用同一 useAiStream，不区分 = 翻译按钮错误转圈的实测 bug） */
  aiOcrLoading?: boolean;
  /** 叠加当前态：true = 译文（切换按钮图标主题色）；false = 原文 */
  showOverlay: boolean;
  onTargetChange: (code: string) => void;
  onResetTarget: () => void;
  onTranslate: () => void;
  /** AI OCR 兜底（常驻）：快照直发视觉模型**只识别不翻译**，识别文本回填行数据；
   *  未配置时调用方负责提示 */
  onVisionTranslate: () => void;
  /** 系统 OCR 识别（截图默认不自动识别后的手动入口，对当前快照
   *  帧跑 Windows OCR；识别中转圈，与翻译/AI 流互斥） */
  onSystemOcr: () => void;
  ocrLoading?: boolean;
  onCopySource: () => void;
  onToggleOverlay: () => void;
  /** 复制截图快照（应用内复制后退出截图；设置页预览 no-op） */
  onCopySnapshot: () => void;
  onExpand: () => void;
  onClose: () => void;
  className?: string;
};

export default function CaptureBar({
  targetValue,
  defaultTarget,
  loading,
  aiOcrLoading = false,
  showOverlay,
  onTargetChange,
  onResetTarget,
  onTranslate,
  onVisionTranslate,
  onSystemOcr,
  ocrLoading = false,
  onCopySource,
  onToggleOverlay,
  onCopySnapshot,
  onExpand,
  onClose,
  className,
}: Props) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs shadow-xl",
        className,
      )}
    >
      <LangSelect
        value={targetValue}
        auto="自动（译为中文）"
        onChange={onTargetChange}
        title="翻译目标语言"
        className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-neutral-100"
      />
      {targetValue !== defaultTarget && (
        <button
          type="button"
          onClick={onResetTarget}
          title="还原为默认"
          className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
      <span className="mx-0.5 h-4 w-px shrink-0 bg-neutral-200" />
      {loading ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <button
          type="button"
          onClick={onTranslate}
          title="翻译"
          className="shrink-0 rounded px-2.5 py-1 font-medium text-neutral-700 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
        >
          译
        </button>
      )}
      <button
        type="button"
        onClick={onSystemOcr}
        title="识别文字（系统 OCR）"
        className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
      >
        {ocrLoading ? <Loader2 className="size-3.5 animate-spin" /> : <ScanText className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={onVisionTranslate}
        title="AI 识别"
        className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
      >
        {aiOcrLoading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={onCopySource}
        title="复制当前文字"
        className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
      >
        <TextSelect className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onToggleOverlay}
        title="切换译文/原文"
        className={cn(
          "shrink-0 rounded p-1.5 [cursor:pointer]",
          showOverlay
            ? "text-primary hover:bg-neutral-100"
            : "text-neutral-600 hover:bg-neutral-100 hover:text-primary",
        )}
      >
        <Languages className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onCopySnapshot}
        title="复制截图"
        className="shrink-0 rounded p-1.5 text-neutral-600 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
      >
        <Copy className="size-3.5" />
      </button>
      <span className="mx-0.5 h-4 w-px shrink-0 bg-neutral-200" />
      <button
        type="button"
        onClick={onExpand}
        title="展开翻译详情"
        className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
      >
        <ChevronDown className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        title="关闭 (Esc)"
        className="shrink-0 rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-primary [cursor:pointer]"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
