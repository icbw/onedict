/**
 * 动作图标渲染（cherry 编辑对话框「图标」字段的运行时配合）：
 * 偏好 icon（lucide 图标名）存在且有效时经 lucide-react/dynamic 动态渲染——
 * 自定义动作与内置动作（图标覆盖）同规则；无效/缺省回退内置目录图标
 * （自定义动作 fallback = Sparkles）。
 */
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import type { ResolvedAction } from "../lib/actions";

/** lucide 图标名有效性（对话框输入校验用；iconNames 含全部可用名） */
export function isValidIconName(name: string): boolean {
  return (iconNames as string[]).includes(name);
}

export function ActionIcon({
  action,
  className,
}: {
  action: ResolvedAction;
  className?: string;
}) {
  if (action.icon && isValidIconName(action.icon)) {
    const Fallback = action.Icon;
    return (
      <DynamicIcon
        name={action.icon as IconName}
        className={className}
        fallback={() => <Fallback className={className} />}
      />
    );
  }
  const Icon = action.Icon;
  return <Icon className={className} />;
}

export type { IconName };
