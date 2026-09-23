import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
}

const STYLES: Record<Variant, string> = {
  primary: 'nt-submit bg-ink text-surface hover:bg-ink/85',
  secondary: 'nt-line border border-line-strong bg-surface text-ink hover:bg-canvas',
  ghost: 'nt-quiet text-ink',
  danger: 'text-oxide hover:bg-oxide-soft',
}

export function Button({ variant = 'secondary', className, type = 'button', ...props }: Props) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-[background-color,color,border-color] duration-150 hover:duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        STYLES[variant],
        className,
      )}
      {...props}
    />
  )
}
