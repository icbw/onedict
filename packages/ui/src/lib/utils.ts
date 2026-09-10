/**
 * cn：条件类名合并 + Tailwind 冲突消解（clsx + tailwind-merge 通用惯用法）。
 */
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
