import { cn } from '../lib/utils'
import * as React from 'react'

/**
 * 原生受控 textarea，样式与 Input 同族（应用侧用于翻译源文与提示词编辑）。
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-input field-sizing-content flex min-h-16 w-full resize-y rounded-md border bg-transparent px-4 py-3 text-lg transition-[color,box-shadow] outline-none md:text-sm',
        'placeholder:text-muted-foreground',
        'focus-visible:border-primary',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
