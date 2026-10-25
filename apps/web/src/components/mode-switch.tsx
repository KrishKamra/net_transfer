import { Activity, FolderClosed } from 'lucide-react'
import type { TelemetrySocketState } from '../lib/telemetry'
import { cn } from '../lib/cn'

export type Mode = 'files' | 'inspector'

type Props = {
  mode: Mode
  activeTransfers: number
  onChange: (mode: Mode) => void
}

export function ModeSwitch({ mode, activeTransfers, onChange }: Props) {
  return (
    <div className="nt-seg" role="group" aria-label="Workspace view">
      <span
        className="nt-seg-thumb"
        style={{ width: 'calc(50% - 2px)', transform: mode === 'files' ? 'translateX(0)' : 'translateX(100%)' }}
        aria-hidden="true"
      />
      <button type="button" aria-pressed={mode === 'files'} onClick={() => onChange('files')} title="File manager">
        <FolderClosed className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">File manager</span>
        <span className="sr-only sm:hidden">File manager</span>
        {activeTransfers > 0 && mode !== 'files' ? (
          <span className="nt-count" aria-label={`${activeTransfers} active transfers`}>
            {activeTransfers}
          </span>
        ) : null}
      </button>
      <button type="button" aria-pressed={mode === 'inspector'} onClick={() => onChange('inspector')} title="Protocol inspector">
        <Activity className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Protocol inspector</span>
        <span className="sr-only sm:hidden">Protocol inspector</span>
      </button>
    </div>
  )
}

const BEACON: Record<string, { label: string; led: string; state: string }> = {
  live: { label: 'Live socket', led: 'is-ready', state: 'live' },
  unlinked: { label: 'Socket · awaiting :2121', led: 'is-checking', state: 'idle' },
  connecting: { label: 'Connecting', led: 'is-checking', state: 'idle' },
  down: { label: 'Socket offline', led: 'is-down', state: 'down' },
}

export function SocketBeacon({ state, tapAttached }: { state: TelemetrySocketState; tapAttached: boolean | null }) {
  const key = state === 'live' ? (tapAttached === false ? 'unlinked' : 'live') : state
  const beacon = BEACON[key]
  return (
    <span
      className="nt-beacon"
      data-state={beacon.state}
      role="status"
      title={
        key === 'live'
          ? '/ws/telemetry is open and the TCP server on 2121 is linked'
          : key === 'unlinked'
            ? '/ws/telemetry is open. The TCP server has not linked its telemetry yet.'
            : '/ws/telemetry'
      }
    >
      <span className={cn('nt-led', beacon.led)} aria-hidden="true" />
      <span className="hidden md:inline">{beacon.label}</span>
      <span className="sr-only md:hidden">{beacon.label}</span>
    </span>
  )
}
