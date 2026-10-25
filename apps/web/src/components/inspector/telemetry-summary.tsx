import { useEffect, useMemo, useState, type PointerEvent } from 'react'
import { formatBytes } from '../../lib/format'
import { toneOf, type TelemetryEvent, type Tone } from '../../lib/telemetry'
import { shortId, type Connection } from './model'
import { PaneHead } from './pane-head'

type Props = {
  events: TelemetryEvent[]
  connections: Connection[]
  focus: Connection | null
}

const MIX: { tone: Tone; label: string }[] = [
  { tone: 'tcp', label: 'TCP' },
  { tone: 'command', label: 'Command' },
  { tone: 'status', label: 'Reply' },
  { tone: 'error', label: 'Error' },
  { tone: 'data', label: 'Data' },
]

export function TelemetrySummary({ events, connections, focus }: Props) {
  const totals = useMemo(() => {
    let up = 0
    let down = 0
    const mix: Record<Tone, number> = { tcp: 0, command: 0, status: 0, error: 0, data: 0 }
    for (const event of events) {
      if (event.direction === 'CLIENT_TO_SERVER') up += event.frame_bytes
      else down += event.frame_bytes
      mix[toneOf(event)] += 1
    }
    return { up, down, mix }
  }, [events])

  const stream = useMemo(() => latestStream(events, focus?.id ?? null), [events, focus?.id])
  const now = useNow(focus !== null && focus.closedAt === null)
  const open = focus ? (focus.closedAt ?? Math.max(now, focus.lastAt)) - focus.openedAt : null

  return (
    <section className="flex shrink-0 flex-col border-t border-line" aria-label="Live telemetry">
      <PaneHead title="Telemetry">
        <span className="font-mono text-[11px] text-muted">
          {connections.length} {connections.length === 1 ? 'socket' : 'sockets'} seen
        </span>
      </PaneHead>

      <div className="grid gap-2.5 px-4 py-3 sm:px-5">
        <dl className="grid grid-cols-3 gap-2">
          <Tile
            label="On the wire"
            value={formatBytes(totals.up + totals.down)}
            hint={`↑ ${formatBytes(totals.up)} · ↓ ${formatBytes(totals.down)}`}
          />
          <Tile label="Frames" value={events.length.toLocaleString()} hint={`${totals.mix.data.toLocaleString()} payload`} />
          <Tile
            label="Socket open"
            value={open === null ? '—' : formatOpen(open)}
            hint={
              focus
                ? `#${shortId(focus.id)} · ${focus.closedAt === null ? 'established' : focus.closeVerb === 'RST' ? 'reset' : 'closed'}`
                : 'no socket yet'
            }
            live={focus !== null && focus.closedAt === null}
          />
        </dl>

        <Throughput stream={stream} />

        <div>
          <div className="flex items-baseline justify-between">
            <p className="text-[12px] font-medium">Frame mix</p>
            <p className="font-mono text-[10.5px] text-muted">by count</p>
          </div>
          <div className="nt-mix mt-2" role="img" aria-label={MIX.map((item) => `${item.label} ${totals.mix[item.tone]}`).join(', ')}>
            {events.length === 0 ? (
              <span style={{ flexGrow: 1, background: 'var(--color-line)' }} />
            ) : (
              MIX.filter((item) => totals.mix[item.tone] > 0).map((item) => (
                <span key={item.tone} data-tone={item.tone} style={{ flexGrow: totals.mix[item.tone] }} title={`${item.label}: ${totals.mix[item.tone]}`} />
              ))
            )}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
            {MIX.map((item) => (
              <li key={item.tone} className="inline-flex items-center gap-1.5 text-[11.5px] text-muted" data-tone={item.tone}>
                <span className="nt-swatch" />
                {item.label}
                <span className="font-mono text-ink tabular-nums">{totals.mix[item.tone].toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

function Tile({ label, value, hint, live }: { label: string; value: string; hint: string; live?: boolean }) {
  return (
    <div className="nt-stat min-w-0 px-3 py-2">
      <dt className="flex items-center gap-1.5 text-[11px] text-muted">
        {live ? <span className="nt-led is-ready !size-[6px]" aria-hidden="true" /> : null}
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-mono text-[15px] leading-5 font-medium tracking-[-0.02em] tabular-nums">{value}</dd>
      <dd className="truncate font-mono text-[10.5px] text-muted">{hint}</dd>
    </div>
  )
}

type Stream = { verb: string; filename: string; points: { index: number; mbps: number }[]; count: number; done: boolean }

function latestStream(events: TelemetryEvent[], preferConn: string | null): Stream | null {
  const isPayload = (event: TelemetryEvent) =>
    event.event_type === 'DATA_CHUNK' && event.verb !== 'LIST' && event.chunk !== null
  // Prefer the focused socket's stream, else the newest stream anywhere.
  const tail =
    (preferConn ? findLast(events, (event) => isPayload(event) && event.connection_id === preferConn) : undefined) ??
    findLast(events, isPayload)
  if (!tail || !tail.chunk) return null

  const points: { index: number; mbps: number }[] = []
  for (const event of events) {
    if (event.connection_id !== tail.connection_id || event.verb !== tail.verb || !event.chunk) continue
    if (event.event_type !== 'DATA_CHUNK') continue
    if (event.chunk.chunk_index === 1) points.length = 0
    points.push({ index: event.chunk.chunk_index, mbps: event.chunk.rolling_mbps })
  }
  return {
    verb: tail.verb ?? '',
    filename: tail.chunk.filename ?? '',
    points,
    count: tail.chunk.chunk_count,
    done: tail.chunk.chunk_index >= tail.chunk.chunk_count,
  }
}

const W = 320
const H = 56

function Throughput({ stream }: { stream: Stream | null }) {
  const [hover, setHover] = useState<number | null>(null)

  const plotted = useMemo(() => {
    if (!stream) return []
    const step = Math.max(1, Math.ceil(stream.points.length / 120))
    return stream.points.filter((_, index) => index % step === 0 || index === stream.points.length - 1)
  }, [stream])

  const latest = stream?.points[stream.points.length - 1]
  const peak = plotted.reduce((max, point) => Math.max(max, point.mbps), 0)
  const scale = peak > 0 ? peak * 1.15 : 1
  const x = (i: number) => (plotted.length <= 1 ? W : (i / (plotted.length - 1)) * W)
  const y = (mbps: number) => H - 3 - (mbps / scale) * (H - 8)
  const line = plotted.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(point.mbps).toFixed(1)}`).join(' ')
  const area = plotted.length ? `${line} L${x(plotted.length - 1).toFixed(1)},${H} L0,${H} Z` : ''

  function onMove(event: PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - box.left) / box.width
    setHover(Math.max(0, Math.min(plotted.length - 1, Math.round(ratio * (plotted.length - 1)))))
  }

  const shown = hover !== null ? plotted[hover] : null

  return (
    <div className="nt-stat grid grid-cols-[minmax(7.5rem,auto)_minmax(0,1fr)] items-end gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[11px] text-muted">Throughput</p>
        <p className="mt-0.5 flex items-baseline gap-1.5">
          <span className="font-mono text-[22px] leading-7 font-medium tracking-[-0.03em] tabular-nums">
            {(shown ?? latest)?.mbps.toFixed(1) ?? '—'}
          </span>
          <span className="text-[12px] text-muted">MB/s</span>
        </p>
        <p className="truncate font-mono text-[10.5px] text-muted">
          {shown
            ? `chunk ${shown.index}/${stream?.count}`
            : stream
              ? `peak ${peak.toFixed(1)} · ${stream.done ? 'complete' : `${stream.points.length}/${stream.count}`}`
              : 'rolling, per chunk'}
        </p>
      </div>
      <div className="relative min-w-0">
        <p className="mb-1 truncate text-right font-mono text-[10.5px] text-muted">
          {stream ? `${stream.verb} ${stream.filename}` : 'waiting for STOR or RETR'}
        </p>
        {plotted.length > 1 ? (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="block h-11 w-full touch-none"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            role="img"
            aria-label={`Rolling throughput across ${stream?.points.length} chunks, latest ${latest?.mbps.toFixed(1)} MB/s`}
          >
            <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--color-line)" strokeWidth="1" />
            <path d={area} className="nt-spark-area" />
            <path d={line} className="nt-spark-line" vectorEffect="non-scaling-stroke" />
            {hover !== null ? (
              <line className="nt-spark-guide" x1={x(hover)} x2={x(hover)} y1="0" y2={H} vectorEffect="non-scaling-stroke" />
            ) : null}
          </svg>
        ) : (
          <div className="grid h-11 place-items-center rounded-md border border-dashed border-line font-mono text-[10.5px] text-muted">
            {plotted.length === 1 ? 'one chunk · nothing to plot yet' : 'no payload yet'}
          </div>
        )}
        {hover !== null && plotted.length > 1 ? (
          <span
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-surface bg-data"
            style={{ left: `${(x(hover) / W) * 100}%`, bottom: `${(1 - y(plotted[hover].mbps) / H) * 44}px` }}
          />
        ) : null}
      </div>
    </div>
  )
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [ticking])
  return now
}

function formatOpen(ms: number): string {
  if (ms < 1000) return `${Math.max(0, ms).toFixed(0)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function findLast<T>(items: T[], test: (item: T) => boolean): T | undefined {
  for (let cursor = items.length - 1; cursor >= 0; cursor -= 1) {
    if (test(items[cursor])) return items[cursor]
  }
  return undefined
}
