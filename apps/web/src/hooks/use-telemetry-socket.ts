import { useCallback, useEffect, useRef, useState } from 'react'
import {
  eventKey,
  openTelemetrySocket,
  type TelemetryEvent,
  type TelemetryFrame,
  type TelemetrySocketState,
} from '../lib/telemetry'
import type { Session } from '../types'

/** Frames kept in the browser. The server ring only replays the last 100. */
export const TELEMETRY_BUFFER = 5000

export type Telemetry = {
  events: TelemetryEvent[]
  state: TelemetrySocketState
  /** null until the first `ready` frame says whether port 2121 is linked. */
  tapAttached: boolean | null
  /** Frames that fell off the front of the buffer since the last clear. */
  trimmed: number
  clear: () => void
}

/**
 * Keeps /ws/telemetry open for the whole signed-in session, so traffic from
 * the file manager is already buffered when the inspector opens.
 *
 * Frames can arrive thousands per second during a large STOR. They are
 * collected in a ref and committed to React state once per animation frame.
 */
export function useTelemetrySocket(session: Session): Telemetry {
  const [events, setEvents] = useState<TelemetryEvent[]>([])
  const [state, setState] = useState<TelemetrySocketState>('connecting')
  const [tapAttached, setTapAttached] = useState<boolean | null>(null)
  const [trimmed, setTrimmed] = useState(0)

  const buffer = useRef<TelemetryEvent[]>([])
  const seen = useRef(new Set<string>())
  const inbox = useRef<TelemetryEvent[]>([])
  const frame = useRef(0)

  const flush = useCallback(() => {
    frame.current = 0
    const incoming = inbox.current
    if (incoming.length === 0) return
    inbox.current = []

    const fresh: TelemetryEvent[] = []
    for (const event of incoming) {
      const key = eventKey(event)
      if (seen.current.has(key)) continue
      seen.current.add(key)
      fresh.push(event)
    }
    if (fresh.length === 0) return
    let next = buffer.current.concat(fresh)

    const overflow = next.length - TELEMETRY_BUFFER
    if (overflow > 0) {
      for (const dropped of next.slice(0, overflow)) seen.current.delete(eventKey(dropped))
      next = next.slice(overflow)
      setTrimmed((value) => value + overflow)
    }
    if (seen.current.size > TELEMETRY_BUFFER * 4) seen.current = new Set(next.map(eventKey))
    buffer.current = next
    setEvents(next)
  }, [])

  const take = useCallback(
    (list: TelemetryEvent[]) => {
      if (list.length === 0) return
      inbox.current.push(...list)
      if (!frame.current) frame.current = window.requestAnimationFrame(flush)
    },
    [flush],
  )

  useEffect(() => {
    const onFrame = (message: TelemetryFrame) => {
      if (message.type === 'ready') {
        setTapAttached(message.tap_attached)
        take(message.events)
      } else if (message.type === 'events') {
        take(message.events)
      } else if (message.type === 'tap') {
        setTapAttached(message.attached)
      }
    }
    const close = openTelemetrySocket(session.accessToken, onFrame, setState)
    return () => {
      close()
      if (frame.current) window.cancelAnimationFrame(frame.current)
      frame.current = 0
    }
  }, [session.accessToken, take])

  const clear = useCallback(() => {
    inbox.current = []
    buffer.current = []
    setEvents([])
    setTrimmed(0)
    // Keys stay in `seen` so a reconnect backlog does not refill a cleared view.
  }, [])

  return { events, state, tapAttached, trimmed, clear }
}
