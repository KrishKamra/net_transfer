import type { ReactNode } from 'react'

export function PaneHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-line px-4 sm:px-5">
      <h2 className="nt-pane-title">{title}</h2>
      {children}
    </header>
  )
}
