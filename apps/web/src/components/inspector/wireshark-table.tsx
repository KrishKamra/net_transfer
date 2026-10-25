import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { ArrowDown, Search } from 'lucide-react'
import { eventKey, toneOf, type TelemetryEvent, type Tone } from '../../lib/telemetry'
import { hostOf, protocolOf, wiresharkInfo } from './model'

const ROW = 24
const OVERSCAN = 12

type Filter = 'all' | Tone

const FILTERS: { id: Filter; label: string; tone?: Tone }[] = [
  { id: 'all', label: 'All' },
  { id: 'tcp', label: 'TCP', tone: 'tcp' },
  { id: 'command', label: 'Commands', tone: 'command' },
  { id: 'status', label: 'Replies', tone: 'status' },
  { id: 'data', label: 'Data', tone: 'data' },
]

type Props = {
  events: TelemetryEvent[]
  selectedKey: string | null
  follow: boolean
  onFollowChange: (follow: boolean) => void
  onSelect: (event: TelemetryEvent) => void
}

export function WiresharkTable({ events, selectedKey, follow, onFollowChange, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const programmatic = useRef(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const needle = useDeferredValue(query.trim().toLowerCase())
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)

  const base = events[0]?.timestamp ?? 0
  const rows = useMemo(() => {
    return events.filter((event) => {
      if (filter !== 'all') {
        const tone = toneOf(event)
        if (filter === 'status' ? tone !== 'status' && tone !== 'error' : tone !== filter) return false
      }
      if (!needle) return true
      return (
        wiresharkInfo(event).toLowerCase().includes(needle) ||
        (event.verb ?? '').toLowerCase() === needle ||
        event.client_addr.includes(needle) ||
        event.connection_id.startsWith(needle.replace(/^#/, ''))
      )
    })
  }, [events, filter, needle])

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    const observer = new ResizeObserver(() => setHeight(node.clientHeight))
    observer.observe(node)
    setHeight(node.clientHeight)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node || !follow) return
    const bottom = node.scrollHeight - node.clientHeight
    if (Math.abs(node.scrollTop - bottom) > 1) {
      programmatic.current = true
      node.scrollTop = bottom
    }
  }, [rows, follow])

  // Keep a pinned row in view when the filter changes.
  useEffect(() => {
    if (follow || !selectedKey) return
    const index = rows.findIndex((event) => eventKey(event) === selectedKey)
    const node = scroller.current
    if (index === -1 || !node) return
    const top = index * ROW
    if (top < node.scrollTop || top > node.scrollTop + node.clientHeight - ROW * 2) {
      node.scrollTop = Math.max(0, top - node.clientHeight / 2)
    }
    // Only when the row set changes shape, not on every selection.
  }, [filter, needle])

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget
    setScrollTop(node.scrollTop)
    if (programmatic.current) {
      programmatic.current = false
      return
    }
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < ROW
    if (atBottom !== follow) onFollowChange(atBottom)
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN)
  const slice = rows.slice(first, last)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 sm:px-5">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Display filter</span>
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Display filter · stor, 226, #conn, 54012"
            className="nt-field nt-field-icon h-7 text-[12px]"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Frame family">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="nt-chip"
              data-tone={item.tone}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.tone ? <span className="nt-swatch" /> : null}
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto bg-surface">
        <table className="w-full min-w-[780px] table-fixed border-collapse text-left font-mono text-[11.5px]">
          <caption className="sr-only">Captured frames in Wireshark column order</caption>
          <colgroup>
            <col className="w-[64px]" />
            <col className="w-[96px]" />
            <col className="w-[112px]" />
            <col className="w-[112px]" />
            <col className="w-[84px]" />
            <col className="w-[72px]" />
            <col />
          </colgroup>
          <thead className="nt-ws-head sticky top-0 z-10">
            <tr className="text-[11px] text-muted">
              <th scope="col" className="px-3 py-1.5 font-medium">No.</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Time</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Source</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Destination</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Protocol</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium" title="tcp.len: payload bytes. Wireshark's Length column adds 40 to 66 header bytes.">
                Length
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">Info</th>
            </tr>
          </thead>
          <tbody>
            {first > 0 ? (
              <tr aria-hidden="true" style={{ height: first * ROW }}>
                <td colSpan={7} />
              </tr>
            ) : null}
            {slice.map((event) => {
              const key = eventKey(event)
              const outbound = event.direction === 'CLIENT_TO_SERVER'
              return (
                <tr
                  key={key}
                  className="nt-ws-row"
                  style={{ height: ROW }}
                  data-tone={toneOf(event)}
                  data-selected={key === selectedKey}
                  aria-selected={key === selectedKey}
                  onClick={() => onSelect(event)}
                  title={event.description}
                >
                  <td className="nt-ws-dim px-3 tabular-nums">{event.seq}</td>
                  <td className="px-2 tabular-nums">{((event.timestamp - base) / 1000).toFixed(6)}</td>
                  <td className="truncate px-2">{hostOf(outbound ? event.client_addr : event.server_addr)}</td>
                  <td className="truncate px-2">{hostOf(outbound ? event.server_addr : event.client_addr)}</td>
                  <td className="px-2">{protocolOf(event)}</td>
                  <td className="px-2 text-right tabular-nums">{event.frame_bytes}</td>
                  <td className="truncate px-3">{wiresharkInfo(event)}</td>
                </tr>
              )
            })}
            {last < rows.length ? (
              <tr aria-hidden="true" style={{ height: (rows.length - last) * ROW }}>
                <td colSpan={7} />
              </tr>
            ) : null}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="py-10 text-center font-sans text-[13px] text-muted">
            {events.length === 0 ? 'No frames captured yet.' : 'No frames match this filter.'}
          </p>
        ) : null}
      </div>

      <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-line px-4 font-mono text-[10.5px] text-muted sm:px-5">
        <span>
          Displayed {rows.length.toLocaleString()} of {events.length.toLocaleString()}
        </span>
        <span className="hidden truncate md:inline">Wireshark: tcp.port == 2121 · Length here is tcp.len</span>
      </footer>

      {!follow ? (
        <button
          type="button"
          onClick={() => onFollowChange(true)}
          className="nt-jump nt-rise absolute bottom-12 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-2 rounded-full bg-surface px-3.5 font-sans text-[12px] font-medium"
        >
          <ArrowDown className="size-3.5 text-signal" aria-hidden="true" />
          Jump to live
        </button>
      ) : null}
    </div>
  )
}
