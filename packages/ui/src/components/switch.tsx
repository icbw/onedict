import { cn } from '../lib/utils'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cva } from 'class-variance-authority'
import * as React from 'react'

const switchRootVariants = cva(
  [
    'group peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full shadow-xs outline-none transition-all',
    'data-[state=unchecked]:bg-gray-500/20 data-[state=checked]:bg-primary',
    'disabled:cursor-not-allowed disabled:opacity-40',
    'focus-visible:[box-shadow:inset_0_0_0_1px_var(--ring)]'
  ],
  {
    variants: {
      size: {
        xs: 'h-4.5 w-8',
        sm: 'h-5 w-9',
        md: 'h-5.5 w-11',
        lg: 'h-6 w-11'
      }
    },
    defaultVariants: {
      size: 'md'
    }
  }
)

const switchThumbVariants = cva(
  [
    'pointer-events-none block rounded-full bg-white shadow-sm transition-all',
    'data-[state=unchecked]:translate-x-0'
  ],
  {
    variants: {
      size: {
        xs: 'ml-[1px] size-4 data-[state=checked]:translate-x-3.5',
        sm: 'ml-[1px] size-4.5 data-[state=checked]:translate-x-4',
        md: 'ml-0.5 size-[19px] data-[state=checked]:translate-x-[21px]',
        lg: 'ml-[3px] size-5 data-[state=checked]:translate-x-4.5'
      }
    },
    defaultVariants: {
      size: 'md'
    }
  }
)

interface SwitchProps extends React.ComponentProps<typeof SwitchPrimitive.Root> {
  size?: 'xs' | 'sm' | 'md' | 'lg'
}

function Switch({ size = 'md', className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(switchRootVariants({ size }), className)}
      {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={switchThumbVariants({ size })} />
    </SwitchPrimitive.Root>
  )
}

export { Switch, type SwitchProps }
