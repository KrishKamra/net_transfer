export type LiveTransfer = {
  type: 'transfer'
  transfer_id: string
  filename: string
  direction: 'UPLOAD' | 'DOWNLOAD'
  total_bytes: number
  transferred_bytes: number
  progress_pct: number
  speed_bps: number
  speed_mbps: number
  eta_seconds: number | null
  status: string
}

export type SocketState = 'connecting' | 'live' | 'down'

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/transfers`
}

export function openTransferSocket(
  token: string,
  onTransfer: (event: LiveTransfer) => void,
  onState: (state: SocketState) => void,
): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let authed = false
  let retryTimer = 0
  let retryMs = 500

  const connect = () => {
    if (stopped) return
    onState('connecting')
    authed = false
    const next = new WebSocket(socketUrl())
    socket = next

    next.onopen = () => {
      if (stopped || socket !== next) return
      next.send(JSON.stringify({ type: 'auth', token }))
    }

    next.onmessage = (message) => {
      if (typeof message.data !== 'string') return
      try {
        const payload = JSON.parse(message.data) as { type?: string }
        if (payload.type === 'ready') {
          authed = true
          retryMs = 500
          onState('live')
          return
        }
        if (payload.type === 'transfer') onTransfer(payload as LiveTransfer)
      } catch {
        // Ignore a frame that is not a transfer snapshot.
      }
    }

    next.onerror = () => {
      next.close()
    }

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
    if (authed && socket?.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}')
  }, 25000)

  return () => {
    stopped = true
    window.clearTimeout(retryTimer)
    window.clearInterval(pingTimer)
    socket?.close()
    socket = null
  }
}
