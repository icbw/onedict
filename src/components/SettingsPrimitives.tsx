// from pickdict (MIT), adapted for Tauri —— src/renderer/components/SettingsPrimitives.tsx
// 适配：① SettingDivider 改 @onedict/ui 深路径引入（barrel 会把重栈带进模块图）；
// ② theme/data-theme-mode 参数删除（本应用为亮色单主题，无 useTheme）；
// ③ 仅携带实际使用的子集，SettingGroup 固定 card 形态；④ cn 改本地实现。
import { Divider as SettingDivider } from "@onedict/ui/components/divider";
import type * as React from "react";

import { cn } from "../lib/utils";

export { SettingDivider };

export const SettingTitle = ({ className, ...props }: React.ComponentPropsWithoutRef<"div">) => (
  <div
    className={cn("flex items-center justify-between font-semibold text-[15px] select-none", className)}
    {...props}
  />
);

export const SettingDescription = ({ className, ...props }: React.ComponentPropsWithoutRef<"div">) => (
  <div className={cn("mt-2.5 text-muted-foreground text-xs", className)} {...props} />
);

export const SettingRow = ({ className, ...props }: React.ComponentPropsWithoutRef<"div">) => (
  <div
    className={cn("flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-2", className)}
    {...props}
  />
);

export const SettingRowTitle = ({ className, ...props }: React.ComponentPropsWithoutRef<"div">) => (
  <div
    className={cn("flex min-w-0 flex-wrap items-center text-foreground text-sm leading-4.5", className)}
    {...props}
  />
);

export const SettingGroup = ({ className, ...props }: React.ComponentPropsWithoutRef<"div">) => (
  <div
    className={cn("mt-4 rounded-xl border border-border bg-card p-4 first:mt-0", className)}
    {...props}
  />
);

export const SettingsContentColumn = ({
  className,
  innerClassName,
  children,
  ...rest
}: React.ComponentPropsWithoutRef<"div"> & { innerClassName?: string }) => (
  <div
    className={cn(
      "flex min-h-0 flex-1 flex-col overflow-y-auto p-6 [&::-webkit-scrollbar]:hidden",
      className,
    )}
    {...rest}
  >
    <div className={cn("mx-auto w-full max-w-3xl", innerClassName)}>{children}</div>
  </div>
);
