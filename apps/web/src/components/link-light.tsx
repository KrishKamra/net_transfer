import { cn } from '../lib/cn'

export type LinkState = 'checking' | 'ready' | 'down'

const COPY: Record<LinkState, string> = {
  checking: 'Checking the control plane',
  ready: 'Sandbox reachable',
  down: 'Control plane unreachable',
}

export function LinkLight({ state }: { state: LinkState }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[12px] text-muted" title={COPY[state]}>
      <span className={cn('nt-led', `is-${state}`)} aria-hidden="true" />
      <span className="sr-only">{COPY[state]}. </span>
      TCP 2121
    </span>
  )
}
