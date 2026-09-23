import { cn } from '../lib/cn'

type Props = {
  size?: number
  className?: string
  title?: string
}

export function Logo({ size = 28, className, title }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={cn('nt-logo shrink-0', className)}
    >
      <rect width="32" height="32" rx="8" fill="#12141a" />
      <path className="nt-filament" d="M5.5 16H12" stroke="#7eebf2" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="13.2" y="11.5" width="5.6" height="9" rx="1.4" fill="#7eebf2" />
      <path
        className="nt-filament nt-filament-late"
        d="M20 16H26.5"
        stroke="#7eebf2"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}
