import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type UIEvent } from 'react'
import { ArrowDown, ChevronRight, Laptop, Server } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatBytes } from '../../lib/format'
import { eventKey, frameLabel, type TelemetryEvent } from '../../lib/telemetry'
import { shortId, type FrameRung, type Rung, type StreamRung } from './model'

const MAX_RUNGS = 500
const EXPANDED_CHUNKS = 64
const LANE_LEFT = 14
const LANE_RIGHT = 86

type Props = {
  rungs: Rung[]
  selectedKey: string | null
  clientAddr: string | null
  serverAddr: string | null
  follow: boolean
  onFollowChange: (follow: boolean) => void
  onSelect: (event: TelemetryEvent) => void
}

export function SequenceLadder({
  rungs,
  selectedKey,
  clientAddr,
  serverAddr,
  follow,
  onFollowChange,
  onSelect,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const programmatic = useRef(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [unseen, setUnseen] = useState(0)

  // Rungs newer than the previous commit animate. The first paint is backlog.
  const lastEvent = lastEventOf(rungs)
  const maxSeq = lastEvent?.seq ?? 0
  const floor = useRef<number | null>(null)
  const freshFloor = floor.current ?? maxSeq
  useEffect(() => {
    floor.current = maxSeq
  }, [maxSeq])

  const hidden = Math.max(0, rungs.length - MAX_RUNGS)
  const visible = hidden ? rungs.slice(hidden) : rungs

  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (!follow) return
    const bottom = node.scrollHeight - node.clientHeight
    if (Math.abs(node.scrollTop - bottom) > 1) {
      // Only flag scrolls that will actually fire an event.
      programmatic.current = true
      node.scrollTop = bottom
    }
    setUnseen(0)
  }, [rungs, follow, expanded])

  const previousLength = useRef(rungs.length)
  useEffect(() => {
    const grew = rungs.length - previousLength.current
    previousLength.current = rungs.length
    if (!follow && grew > 0) setUnseen((value) => value + grew)
  }, [rungs.length, follow])

  function onScroll(event: UIEvent<HTMLDivElement>) {
    if (programmatic.current) {
      programmatic.current = false
      return
    }
    const node = event.currentTarget
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 32
    if (atBottom !== follow) onFollowChange(atBottom)
  }

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  let previousAt: number | null = hidden ? lastOf(rungs[hidden - 1]).timestamp : null
  let previousConn: string | null = null

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="nt-ladder relative min-h-0 flex-1 overflow-auto"
        role="listbox"
        aria-label="Packet sequence"
      >
        <LadderHead clientAddr={clientAddr} serverAddr={serverAddr} />

        <div className="relative">
          <span className="nt-lane-line" style={{ left: `calc(var(--gutter) + (100% - var(--gutter)) * ${LANE_LEFT / 100})` }} />
          <span className="nt-lane-line" style={{ left: `calc(var(--gutter) + (100% - var(--gutter)) * ${LANE_RIGHT / 100})` }} />

          {hidden ? (
            <p className="relative py-3 text-center font-mono text-[11px] text-muted">
              {hidden.toLocaleString()} earlier rows not drawn · Wireshark view lists every frame
            </p>
          ) : null}

          {visible.map((rung) => {
            const first = eventOf(rung)
            // Handshake and teardown share one timestamp; only their first rung shows Δt.
            const continuation = rung.kind === 'frame' && isContinuation(rung)
            const delta = previousAt === null || continuation ? null : first.timestamp - previousAt
            const connChanged = first.connection_id !== previousConn
            previousAt = lastOf(rung).timestamp
            previousConn = first.connection_id

            if (rung.kind === 'stream') {
              const open = expanded.has(rung.key)
              const selected = rung.events.some((event) => eventKey(event) === selectedKey)
              return (
                <div key={rung.key}>
                  <StreamRow
                    rung={rung}
                    delta={delta}
                    tag={connChanged ? shortId(rung.connectionId) : null}
                    selected={selected && !open}
                    fresh={lastOf(rung).seq > freshFloor}
                    open={open}
                    onToggle={() => toggle(rung.key)}
                    onSelect={() => onSelect(lastOf(rung))}
                  />
                  {open ? (
                    <ChunkRows
                      rung={rung}
                      selectedKey={selectedKey}
                      freshFloor={freshFloor}
                      onSelect={onSelect}
                    />
                  ) : null}
                </div>
              )
            }

            return (
              <FrameRow
                key={rung.key}
                rung={rung}
                delta={delta}
                tag={connChanged ? shortId(rung.event.connection_id) : null}
                selected={eventKey(rung.event) === selectedKey && !isContinuation(rung)}
                fresh={rung.event.seq > freshFloor}
                onSelect={() => onSelect(rung.event)}
              />
            )
          })}
          <div className="h-6" aria-hidden="true" />
        </div>
      </div>

      {!follow ? (
        <button
          type="button"
          onClick={() => onFollowChange(true)}
          className="nt-jump nt-rise absolute bottom-4 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-2 rounded-full bg-surface px-3.5 text-[12px] font-medium"
        >
          <ArrowDown className="size-3.5 text-signal" aria-hidden="true" />
          {unseen > 0 ? `${unseen.toLocaleString()} new · Jump to live` : 'Jump to live'}
        </button>
      ) : null}
    </div>
  )
}

function LadderHead({ clientAddr, serverAddr }: { clientAddr: string | null; serverAddr: string | null }) {
  return (
    <div className="nt-ladder-head sticky top-0 z-20 grid h-14 grid-cols-[var(--gutter)_minmax(0,1fr)] border-b border-line">
      <span className="self-center pl-4 font-mono text-[10.5px] tracking-[0.08em] text-muted uppercase">Δt</span>
      <div className="relative">
        <Node
          side="left"
          icon={<Laptop className="size-3.5" aria-hidden="true" />}
          role="Client"
          address={clientAddr ?? 'waiting for connect'}
        />
        <Node
          side="right"
          icon={<Server className="size-3.5" aria-hidden="true" />}
          role="Server"
          address={serverAddr ?? ':2121'}
        />
      </div>
    </div>
  )
}

function Node({
  side,
  icon,
  role,
  address,
}: {
  side: 'left' | 'right'
  icon: ReactNode
  role: string
  address: string
}) {
  const at = side === 'left' ? LANE_LEFT : LANE_RIGHT
  return (
    <div
      className="absolute top-1/2 flex max-w-[44%] -translate-y-1/2"
      style={side === 'left' ? { left: `max(8px, calc(${at}% - 16px))` } : { right: `max(8px, calc(${100 - at}% - 16px))` }}
    >
      <div className={cn('nt-node', side === 'right' && 'flex-row-reverse pr-[5px] pl-2.5')}>
        <span className="nt-node-mark">{icon}</span>
        <span className={cn('min-w-0 leading-tight', side === 'right' && 'text-right')}>
          <span className="block text-[11.5px] font-medium">{role}</span>
          <span className="nt-node-addr block truncate font-mono text-[10.5px] text-muted">{address}</span>
        </span>
      </div>
    </div>
  )
}

function Gutter({ delta, tag }: { delta: number | null; tag: string | null }) {
  return (
    <div className="flex flex-col items-start justify-center pl-4 leading-none">
      <span className="font-mono text-[10.5px] whitespace-nowrap text-muted tabular-nums">{delta === null ? '·' : formatDelta(delta)}</span>
      {tag ? <span className="nt-conn-tag mt-1">#{tag}</span> : null}
    </div>
  )
}

function Wire({ heading, synthetic }: { heading: 'right' | 'left'; synthetic?: boolean }) {
  return (
    <>
      <span
        className="nt-wire"
        data-dir={heading}
        data-synthetic={synthetic ? 'true' : undefined}
        style={{ left: `${LANE_LEFT}%`, right: `${100 - LANE_RIGHT}%` }}
      />
      <span className="absolute inset-y-0" style={{ left: `${LANE_LEFT}%`, right: `${100 - LANE_RIGHT}%` }}>
        <span className="nt-spark" data-dir={heading} />
      </span>
    </>
  )
}

function rungKeys(onSelect: () => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }
}

function FrameRow({
  rung,
  delta,
  tag,
  selected,
  fresh,
  onSelect,
}: {
  rung: FrameRung
  delta: number | null
  tag: string | null
  selected: boolean
  fresh: boolean
  onSelect: () => void
}) {
  return (
    <div
      className="nt-rung grid h-9 grid-cols-[var(--gutter)_minmax(0,1fr)]"
      data-tone={rung.tone}
      data-selected={selected}
      data-fresh={fresh}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={rungKeys(onSelect)}
      title={rung.event.description}
    >
      <Gutter delta={delta} tag={tag} />
      <div className="relative">
        <Wire heading={rung.heading} synthetic={rung.synthetic} />
        <div className="absolute inset-y-0 flex items-center justify-center" style={{ left: `${LANE_LEFT + 5}%`, right: `${100 - LANE_RIGHT + 5}%` }}>
          <span className="nt-pkt" data-tone={rung.tone}>
            <span className="nt-pkt-verb">{rung.verb}</span>
            {rung.text ? <span className="opacity-80">{rung.text}</span> : null}
          </span>
        </div>
      </div>
    </div>
  )
}

function StreamRow({
  rung,
  delta,
  tag,
  selected,
  fresh,
  open,
  onToggle,
  onSelect,
}: {
  rung: StreamRung
  delta: number | null
  tag: string | null
  selected: boolean
  fresh: boolean
  open: boolean
  onToggle: () => void
  onSelect: () => void
}) {
  const latest = lastOf(rung)
  const chunk = latest.chunk
  const listing = latest.verb === 'LIST'
  const total = chunk?.total_bytes ?? 0
  const moved = chunk ? chunk.offset + chunk.chunk_bytes : 0
  const done = listing ? rung.closed || (chunk ? chunk.chunk_index >= chunk.chunk_count : true) : total > 0 && moved >= total
  const progress = listing
    ? chunk ? (chunk.chunk_index / chunk.chunk_count) * 100 : 100
    : total > 0 ? (moved / total) * 100 : 100
  const live = !done && !rung.closed
  const label = listing
    ? `LIST · ${rung.events.length} ${rung.events.length === 1 ? 'entry' : 'entries'}`
    : live || !chunk
      ? frameLabel(latest)
      : `${chunk.chunk_count.toLocaleString()} chunks · ${formatBytes(moved)} · ${chunk.rolling_mbps.toFixed(1)} MB/s`

  return (
    <div
      className="nt-rung grid h-14 grid-cols-[var(--gutter)_minmax(0,1fr)]"
      data-tone="data"
      data-selected={selected}
      data-fresh={fresh}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={rungKeys(onSelect)}
      title={latest.description}
    >
      <Gutter delta={delta} tag={tag} />
      <div className="relative">
        <span
          className="nt-stream-band"
          data-dir={rung.heading}
          data-live={live}
          style={{ left: `${LANE_LEFT}%`, right: `${100 - LANE_RIGHT}%` }}
        >
          <span className="nt-stream-fill" style={{ width: `${Math.min(100, progress)}%` }} />
        </span>
        <span className="absolute inset-y-0" style={{ left: `${LANE_LEFT}%`, right: `${100 - LANE_RIGHT}%` }}>
          <span className="nt-spark" data-dir={rung.heading} />
        </span>
        <div
          className="absolute inset-y-0 flex flex-col items-center justify-center gap-1"
          style={{ left: `${LANE_LEFT + 4}%`, right: `${100 - LANE_RIGHT + 4}%` }}
        >
          <span className="nt-pkt" data-tone="data" data-live={live}>
            <span className="nt-pkt-verb">{rung.heading === 'right' ? '→' : '←'}</span>
            <span>{label}</span>
          </span>
          <span className="max-w-full truncate font-mono text-[10.5px] text-muted">
            {listing
              ? 'newline-framed TYPE|NAME|SIZE records'
              : `${chunk?.filename ?? ''} · ${formatBytes(moved)} of ${formatBytes(total)}`}
          </span>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
          className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-canvas hover:text-ink"
          aria-expanded={open}
          aria-label={open ? 'Collapse chunks' : `Show ${rung.events.length} chunks`}
          title={open ? 'Collapse chunks' : 'Show each chunk'}
        >
          <ChevronRight className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function ChunkRows({
  rung,
  selectedKey,
  freshFloor,
  onSelect,
}: {
  rung: StreamRung
  selectedKey: string | null
  freshFloor: number
  onSelect: (event: TelemetryEvent) => void
}) {
  const skipped = Math.max(0, rung.events.length - EXPANDED_CHUNKS)
  const shown = skipped ? rung.events.slice(skipped) : rung.events
  let previous = skipped ? rung.events[skipped - 1].timestamp : null
  return (
    <div className="border-y border-line/70 bg-[color-mix(in_oklch,var(--color-data)_3%,transparent)]">
      {skipped ? (
        <p className="py-1.5 text-center font-mono text-[10.5px] text-muted">{skipped.toLocaleString()} earlier chunks folded</p>
      ) : null}
      {shown.map((event) => {
        const key = eventKey(event)
        const delta = previous === null ? null : event.timestamp - previous
        previous = event.timestamp
        const selected = key === selectedKey
        return (
          <div
            key={key}
            className="nt-rung grid h-7 grid-cols-[var(--gutter)_minmax(0,1fr)]"
            data-tone="data"
            data-selected={selected}
            data-fresh={event.seq > freshFloor}
            role="option"
            aria-selected={selected}
            tabIndex={0}
            onClick={() => onSelect(event)}
            onKeyDown={rungKeys(() => onSelect(event))}
          >
            <Gutter delta={delta} tag={null} />
            <div className="relative">
              <Wire heading={rung.heading} />
              <div
                className="absolute inset-y-0 flex items-center justify-center"
                style={{ left: `${LANE_LEFT + 5}%`, right: `${100 - LANE_RIGHT + 5}%` }}
              >
                <span className="nt-pkt h-[18px] text-[10.5px]" data-tone="data">
                  <span>{event.verb === 'LIST' ? event.raw_frame_repr.replace(/\\n$/, '') : frameLabel(event)}</span>
                </span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function isContinuation(rung: FrameRung): boolean {
  return rung.key.endsWith(':synack') || rung.key.endsWith(':ack') || rung.key.endsWith(':finack')
}

function eventOf(rung: Rung): TelemetryEvent {
  return rung.kind === 'stream' ? rung.events[0] : rung.event
}

function lastOf(rung: Rung): TelemetryEvent {
  return rung.kind === 'stream' ? rung.events[rung.events.length - 1] : rung.event
}

function lastEventOf(rungs: Rung[]): TelemetryEvent | null {
  const last = rungs[rungs.length - 1]
  return last ? lastOf(last) : null
}

function formatDelta(ms: number): string {
  if (ms < 0) return '+0 ms'
  if (ms < 1) return `+${(ms * 1000).toFixed(0)} µs`
  if (ms < 1000) return `+${ms.toFixed(ms < 10 ? 2 : 1)} ms`
  return `+${(ms / 1000).toFixed(2)} s`
}
