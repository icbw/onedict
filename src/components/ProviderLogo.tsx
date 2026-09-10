/**
 * 供应商品牌图标（模型卡）：@lobehub/icons（MIT，AI 品牌 logo 社区标准库，
 * 官方品牌标识版权属各供应商）按需深路径 import（tree-shaking，barrel 不进模块图）。
 * OpenCode Go 等无品牌图标的供应商回退通用图标。
 * Avatar 形态自带品牌色圆角底。
 */
import type { ComponentType } from "react";
import { Boxes } from "lucide-react";
import OpenAI from "@lobehub/icons/es/OpenAI";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Doubao from "@lobehub/icons/es/Doubao";
import Bailian from "@lobehub/icons/es/Bailian";
import { cn } from "../lib/utils";

/** 品牌头像组件（各品牌 CompoundedIcon 类型互不兼容，取 Avatar 结构签名） */
type AvatarComponent = ComponentType<{ size?: number; className?: string }>;

const BRAND_AVATARS: Record<string, AvatarComponent> = {
  openai: OpenAI.Avatar as AvatarComponent,
  deepseek: DeepSeek.Avatar as AvatarComponent,
  doubao: Doubao.Avatar as AvatarComponent,
  dashscope: Bailian.Avatar as AvatarComponent,
};

export function ProviderLogo({
  providerId,
  size = 22,
  className,
}: {
  providerId: string;
  size?: number;
  className?: string;
}) {
  const Avatar = BRAND_AVATARS[providerId];
  if (Avatar) {
    return <Avatar size={size} className={className} />;
  }
  // 无品牌图标（opencode/custom 等）：中性圆角块 + 通用图标
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Boxes style={{ width: size * 0.6, height: size * 0.6 }} />
    </span>
  );
}
