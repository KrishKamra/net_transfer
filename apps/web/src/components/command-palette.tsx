import { useEffect, useId, useMemo, useRef, useState } from 'react'

export type Command = {
  id: string
  label: string
  hint: string
  run: () => void
}

type Props = {
  open: boolean
  onClose: () => void
  commands: Command[]
}

export function CommandPalette({ open, onClose, commands }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return commands
    return commands.filter((command) => command.label.toLowerCase().includes(needle))
  }, [commands, query])

  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) {
      setQuery('')
      setIndex(0)
      node.showModal()
      inputRef.current?.focus()
    } else if (!open && node.open) {
      node.close()
    }
  }, [open])

  useEffect(() => {
    setIndex(0)
  }, [query])

  function choose(next: number) {
    const command = visible[next]
    if (!command) return
    command.run()
    onClose()
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="nt-dialog"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <p id={titleId} className="sr-only">
        Commands
      </p>
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Type a command"
        className="nt-command h-12 w-full border-b border-line bg-transparent px-4 font-mono text-[13px]"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setIndex((current) => Math.min(visible.length - 1, current + 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setIndex((current) => Math.max(0, current - 1))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            choose(index)
          }
        }}
      />
      <ul className="max-h-72 overflow-auto py-1" role="listbox">
        {visible.length === 0 ? (
          <li className="px-4 py-3 text-[13px] text-muted">No matching command.</li>
        ) : (
          visible.map((command, itemIndex) => (
            <li key={command.id} role="option" aria-selected={itemIndex === index}>
              <button
                type="button"
                className="nt-option flex w-full items-baseline justify-between gap-4 px-4 py-2.5 text-left"
                data-active={itemIndex === index ? 'true' : 'false'}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => choose(itemIndex)}
              >
                <span className="text-[13px]">{command.label}</span>
                <span className="font-mono text-[11px] text-muted">{command.hint}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </dialog>
  )
}
