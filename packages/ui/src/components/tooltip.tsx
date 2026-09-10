import { cn } from '../lib/utils'
import {
  Arrow as RadixArrow,
  Content as RadixContent,
  Portal as RadixPortal,
  Provider as RadixProvider,
  Root as RadixRoot,
  Trigger as RadixTrigger
} from '@radix-ui/react-tooltip'
import * as React from 'react'

import { usePortalContainer } from './portal'

type Side = 'top' | 'bottom' | 'left' | 'right'
type Align = 'start' | 'center' | 'end'

function parsePlacement(placement?: string): { side: Side; align: Align } {
  const mapping: Record<string, { side: Side; align: Align }> = {
    top: { side: 'top', align: 'center' },
    'top-start': { side: 'top', align: 'start' },
    'top-end': { side: 'top', align: 'end' },
    bottom: { side: 'bottom', align: 'center' },
    'bottom-start': { side: 'bottom', align: 'start' },
    'bottom-end': { side: 'bottom', align: 'end' },
    bottomRight: { side: 'bottom', align: 'end' },
    left: { side: 'left', align: 'center' },
    'left-start': { side: 'left', align: 'start' },
    'left-end': { side: 'left', align: 'end' },
    right: { side: 'right', align: 'center' },
    'right-start': { side: 'right', align: 'start' },
    'right-end': { side: 'right', align: 'end' }
  }
  return mapping[placement ?? 'top'] ?? { side: 'top', align: 'center' }
}

// 白底轻边主题内建（亮色单主题），不再依赖全局样式覆写。
const contentStyles =
  'z-[80] w-fit max-w-80 origin-(--radix-tooltip-content-transform-origin) rounded-md border border-border bg-popover px-3 py-1.5 text-popover-foreground text-xs leading-relaxed whitespace-normal break-words shadow-[0_3px_10px_rgb(0_0_0/0.08)] animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95'

const arrowStyles =
  'z-[80] -translate-y-px fill-popover stroke-border stroke-2 [paint-order:stroke_fill]'

export interface TooltipProps {
  children?: React.ReactNode
  content?: React.ReactNode
  title?: React.ReactNode
  placement?: string
  delay?: number
  sideOffset?: number
  showArrow?: boolean
  className?: string
  classNames?: {
    content?: string
    placeholder?: string
  }
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
  portalContainer?: React.ComponentProps<typeof RadixPortal>['container']
}

/**
 * 复合 Tooltip：包一层 inline-block 触发容器，`content`/`title` 提供提示内容，
 * `placement` 采用 top / bottom-start / bottomRight 等方位命名（Radix side+align 映射）。
 */
export const Tooltip = ({
  children,
  content,
  title,
  placement,
  delay = 0,
  sideOffset = 0,
  showArrow = true,
  className,
  classNames,
  isOpen,
  onOpenChange,
  portalContainer
}: TooltipProps) => {
  const tooltipContent = content ?? title
  const defaultPortalContainer = usePortalContainer()

  if (!tooltipContent) {
    return <div className={cn('relative z-10 inline-block', classNames?.placeholder)}>{children}</div>
  }

  const { side, align } = parsePlacement(placement)

  const controlledProps: Partial<React.ComponentProps<typeof RadixRoot>> = {}
  if (isOpen != null) {
    controlledProps.open = isOpen
    controlledProps.onOpenChange = onOpenChange
  } else if (onOpenChange) {
    controlledProps.onOpenChange = onOpenChange
  }

  return (
    <RadixProvider delayDuration={delay}>
      <RadixRoot delayDuration={delay} {...controlledProps}>
        <RadixTrigger asChild>
          <div className={cn('relative z-10 inline-block', className, classNames?.placeholder)}>{children}</div>
        </RadixTrigger>
        <RadixPortal container={portalContainer ?? defaultPortalContainer ?? undefined}>
          <RadixContent
            data-slot="tooltip-content"
            side={side}
            align={align}
            sideOffset={sideOffset}
            className={cn(contentStyles, classNames?.content)}>
            {tooltipContent}
            {showArrow && <RadixArrow width={12} height={6} className={arrowStyles} />}
          </RadixContent>
        </RadixPortal>
      </RadixRoot>
    </RadixProvider>
  )
}
