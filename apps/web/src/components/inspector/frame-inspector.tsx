import { useMemo } from 'react'
import { ArrowLeft, ArrowRight, Crosshair, Pin } from 'lucide-react'
import { cn } from '../../lib/cn'
import { formatBytes } from '../../lib/format'
import { eventKey, hexToBytes, toneOf, type TelemetryEvent, type Tone } from '../../lib/telemetry'
import { Button } from '../button'
import { shortId } from './model'
import { PaneHead } from './pane-head'

type Props = {
  event: TelemetryEvent | null
  events: TelemetryEvent[]
  pinned: boolean
  onFollow: () => void
}

const TYPE_COPY: Record<TelemetryEvent['event_type'], string> = {
  TCP_CONNECT: 'TCP handshake',
  COMMAND_FRAME: 'Command frame',
  STATUS_FRAME: 'Status frame',
  LENGTH_PREFIX: 'Length prefix',
  DATA_CHUNK: 'Payload chunk',
  TCP_CLOSE: 'TCP teardown',
}

export function FrameInspector({ event, events, pinned, onFollow }: Props) {
  const context = useMemo(() => (event ? frameContext(event, events) : null), [event, events])

  if (!event || !context) {
    return (
      <section className="flex min-h-0 flex-1 flex-col" aria-label="Frame inspector">
        <PaneHead title="Frame" />
        <div className="nt-stage-note">
          <p className="max-w-[30ch] text-center text-[13px] leading-5 text-muted">
            Select a packet on the ladder to open its bytes, framing and timing.
          </p>
        </div>
      </section>
    )
  }

  const tone = toneOf(event)
  const outbound = event.direction === 'CLIENT_TO_SERVER'

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Frame inspector">
      <PaneHead title="Frame">
        {pinned ? (
          <Button variant="ghost" className="h-7 px-2 text-[12px]" onClick={onFollow} title="Show the newest frame as it arrives">
            <Crosshair className="size-3.5" aria-hidden="true" />
            Follow latest
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <Pin className="size-3" aria-hidden="true" />
            Click a packet to pin
          </span>
        )}
      </PaneHead>

      <div className="min-h-0 flex-1 overflow-auto px-4 pt-3 pb-5 sm:px-5">
        <div key={pinned ? eventKey(event) : 'live'} className={cn(pinned && 'nt-mode')}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="nt-pkt" data-tone={tone}>
              <span className="nt-pkt-verb">{event.verb ?? event.event_type}</span>
            </span>
            <span className="text-[14px] font-medium tracking-[-0.02em]">{TYPE_COPY[event.event_type]}</span>
            <span className="font-mono text-[11px] text-muted">
              No. {event.seq} · {event.layer === 'L4_TCP' ? 'L4 transport' : 'L7 application'}
            </span>
          </div>
          <p className="mt-2 font-mono text-[12px] leading-5 break-all text-ink">{event.raw_frame_repr}</p>
          <p className="mt-1.5 text-[12.5px] leading-5 text-muted">{event.description}</p>

          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted">
            <span className={cn(outbound && 'text-ink')}>Client {event.client_addr}</span>
            {outbound ? (
              <ArrowRight className="size-3 text-signal" aria-label="to" />
            ) : (
              <ArrowLeft className="size-3 text-signal" aria-label="from" />
            )}
            <span className={cn(!outbound && 'text-ink')}>Server {event.server_addr}</span>
            <span className="text-line-strong">·</span>
            <span>conn #{shortId(event.connection_id)}</span>
          </p>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric
            label="Frame size"
            value={event.frame_bytes === 0 ? '0 B' : formatBytes(event.frame_bytes)}
            hint={event.frame_bytes >= 1024 ? `${event.frame_bytes.toLocaleString()} bytes` : event.frame_bytes === 0 ? 'flags only' : 'on the wire'}
          />
          <Metric label="Δ prev frame" value={formatGap(context.sinceConn)} hint="same socket" />
          <Metric label="Δ prev packet" value={formatGap(context.sinceAny)} hint="any socket" />
          <Metric label="Captured" value={clock(event.timestamp)} hint={dateOf(event.timestamp)} />
        </dl>

        <StreamFraming event={event} segments={context.segments} />
        <HexDump event={event} />
      </div>
    </section>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="nt-stat px-3 py-2">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-[14px] leading-5 font-medium tracking-[-0.01em] tabular-nums">{value}</dd>
      <dd className="truncate font-mono text-[10.5px] text-muted">{hint}</dd>
    </div>
  )
}

// ── Stream framing explainer ─────────────────────────────────────────────

type Cell = { text: string; role: 'text' | 'delim' | 'prefix' | 'payload' | 'more'; title?: string }

type Segment = {
  key: string
  focus: boolean
  tone: Tone
  label: string
  cells: Cell[]
}

type Context = {
  sinceConn: number | null
  sinceAny: number | null
  segments: Segment[]
}

function frameContext(event: TelemetryEvent, events: TelemetryEvent[]): Context {
  const key = eventKey(event)
  const index = events.findIndex((item) => eventKey(item) === key)
  let sinceAny: number | null = null
  let sinceConn: number | null = null
  if (index > 0) sinceAny = event.timestamp - events[index - 1].timestamp
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (events[cursor].connection_id === event.connection_id) {
      sinceConn = event.timestamp - events[cursor].timestamp
      break
    }
  }

  // The same byte stream, one direction of one socket, around this frame.
  const lane = events.filter(
    (item) =>
      item.connection_id === event.connection_id &&
      item.direction === event.direction &&
      item.event_type !== 'TCP_CONNECT' &&
      item.event_type !== 'TCP_CLOSE',
  )
  const at = lane.findIndex((item) => eventKey(item) === key)
  const segments: Segment[] = []
  if (at !== -1) {
    const start = Math.max(0, at - 1)
    for (const item of lane.slice(start, start + 3)) segments.push(segmentOf(item, eventKey(item) === key))
  }
  return { sinceConn, sinceAny, segments }
}

function printable(byte: number): string {
  if (byte === 0x20) return '␠'
  if (byte === 0x2a) return '•'
  return byte >= 0x21 && byte <= 0x7e ? String.fromCharCode(byte) : byte.toString(16).padStart(2, '0')
}

function segmentOf(event: TelemetryEvent, focus: boolean): Segment {
  const bytes = hexToBytes(event.payload_hex)
  const base = { key: eventKey(event), focus, tone: toneOf(event) }

  if (event.event_type === 'LENGTH_PREFIX') {
    const size = bytes.length === 8 ? new DataView(bytes.buffer).getBigUint64(0) : null
    return {
      ...base,
      label: `8-byte prefix · ${size === null ? '?' : Number(size).toLocaleString()} B`,
      cells: Array.from(bytes, (byte) => ({ text: byte.toString(16).padStart(2, '0'), role: 'prefix' as const })),
    }
  }

  if (event.event_type === 'DATA_CHUNK' && event.verb !== 'LIST') {
    const head = Array.from(bytes.slice(0, 5), (byte) => ({
      text: byte.toString(16).padStart(2, '0'),
      role: 'payload' as const,
    }))
    const rest = event.frame_bytes - head.length
    return {
      ...base,
      label: `payload · ${formatBytes(event.frame_bytes)} · counted, not delimited`,
      cells: rest > 0 ? [...head, { text: `+${rest.toLocaleString()} B`, role: 'more', title: `${rest} more bytes` }] : head,
    }
  }

  // Newline-delimited text frame.
  const body = bytes[bytes.length - 1] === 0x0a ? bytes.slice(0, -1) : bytes
  const lead = body.length > 14 ? body.slice(0, 11) : body
  const cells: Cell[] = Array.from(lead, (byte) => ({ text: printable(byte), role: 'text' as const }))
  const hiddenCount = event.frame_bytes - 1 - lead.length
  if (hiddenCount > 0) cells.push({ text: `+${hiddenCount}`, role: 'more', title: `${hiddenCount} more bytes` })
  cells.push({ text: '\\n', role: 'delim', title: '0x0A line delimiter' })
  const verb = event.verb ?? 'line'
  return { ...base, label: `${verb} · ${event.frame_bytes} B · ends at 0x0A`, cells }
}

function StreamFraming({ event, segments }: { event: TelemetryEvent; segments: Segment[] }) {
  const byLength = event.event_type === 'LENGTH_PREFIX' || (event.event_type === 'DATA_CHUNK' && event.verb === 'RETR')
  const byAnnounce = event.event_type === 'DATA_CHUNK' && event.verb === 'STOR'
  const byLine = !byLength && !byAnnounce && event.layer === 'L7_APP'
  const mark = event.event_type === 'TCP_CONNECT' || event.event_type === 'TCP_CLOSE'

  return (
    <section className="mt-5" aria-label="Why TCP framing is hard">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium">Why TCP is hard</h3>
        <p className="font-mono text-[10.5px] text-muted">{event.direction === 'CLIENT_TO_SERVER' ? 'client → server stream' : 'server → client stream'}</p>
      </div>
      <p className="mt-1 text-[12.5px] leading-5 text-muted">
        <code className="font-mono text-[12px] text-ink">recv()</code> returns an unbroken run of bytes. Nothing on the wire says where
        one message stops, so NetTransfer frames the stream itself.
      </p>

      <div className="nt-well mt-3 overflow-x-auto px-3 pt-3 pb-2.5">
        {mark ? (
          <p className="py-3 text-center font-mono text-[11.5px] leading-5 text-muted">
            {event.event_type === 'TCP_CONNECT'
              ? 'SYN and ACK carry no stream bytes. They set up sequence numbers before byte 0.'
              : 'FIN carries no stream bytes. It marks the end of this direction of the stream.'}
          </p>
        ) : (
          <div className="flex w-max items-start gap-1.5">
            {segments.map((segment) => (
              <div key={segment.key} className={cn('flex flex-col', !segment.focus && 'opacity-45')} data-tone={segment.tone}>
                <div className="flex">
                  {segment.cells.map((cell, index) => (
                    <span
                      key={index}
                      className="nt-byte"
                      data-role={cell.role === 'text' ? undefined : cell.role}
                      data-focus={segment.focus && cell.role !== 'delim' && cell.role !== 'more' ? 'true' : undefined}
                      title={cell.title}
                    >
                      {cell.text}
                    </span>
                  ))}
                </div>
                <span className="nt-bracket" />
                <span className="mt-1 max-w-[32ch] truncate font-mono text-[10.5px] text-muted">{segment.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2.5 grid gap-2 sm:grid-cols-3">
        <Rule
          active={byLine}
          tone="command"
          title="Delimiter"
          code="read_line()"
          body="Commands and replies end at 0x0A. The reader buffers until it finds one."
        />
        <Rule
          active={byLength}
          tone="tcp"
          title="Length prefix"
          code="struct.pack('>Q')"
          body="RETR sends 8 big-endian bytes first. The client then reads exactly that many."
        />
        <Rule
          active={byAnnounce}
          tone="data"
          title="Announced size"
          code="STOR name <size>"
          body="Uploads declare the byte count in the command line. No prefix is sent."
        />
      </div>
    </section>
  )
}

function Rule({
  active,
  tone,
  title,
  code,
  body,
}: {
  active: boolean
  tone: Tone
  title: string
  code: string
  body: string
}) {
  return (
    <div
      className={cn('nt-stat px-3 py-2.5 transition-opacity duration-200', !active && 'opacity-55')}
      data-tone={tone}
      style={active ? { boxShadow: 'inset 0 0 0 1px color-mix(in oklch, var(--tone) 45%, transparent)' } : undefined}
    >
      <p className="flex items-center gap-1.5 text-[12px] font-medium">
        <span className="nt-swatch" />
        {title}
        {active ? <span className="ml-auto font-mono text-[10px] text-muted uppercase">this frame</span> : null}
      </p>
      <p className="mt-1 font-mono text-[11px] text-ink">{code}</p>
      <p className="mt-1 text-[11.5px] leading-4 text-muted">{body}</p>
    </div>
  )
}

// ── Hex / ASCII dump ─────────────────────────────────────────────────────

function HexDump({ event }: { event: TelemetryEvent }) {
  const bytes = hexToBytes(event.payload_hex)
  const rows: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += 16) rows.push(bytes.slice(offset, offset + 16))
  const masked = event.verb === 'AUTH' || event.verb === 'REGISTER'

  return (
    <section className="mt-5" aria-label="Hex and ASCII">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium">Bytes</h3>
        <p className="font-mono text-[10.5px] text-muted">
          {bytes.length === 0
            ? 'no payload'
            : bytes.length < event.frame_bytes
              ? `first ${bytes.length} of ${event.frame_bytes.toLocaleString()} B`
              : `${bytes.length} B`}
        </p>
      </div>
      {bytes.length === 0 ? (
        <p className="nt-well mt-2 px-3 py-3 font-mono text-[11.5px] text-muted">
          This mark has no application payload. Its flags live in the TCP header, which the socket API never exposes.
        </p>
      ) : (
        <div className="nt-well mt-2 overflow-x-auto px-2 py-2">
          <table className="font-mono text-[11.5px] leading-[20px]">
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="nt-hex-row">
                  <td className="nt-hex-dim pr-3 pl-1 select-none">{(index * 16).toString(16).padStart(4, '0')}</td>
                  <td className="pr-3 whitespace-pre">
                    {Array.from(row, (byte, column) => (
                      <span key={column} className={cn(byte === 0x0a && 'nt-hex-nl', column === 8 && 'ml-2')}>
                        {byte.toString(16).padStart(2, '0')}
                        {column < 15 ? ' ' : ''}
                      </span>
                    ))}
                  </td>
                  <td className="pr-1 whitespace-pre text-muted">
                    {Array.from(row, (byte, column) => (
                      <span key={column} className={cn(byte === 0x0a && 'nt-hex-nl')}>
                        {byte === 0x0a ? '↵' : byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '·'}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {masked ? (
        <p className="mt-1.5 text-[11.5px] leading-4 text-muted">
          Password bytes are shown as <span className="font-mono">2a</span> (<span className="font-mono">*</span>). On port 2121 they
          cross in cleartext, which is what Wireshark will show.
        </p>
      ) : null}
    </section>
  )
}

// ── formatting ───────────────────────────────────────────────────────────

function formatGap(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1) return `${Math.max(0, ms * 1000).toFixed(0)} µs`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function clock(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

function dateOf(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ms))
}
