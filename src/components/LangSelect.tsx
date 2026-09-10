/**
 * 语言选择器（LangSelect）：国旗 SVG + 中文名，Popover 自绘列表——原生 select
 * 的 option 无法嵌图片，且 Windows 无国旗 emoji 字体（🇨🇳 会被渲染成字母对
 * "CN"）。国旗+名称 Popover 列表为通用范式（AGPL 仓库
 * 仅只读参考，未复制代码）。
 * 国旗资源 = Hatscripts/circle-flags（MIT），20 面 SVG 共 ~13KB 随包分发（离线
 * 可用；cherry 官方走 CDN 字体 polyfill 需联网，桌面应用不取）。自动档图标用
 * lucide Globe（SVG 图标，Windows 正常渲染）。
 */
import { useState } from "react";
import { Check, ChevronDown, Globe2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onedict/ui/components/popover";
import { cn } from "../lib/utils";
import { TARGET_LANGS } from "../lib/translate";
import fZhCn from "../assets/flags/cn.svg";
import fZhTw from "../assets/flags/hk.svg";
import fEn from "../assets/flags/us.svg";
import fJa from "../assets/flags/jp.svg";
import fKo from "../assets/flags/kr.svg";
import fFr from "../assets/flags/fr.svg";
import fDe from "../assets/flags/de.svg";
import fIt from "../assets/flags/it.svg";
import fEs from "../assets/flags/es.svg";
import fPt from "../assets/flags/pt.svg";
import fRu from "../assets/flags/ru.svg";
import fPl from "../assets/flags/pl.svg";
import fAr from "../assets/flags/sa.svg";
import fTr from "../assets/flags/tr.svg";
import fTh from "../assets/flags/th.svg";
import fVi from "../assets/flags/vn.svg";
import fId from "../assets/flags/id.svg";
import fUr from "../assets/flags/pk.svg";
import fMs from "../assets/flags/my.svg";
import fUk from "../assets/flags/ua.svg";

/** 语言 code → 国旗 SVG URL（zh-tw 沿用 cherry 的 🇭🇰 映射） */
const FLAGS: Record<string, string> = {
  "zh-cn": fZhCn,
  "zh-tw": fZhTw,
  "en-us": fEn,
  "ja-jp": fJa,
  "ko-kr": fKo,
  "fr-fr": fFr,
  "de-de": fDe,
  "it-it": fIt,
  "es-es": fEs,
  "pt-pt": fPt,
  "ru-ru": fRu,
  "pl-pl": fPl,
  "ar-sa": fAr,
  "tr-tr": fTr,
  "th-th": fTh,
  "vi-vn": fVi,
  "id-id": fId,
  "ur-pk": fUr,
  "ms-my": fMs,
  "uk-ua": fUk,
};

/** 单面国旗（自动档 = Globe 图标）；独立导出供非选择器场景（历史徽标等）复用 */
export function LangFlag({ code, className }: { code: string; className?: string }) {
  const src = FLAGS[code];
  if (!src) {
    return <Globe2 className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      className={cn("size-4 shrink-0 rounded-full object-cover", className)}
    />
  );
}

type Props = {
  /** 选中语言 code；auto 档传 "" */
  value: string;
  onChange: (code: string) => void;
  /** 非空 = 含「自动」首档（value ""），文案即此（如「自动」「自动检测」） */
  auto?: string;
  disabled?: boolean;
  /** 触发按钮悬浮提示 */
  title?: string;
  /** 触发按钮外观类（组件只给结构，外观随调用点风格） */
  className?: string;
};

/** 语言选择器：value 语义与原 select 完全一致（auto 档 = ""），可直接替换。
 *  受控 open——Radix 非受控 Popover 选中项后不自动收起（OCR 浮层
 *  实测「选完关不掉」），选中即关是下拉标准行为 */
export default function LangSelect({
  value,
  onChange,
  auto,
  disabled,
  title,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const selected = value ? TARGET_LANGS.find((l) => l.code === value) : null;
  const label = selected ? selected.label : (auto ?? TARGET_LANGS[0].label);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={title}
          aria-haspopup="listbox"
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-1.5 outline-none disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
        >
          <LangFlag code={value} />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-1">
        <div role="listbox" className="max-h-64 overflow-y-auto">
          {auto !== undefined && (
            <button
              type="button"
              role="option"
              aria-selected={value === ""}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                value === ""
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Globe2 className="size-4 shrink-0" />
              <span className="flex-1 truncate">{auto}</span>
              {value === "" && <Check className="size-3.5 shrink-0 text-primary" />}
            </button>
          )}
          {TARGET_LANGS.map((lang) => {
            const active = lang.code === value;
            return (
              <button
                key={lang.code}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(lang.code);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <img
                  src={FLAGS[lang.code]}
                  alt=""
                  aria-hidden
                  className="size-4 shrink-0 rounded-full object-cover"
                />
                <span className="flex-1 truncate">{lang.label}</span>
                {active && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
