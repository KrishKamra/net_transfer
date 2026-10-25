import { eventKey, portOf, toneOf, type TelemetryEvent, type Tone } from '../../lib/telemetry'

export type Heading = 'right' | 'left'

export type FrameRung = {
  kind: 'frame'
  key: string
  event: TelemetryEvent
  heading: Heading
  tone: Tone
  verb: string
  text: string
  /** Kernel-level segments inferred from accept()/close, not read by the app. */
  synthetic: boolean
}

export type StreamRung = {
  kind: 'stream'
  key: string
  heading: Heading
  connectionId: string
  events: TelemetryEvent[]
  /** A later frame on this connection ended the stream. */
  closed: boolean
}

export type Rung = FrameRung | StreamRung

export type Connection = {
  id: string
  clientAddr: string
  serverAddr: string
  openedAt: number
  closedAt: number | null
  closeVerb: string | null
  lastAt: number
  frames: number
  bytesUp: number
  bytesDown: number
  /** First STOR / RETR / LIST line, for the connection picker. */
  purpose: string | null
}

export function headingOf(event: TelemetryEvent): Heading {
  return event.direction === 'CLIENT_TO_SERVER' ? 'right' : 'left'
}

function flip(heading: Heading): Heading {
  return heading === 'right' ? 'left' : 'right'
}

function frameRung(
  event: TelemetryEvent,
  suffix: string,
  heading: Heading,
  verb: string,
  text: string,
  synthetic = false,
): FrameRung {
  return {
    kind: 'frame',
    key: `${eventKey(event)}${suffix}`,
    event,
    heading,
    tone: toneOf(event),
    verb,
    text,
    synthetic,
  }
}

function lineText(event: TelemetryEvent): { verb: string; text: string } {
  const line = event.raw_frame_repr.replace(/\\n$/, '')
  const verb = event.verb ?? line.split(' ')[0]
  const rest = line.startsWith(verb) ? line.slice(verb.length).trim() : line
  return { verb, text: rest }
}

/**
 * Turn frames into ladder rungs. Handshake and teardown expand into their
 * segments. Consecutive payload chunks on one connection fold into a single
 * stream rung, so a 1 GB STOR is one live row instead of sixteen thousand.
 */
export function buildRungs(events: TelemetryEvent[]): Rung[] {
  const rungs: Rung[] = []
  const open = new Map<string, StreamRung>()

  for (const event of events) {
    const conn = event.connection_id
    const heading = headingOf(event)

    if (event.event_type === 'DATA_CHUNK') {
      const current = open.get(conn)
      if (current && current.heading === heading && current.events[0].verb === event.verb) {
        current.events.push(event)
        continue
      }
      if (current) current.closed = true
      const stream: StreamRung = {
        kind: 'stream',
        key: `${eventKey(event)}:stream`,
        heading,
        connectionId: conn,
        events: [event],
        closed: false,
      }
      open.set(conn, stream)
      rungs.push(stream)
      continue
    }

    const current = open.get(conn)
    if (current) {
      current.closed = true
      open.delete(conn)
    }

    if (event.event_type === 'TCP_CONNECT') {
      rungs.push(
        frameRung(event, ':syn', 'right', 'SYN', 'seq=0', true),
        frameRung(event, ':synack', 'left', 'SYN, ACK', 'seq=0 ack=1', true),
        frameRung(event, ':ack', 'right', 'ACK', 'seq=1 ack=1', true),
      )
      continue
    }

    if (event.event_type === 'TCP_CLOSE') {
      if (event.verb === 'RST') {
        rungs.push(frameRung(event, ':rst', heading, 'RST', 'connection reset', true))
      } else {
        rungs.push(
          frameRung(event, ':fin', heading, 'FIN, ACK', 'orderly close', true),
          frameRung(event, ':finack', flip(heading), 'FIN, ACK', 'peer closes too', true),
        )
      }
      continue
    }

    if (event.event_type === 'LENGTH_PREFIX') {
      rungs.push(frameRung(event, '', heading, 'LEN', event.raw_frame_repr))
      continue
    }

    const { verb, text } = lineText(event)
    rungs.push(frameRung(event, '', heading, verb, text))
  }

  return rungs
}

export function describeConnections(events: TelemetryEvent[]): Connection[] {
  const byId = new Map<string, Connection>()
  for (const event of events) {
    let conn = byId.get(event.connection_id)
    if (!conn) {
      conn = {
        id: event.connection_id,
        clientAddr: event.client_addr,
        serverAddr: event.server_addr,
        openedAt: event.timestamp,
        closedAt: null,
        closeVerb: null,
        lastAt: event.timestamp,
        frames: 0,
        bytesUp: 0,
        bytesDown: 0,
        purpose: null,
      }
      byId.set(event.connection_id, conn)
    }
    conn.frames += 1
    conn.lastAt = event.timestamp
    if (event.direction === 'CLIENT_TO_SERVER') conn.bytesUp += event.frame_bytes
    else conn.bytesDown += event.frame_bytes
    if (event.event_type === 'TCP_CLOSE') {
      conn.closedAt = event.timestamp
      conn.closeVerb = event.verb
    }
    if (
      !conn.purpose &&
      event.event_type === 'COMMAND_FRAME' &&
      (event.verb === 'STOR' || event.verb === 'RETR' || event.verb === 'LIST')
    ) {
      conn.purpose = event.raw_frame_repr.replace(/\\n$/, '')
    }
  }
  return [...byId.values()]
}

export function shortId(id: string): string {
  return id.slice(0, 4)
}

/** Wireshark-style Info column. */
export function wiresharkInfo(event: TelemetryEvent): string {
  const src = event.direction === 'CLIENT_TO_SERVER' ? event.client_addr : event.server_addr
  const dst = event.direction === 'CLIENT_TO_SERVER' ? event.server_addr : event.client_addr
  const ports = `${portOf(src)} → ${portOf(dst)}`
  switch (event.event_type) {
    case 'TCP_CONNECT':
      return `${ports} [SYN] → [SYN, ACK] → [ACK]  (handshake)`
    case 'TCP_CLOSE':
      return event.verb === 'RST' ? `${ports} [RST, ACK]` : `${ports} [FIN, ACK]`
    case 'DATA_CHUNK':
      if (event.verb === 'LIST') return event.raw_frame_repr.replace(/\\n$/, '')
      return `${ports} [PSH, ACK] Len=${event.frame_bytes}  ${event.raw_frame_repr}`
    case 'LENGTH_PREFIX':
      return `${ports} [PSH, ACK] Len=8  length prefix ${event.raw_frame_repr}`
    default:
      return event.raw_frame_repr.replace(/\\n$/, '')
  }
}

export function hostOf(address: string): string {
  const colon = address.lastIndexOf(':')
  const host = colon === -1 ? address : address.slice(0, colon)
  return host || '0.0.0.0'
}

export function protocolOf(event: TelemetryEvent): string {
  return event.layer === 'L4_TCP' ? 'TCP' : 'NETXFER'
}
