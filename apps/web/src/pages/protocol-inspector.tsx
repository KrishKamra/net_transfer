import { useMemo, useRef, useState } from 'react'
import { Activity, FolderClosed, ListTree, Pause, Play, Rows3, Trash, Upload } from 'lucide-react'
import { Button } from '../components/button'
import { FrameInspector } from '../components/inspector/frame-inspector'
import { buildRungs, describeConnections, shortId } from '../components/inspector/model'
import { SequenceLadder } from '../components/inspector/sequence-ladder'
import { TelemetrySummary } from '../components/inspector/telemetry-summary'
import { WiresharkTable } from '../components/inspector/wireshark-table'
import { TELEMETRY_BUFFER, type Telemetry } from '../hooks/use-telemetry-socket'
import { cn } from '../lib/cn'
import { eventKey, type TelemetryEvent, type Tone } from '../lib/telemetry'

type View = 'ladder' | 'wireshark'

type Props = {
  telemetry: Telemetry
  onUpload: (files: File[]) => void
  onOpenFiles: () => void
}

const LEGEND: { tone: Tone; label: string }[] = [
  { tone: 'tcp', label: 'SYN · FIN' },
  { tone: 'command', label: 'Command' },
  { tone: 'status', label: 'Reply' },
  { tone: 'data', label: 'Payload' },
]

function loadView(): View {
  try {
    return window.localStorage.getItem('nettransfer.inspector.view') === 'wireshark' ? 'wireshark' : 'ladder'
  } catch {
    return 'ladder'
  }
}

export function ProtocolInspector({ telemetry, onUpload, onOpenFiles }: Props) {
  const { events, state, tapAttached, trimmed } = telemetry
  const [view, setViewState] = useState<View>(loadView)
  const [follow, setFollow] = useState(true)
  const [pinnedKey, setPinnedKey] = useState<string | null>(null)
  const [scope, setScope] = useState<string>('all')
  const fileRef = useRef<HTMLInputElement>(null)

  function setView(next: View) {
    setViewState(next)
    try {
      window.localStorage.setItem('nettransfer.inspector.view', next)
    } catch {
      // Private mode. The choice lasts for this page only.
    }
  }

  const connections = useMemo(() => describeConnections(events), [events])
  const scopeLive = scope === 'all' || connections.some((conn) => conn.id === scope)
  const activeScope = scopeLive ? scope : 'all'
  const scoped = useMemo(
    () => (activeScope === 'all' ? events : events.filter((event) => event.connection_id === activeScope)),
    [events, activeScope],
  )
  const rungs = useMemo(() => buildRungs(scoped), [scoped])

  const pinned = useMemo(
    () => (pinnedKey ? (events.find((event) => eventKey(event) === pinnedKey) ?? null) : null),
    [events, pinnedKey],
  )
  const selected: TelemetryEvent | null = pinned ?? scoped[scoped.length - 1] ?? null
  const focus = connections.find((conn) => conn.id === selected?.connection_id) ?? null

  function select(event: TelemetryEvent) {
    setPinnedKey(eventKey(event))
  }

  function clear() {
    telemetry.clear()
    setPinnedKey(null)
    setScope('all')
    setFollow(true)
  }

  const empty = events.length === 0

  return (
    <section className="nt-inspector flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Protocol inspector">
      <header className="nt-mast flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 sm:px-5">
        <div className="min-w-0">
          <h1 className="text-[14px] font-medium tracking-[-0.02em]">Protocol inspector</h1>
          <p className="mt-0.5 truncate font-mono text-[12px] text-muted">
            tcp.port == 2121 · {events.length.toLocaleString()} {events.length === 1 ? 'frame' : 'frames'}
            {trimmed > 0 ? ` · oldest ${trimmed.toLocaleString()} rolled off` : ''}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">Show one socket</span>
            <select
              value={activeScope}
              onChange={(event) => {
                setScope(event.target.value)
                setPinnedKey(null)
                setFollow(true)
              }}
              className="nt-field h-8 w-[13.5rem] cursor-pointer pr-7 text-[12px] leading-8"
              disabled={connections.length === 0}
            >
              <option value="all">All sockets ({connections.length})</option>
              {[...connections].reverse().map((conn) => (
                <option key={conn.id} value={conn.id}>
                  #{shortId(conn.id)} · {conn.purpose ?? conn.clientAddr}
                  {conn.closedAt === null ? ' · open' : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="nt-seg nt-seg-sm" role="group" aria-label="Packet list layout">
            <span
              className="nt-seg-thumb"
              style={{ width: 'calc(50% - 2px)', transform: view === 'ladder' ? 'translateX(0)' : 'translateX(100%)' }}
              aria-hidden="true"
            />
            <button type="button" aria-pressed={view === 'ladder'} onClick={() => setView('ladder')}>
              <ListTree className="size-3.5" aria-hidden="true" />
              Ladder
            </button>
            <button
              type="button"
              aria-pressed={view === 'wireshark'}
              onClick={() => setView('wireshark')}
              title="Wireshark parity: No., Time, Source, Destination, Protocol, Length, Info"
            >
              <Rows3 className="size-3.5" aria-hidden="true" />
              Wireshark
            </button>
          </div>

          <Button
            variant="secondary"
            className="h-8"
            onClick={() => setFollow((value) => !value)}
            aria-pressed={!follow}
            title={follow ? 'Stop auto-scrolling to the newest frame' : 'Resume auto-scroll'}
          >
            {follow ? <Pause className="size-3.5" aria-hidden="true" /> : <Play className="size-3.5" aria-hidden="true" />}
            <span className="hidden sm:inline">{follow ? 'Pause' : 'Auto-scroll'}</span>
          </Button>
          <Button variant="ghost" className="h-8" onClick={clear} disabled={empty} title="Clear this view. The server keeps its own ring.">
            <Trash className="size-3.5" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Clear</span>
          </Button>
        </div>
      </header>

      <LinkNotice state={state} tapAttached={tapAttached} />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-[30rem] min-w-0 flex-col lg:min-h-0 lg:w-[55%]">
          {empty ? (
            <EmptyCapture
              onUpload={() => fileRef.current?.click()}
              onOpenFiles={onOpenFiles}
              ready={state === 'live' && tapAttached === true}
            />
          ) : view === 'ladder' ? (
            <SequenceLadder
              rungs={rungs}
              selectedKey={selected ? eventKey(selected) : null}
              clientAddr={focus?.clientAddr ?? null}
              serverAddr={focus?.serverAddr ?? null}
              follow={follow}
              onFollowChange={setFollow}
              onSelect={select}
            />
          ) : (
            <WiresharkTable
              events={scoped}
              selectedKey={selected ? eventKey(selected) : null}
              follow={follow}
              onFollowChange={setFollow}
              onSelect={select}
            />
          )}

          <footer className="flex h-9 shrink-0 items-center justify-between gap-3 border-t border-line px-4 sm:px-5">
            <ul className="flex min-w-0 items-center gap-3.5 overflow-hidden">
              {LEGEND.map((item) => (
                <li key={item.tone} className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted" data-tone={item.tone}>
                  <span className="nt-swatch" />
                  {item.label}
                </li>
              ))}
            </ul>
            <p className="hidden shrink-0 font-mono text-[10.5px] text-muted sm:block">
              buffer {Math.min(events.length, TELEMETRY_BUFFER).toLocaleString()}/{TELEMETRY_BUFFER.toLocaleString()}
            </p>
          </footer>
        </div>

        <aside className="nt-side flex min-h-0 min-w-0 flex-col border-t border-line lg:w-[45%] lg:border-t-0">
          <FrameInspector event={selected} events={events} pinned={pinned !== null} onFollow={() => setPinnedKey(null)} />
          <TelemetrySummary events={events} connections={connections} focus={focus} />
        </aside>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : []
          if (files.length) onUpload(files)
          event.target.value = ''
        }}
      />
    </section>
  )
}

function LinkNotice({ state, tapAttached }: { state: Telemetry['state']; tapAttached: boolean | null }) {
  if (state === 'live' && tapAttached !== false) return null
  const down = state === 'down'
  return (
    <p
      role="status"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2 text-[12.5px] sm:px-5',
        down ? 'bg-oxide-soft text-oxide' : 'bg-[color-mix(in_oklch,var(--color-signal)_5%,white)] text-ink',
      )}
    >
      <span className={cn('nt-led', down ? 'is-down' : 'is-checking')} aria-hidden="true" />
      {down ? (
        <>The telemetry socket on port 8000 is closed. Retrying.</>
      ) : state === 'connecting' ? (
        <>Opening /ws/telemetry…</>
      ) : (
        <>
          The TCP server is not linked yet. Start it and frames will stream in:
          <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11.5px] shadow-[inset_0_0_0_1px_var(--color-line)]">
            uv run python -m src.networking.tcp_server
          </code>
        </>
      )}
    </p>
  )
}

function EmptyCapture({ onUpload, onOpenFiles, ready }: { onUpload: () => void; onOpenFiles: () => void; ready: boolean }) {
  return (
    <div className="nt-ladder nt-stage-note min-h-0">
      <div className="nt-card-plate nt-rise w-full max-w-[400px] px-7 py-8 text-center">
        <span className="nt-node-mark mx-auto size-10 rounded-[10px]">
          <Activity className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-5 text-[19px] leading-7 font-medium tracking-[-0.03em]">
          {ready ? 'Listening on port 2121.' : 'Waiting for the capture link.'}
        </p>
        <p className="mx-auto mt-2 max-w-[34ch] text-[13px] leading-5 text-muted">
          Upload or download a file. Each frame appears here as it crosses the socket: the handshake, the commands, the
          length prefix and every 64 KB chunk.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-1.5" aria-hidden="true">
          <span className="nt-pkt" data-tone="tcp"><span className="nt-pkt-verb">SYN</span></span>
          <span className="nt-pkt" data-tone="command"><span className="nt-pkt-verb">STOR</span></span>
          <span className="nt-pkt" data-tone="status"><span className="nt-pkt-verb">150</span></span>
          <span className="nt-pkt" data-tone="data"><span className="nt-pkt-verb">→</span><span>64 KB</span></span>
          <span className="nt-pkt" data-tone="status"><span className="nt-pkt-verb">226</span></span>
        </div>
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="primary" className="h-9 px-4" onClick={onUpload}>
            <Upload className="size-3.5" aria-hidden="true" />
            Upload a file
          </Button>
          <Button variant="secondary" className="h-9 px-3.5" onClick={onOpenFiles}>
            <FolderClosed className="size-3.5" aria-hidden="true" />
            Open files
          </Button>
        </div>
      </div>
    </div>
  )
}
