import { cn } from '../lib/cn'

export function SignalLoader({ className }: { className?: string }) {
  return (
    <span className={cn('nt-bars', className)} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}
