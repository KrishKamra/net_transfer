// Mirror of apps/server/src/telemetry/events.py. Keep the two in step.

export type Direction = 'CLIENT_TO_SERVER' | 'SERVER_TO_CLIENT'
export type Layer = 'L4_TCP' | 'L7_APP'
export type EventType =
  | 'TCP_CONNECT'
  | 'COMMAND_FRAME'
  | 'STATUS_FRAME'
  | 'LENGTH_PREFIX'
  | 'DATA_CHUNK'
  | 'TCP_CLOSE'

export type ChunkInfo = {
  chunk_index: number
  chunk_count: number
  chunk_bytes: number
  offset: number
  total_bytes: number
  rolling_mbps: number
  filename: string | null
}

export type TelemetryEvent = {
  seq: number
  /** Unix epoch in milliseconds, sub-ms precision. */
  timestamp: number
  connection_id: string
  username: string | null
  client_addr: string
  server_addr: string
  direction: Direction
  layer: Layer
  event_type: EventType
  /** Command verb, 3-digit reply code, or SYN / FIN / RST / LEN. */
  verb: string | null
  frame_bytes: number
  raw_frame_repr: string
  /** Hex of up to the first 64 real bytes. Passwords are masked with `*`. */
  payload_hex: string
  description: string
  chunk: ChunkInfo | null
}

export type TelemetryFrame =
  | { type: 'ready'; tap_attached: boolean; ring_size: number; events: TelemetryEvent[] }
  | { type: 'events'; events: TelemetryEvent[] }
  | { type: 'tap'; attached: boolean }

/** Visual family of a frame. Drives pill colour everywhere in the inspector. */
export type Tone = 'tcp' | 'command' | 'status' | 'error' | 'data'

export function toneOf(event: TelemetryEvent): Tone {
  switch (event.event_type) {
    case 'TCP_CONNECT':
    case 'TCP_CLOSE':
      return 'tcp'
    case 'COMMAND_FRAME':
      return 'command'
    case 'STATUS_FRAME':
      return event.verb && /^[45]/.test(event.verb) ? 'error' : 'status'
    case 'LENGTH_PREFIX':
    case 'DATA_CHUNK':
      return 'data'
  }
}

export function eventKey(event: TelemetryEvent): string {
  return `${event.connection_id}:${event.seq}:${event.timestamp}`
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2))
  for (let index = 0; index < out.length; index += 1) {
    out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

export function portOf(address: string): string {
  const colon = address.lastIndexOf(':')
  return colon === -1 ? address : address.slice(colon + 1)
}

/** One-line label for a frame, as the ladder pill shows it. */
export function frameLabel(event: TelemetryEvent): string {
  const text = event.raw_frame_repr.replace(/\\n$/, '')
  if (event.event_type === 'DATA_CHUNK' && event.chunk && event.verb !== 'LIST') {
    const { chunk_index, chunk_count, chunk_bytes, rolling_mbps } = event.chunk
    const size = chunk_bytes >= 1024 ? `${(chunk_bytes / 1024).toFixed(chunk_bytes % 1024 ? 1 : 0)} KB` : `${chunk_bytes} B`
    return `Chunk ${chunk_index}/${chunk_count} · ${size} · ${rolling_mbps.toFixed(1)} MB/s`
  }
  if (event.event_type === 'LENGTH_PREFIX') return `LEN ${text}`
  return text
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/telemetry`
}

export type TelemetrySocketState = 'connecting' | 'live' | 'down'

/**
 * Same handshake as /ws/transfers: the JWT goes in the first frame, never the
 * URL. Reconnects with backoff. Returns a disposer.
 */
export function openTelemetrySocket(
  token: string,
  onFrame: (frame: TelemetryFrame) => void,
  onState: (state: TelemetrySocketState) => void,
): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let retryTimer = 0
  let retryMs = 500

  const connect = () => {
    if (stopped) return
    onState('connecting')
    const next = new WebSocket(socketUrl())
    socket = next

    next.onopen = () => {
      if (stopped || socket !== next) return
      next.send(JSON.stringify({ type: 'auth', token }))
    }

    next.onmessage = (message) => {
      if (typeof message.data !== 'string') return
      let frame: TelemetryFrame
      try {
        frame = JSON.parse(message.data) as TelemetryFrame
      } catch {
        return
      }
      if (frame.type === 'ready') {
        retryMs = 500
        onState('live')
      }
      onFrame(frame)
    }

    next.onerror = () => next.close()

    next.onclose = () => {
      if (socket === next) socket = null
      if (stopped) return
      onState('down')
      retryTimer = window.setTimeout(() => {
        retryMs = Math.min(retryMs * 2, 8000)
        connect()
      }, retryMs)
    }
  }

  connect()
  const pingTimer = window.setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}')
  }, 25000)

  return () => {
    stopped = true
    window.clearTimeout(retryTimer)
    window.clearInterval(pingTimer)
    socket?.close()
    socket = null
  }
}
