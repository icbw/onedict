import * as React from 'react'

export type PortalContainer = HTMLElement | null

const OverlayPortalContext = React.createContext<PortalContainer>(null)
const DialogPortalContext = React.createContext<PortalContainer>(null)

/**
 * 弹层（tooltip / popover / dropdown）portal 进最近的容器（通常是 Dialog 内容），
 * 使 Radix 焦点陷阱与关闭层把嵌套弹层视为同一交互边界。
 */
export function PortalContainerProvider({
  container,
  children
}: {
  container: PortalContainer
  children: React.ReactNode
}) {
  return <OverlayPortalContext value={container}>{children}</OverlayPortalContext>
}

export function usePortalContainer(): PortalContainer {
  return React.use(OverlayPortalContext)
}

/**
 * Dialog 用页面级 portal 目标，保持挂在所属页面节点上，
 * 不继承父级 Dialog 内容的变换节点。
 */
export function DialogPortalContainerProvider({
  container,
  children
}: {
  container: PortalContainer
  children: React.ReactNode
}) {
  return <DialogPortalContext value={container}>{children}</DialogPortalContext>
}

export function useDialogPortalContainer(): PortalContainer {
  return React.use(DialogPortalContext)
}
