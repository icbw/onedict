/**
 * 划词栏 pill 渲染（ToolbarApp 与设置页「划词助手」实时预览共用）。
 * logo 段 + 动作按钮列（icon+label，hover bg-accent + primary 变色）。
 * 从 ToolbarApp 提取（收尾预览需求：浮标单击外部即消失，设置页需要
 * 所见即所得的实时预览）。
 * 预览场景由调用方 className 附加 invisible/pointer-events-none 禁交互。
 * label 单行约束（whitespace-nowrap + max-w 截断）照旧——防止文字换行竖排。
 */
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { ActionIcon } from "./ActionIcon";
import type { ResolvedAction } from "../lib/actions";

/** pill 基础样式（border 色变量随根定义，子树继承） */
const BASE =
  "box-border inline-flex h-9 select-none flex-row items-stretch rounded-[10px] border-0 p-0 [--selection-toolbar-border:rgb(0_0_0_/_0.08)]";

export default function ToolbarPill({
  actions,
  compact,
  copiedId = null,
  onAction,
  className,
  ref,
}: {
  actions: ResolvedAction[];
  compact: boolean;
  /** 复制成功态（动作 icon → Check，label → 已复制） */
  copiedId?: string | null;
  onAction?: (a: ResolvedAction) => void;
  /** 调用方附加样式（真身：margin/阴影/裁剪；影子量尺层：offscreen 隐身） */
  className?: string;
  /** React 19：ref 作为普通 prop（影子量尺层测量用） */
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} className={cn(BASE, className)}>
      <div className="flex items-center justify-center rounded-l-[10px] border-[var(--selection-toolbar-border)] border-solid bg-transparent [border-width:0.5px_0_0.5px_0.5px] [padding:0_6px_0_8px]">
        <span className="flex size-[22px] items-center justify-center rounded-full bg-primary text-white">
          <BookMarkedIcon />
        </span>
      </div>
      <div className="flex flex-row items-stretch justify-center rounded-[0_10px_10px_0] border-[var(--selection-toolbar-border)] border-solid bg-transparent [border-width:0.5px_0.5px_0.5px_0]">
        {actions.map((a) => {
          const copied = copiedId === a.id;
          return (
            <button
              key={a.id}
              type="button"
              title={a.label}
              aria-label={a.label}
              onClick={onAction ? () => onAction(a) : undefined}
              className="group m-0 flex h-full cursor-pointer flex-row items-center justify-center gap-1.5 rounded-none border-0 bg-transparent px-3 py-0 shadow-none transition-colors duration-100 last:rounded-r-[10px] last:pr-3 hover:bg-accent"
            >
              {copied ? (
                <Check className="size-4 text-primary" />
              ) : (
                <ActionIcon
                  action={a}
                  className="size-4 text-card-foreground transition-colors duration-100 group-hover:text-primary"
                />
              )}
              {/* label 单行约束（pickdict btn-title 同款）：防止容器宽度不足时文字换行
                  竖排——换行会让量尺反馈锁死在错误布局（竖排 bug 根因） */}
              {!compact && (
                <span className="max-w-[160px] overflow-hidden bg-transparent text-card-foreground text-sm leading-[1.1] text-ellipsis whitespace-nowrap transition-colors duration-100 group-hover:text-primary">
                  {copied ? "已复制" : a.label}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BookMarkedIcon() {
  // 与主窗口品牌章同款（onedict 自有标识）
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3.5"
    >
      <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}
