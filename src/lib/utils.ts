/** cn 工具（clsx + tailwind-merge），与 packages/ui 内部实现同形，供应用侧组件使用 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
