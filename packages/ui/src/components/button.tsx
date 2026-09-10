import { cn } from '../lib/utils'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader } from 'lucide-react'
import * as React from 'react'

const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-normal text-[13px] shadow-xs transition-all outline-none',
    'disabled:pointer-events-none disabled:opacity-40',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    'data-[busy=true]:cursor-progress data-[busy=true]:opacity-40'
  ),
  {
    variants: {
      variant: {
        default: 'bg-neutral-900 text-white hover:bg-neutral-800 focus-visible:bg-neutral-800',
        destructive:
          'bg-destructive text-white hover:bg-destructive-hover focus-visible:bg-destructive-hover',
        outline:
          'border border-border bg-transparent shadow-none hover:bg-accent focus-visible:border-primary focus-visible:bg-accent',
        secondary:
          'rounded-lg bg-secondary text-secondary-foreground shadow-none hover:bg-secondary-hover focus-visible:bg-secondary-hover',
        ghost: 'text-foreground shadow-none hover:bg-accent focus-visible:bg-accent'
      },
      size: {
        default: 'min-h-7.5 gap-1.5 px-2.5',
        sm: 'min-h-7 gap-1.5 px-2.5 text-xs',
        lg: 'min-h-9 px-4 text-sm',
        icon: 'size-9',
        'icon-sm': 'size-7'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  loadingIcon,
  loadingIconClassName,
  disabled,
  children,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
    loadingIcon?: React.ReactNode
    loadingIconClassName?: string
  }) {
  const Comp = asChild ? Slot : 'button'

  const spinnerSize = size === 'icon-sm' ? 13 : size === 'sm' ? 14 : size === 'lg' ? 18 : 16
  const spinnerElement =
    loadingIcon ?? <Loader className={cn('animate-spin', loadingIconClassName)} size={spinnerSize} />

  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? 'default'}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-busy={loading || undefined}
      {...props}>
      {/* asChild 时 Slot 要求单子元素，不支持 loading 前缀图标 */}
      {asChild ? children : (
        <>
          {loading && spinnerElement}
          {children}
        </>
      )}
    </Comp>
  )
}

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>

export { Button, type ButtonVariant, buttonVariants }
