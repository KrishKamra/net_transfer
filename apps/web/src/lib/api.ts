import type { AuthResult, FileItem, HistoryRecord, Session } from '../types'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export type WirePhase = 'control-plane' | 'tcp'

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function detailMessage(detail: unknown): string | null {
  if (typeof detail === 'string' && detail.trim()) return detail
  if (!Array.isArray(detail)) return null
  const parts = detail
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'msg' in item && typeof item.msg === 'string') {
        return item.msg
      }
      return null
    })
    .filter((part): part is string => Boolean(part))
  return parts.length ? parts.join(' ') : null
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return new ApiError(
      response.status,
      'The control plane on port 8000 did not answer. Start FastAPI and the TCP server on port 2121.',
    )
  }
  try {
    const data = (await response.json()) as { detail?: unknown }
    return new ApiError(
      response.status,
      detailMessage(data.detail) ?? `Request failed (${response.status}).`,
    )
  } catch {
    return new ApiError(response.status, `Request failed (${response.status}).`)
  }
}

function authHeaders(session: Session): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${session.accessToken}`)
  return headers
}

export async function endSession(session: Session): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders(session) })
  } catch {
    // The tab is leaving either way. A failed logout only leaves the TCP
    // password in server memory until the token expires.
  }
}

async function postAuth(path: string, username: string, password: string): Promise<AuthResult> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  } catch {
    throw new ApiError(0, 'The control plane on port 8000 did not answer.')
  }
  if (!response.ok) throw await errorFromResponse(response)
  return (await response.json()) as AuthResult
}

export function login(username: string, password: string): Promise<AuthResult> {
  return postAuth('/api/auth/login', username, password)
}

export function register(username: string, password: string): Promise<AuthResult> {
  return postAuth('/api/auth/register', username, password)
}

export async function listFiles(session: Session, signal?: AbortSignal): Promise<FileItem[]> {
  const response = await fetch('/api/files', {
    headers: authHeaders(session),
    signal,
  })
  if (!response.ok) throw await errorFromResponse(response)
  return (await response.json()) as FileItem[]
}

export async function deleteFile(session: Session, filename: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: authHeaders(session),
  })
  if (!response.ok) throw await errorFromResponse(response)
}

export async function transferHistory(
  session: Session,
  signal?: AbortSignal,
): Promise<HistoryRecord[]> {
  const response = await fetch('/api/transfers/history', {
    headers: authHeaders(session),
    signal,
  })
  if (!response.ok) throw await errorFromResponse(response)
  return (await response.json()) as HistoryRecord[]
}

function readXhrError(xhr: XMLHttpRequest): string {
  if (xhr.status === 0) return 'The control plane did not accept the upload.'
  try {
    const data = JSON.parse(xhr.responseText) as { detail?: unknown }
    return detailMessage(data.detail) ?? `Upload failed (${xhr.status}).`
  } catch {
    return `Upload failed (${xhr.status}).`
  }
}

export function uploadFile(
  file: File,
  session: Session,
  transferId: string,
  onProgress: (loaded: number, total: number, phase: WirePhase) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'))
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/transfers/upload')
    xhr.setRequestHeader('Authorization', `Bearer ${session.accessToken}`)
    xhr.setRequestHeader('X-Transfer-Id', transferId)

    const report = (loaded: number, total: number, phase: WirePhase) => {
      if (!signal.aborted) onProgress(loaded, total, phase)
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return
      const ratio = event.loaded / event.total
      const logicalLoaded = Math.min(file.size, Math.round(ratio * file.size))
      report(logicalLoaded, file.size, ratio >= 1 ? 'tcp' : 'control-plane')
    }
    xhr.upload.onload = () => {
      report(file.size, file.size, 'tcp')
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      reject(new ApiError(xhr.status, readXhrError(xhr)))
    }
    xhr.onerror = () => {
      reject(new ApiError(0, 'The control plane did not accept the upload.'))
    }
    xhr.onabort = () => {
      reject(new DOMException('Upload cancelled.', 'AbortError'))
    }

    const abort = () => xhr.abort()
    signal.addEventListener('abort', abort, { once: true })
    xhr.addEventListener('loadend', () => signal.removeEventListener('abort', abort))

    const body = new FormData()
    body.append('file', file, file.name)
    xhr.send(body)
  })
}

export async function downloadFile(
  filename: string,
  session: Session,
  transferId: string,
  onProgress: (loaded: number, total: number, phase: WirePhase) => void,
  signal: AbortSignal,
): Promise<void> {
  onProgress(0, 0, 'tcp')

  const headers = authHeaders(session)
  headers.set('X-Transfer-Id', transferId)

  const response = await fetch(`/api/transfers/download/${encodeURIComponent(filename)}`, {
    headers,
    signal,
  })
  if (!response.ok) throw await errorFromResponse(response)

  const totalHeader = Number(response.headers.get('Content-Length') ?? '0')
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0
  const reader = response.body?.getReader()
  if (!reader) throw new ApiError(response.status, 'The download stream was empty.')

  const chunks: BlobPart[] = []
  let received = 0
  onProgress(0, total, 'control-plane')

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value.slice())
    received += value.byteLength
    onProgress(received, total || received, 'control-plane')
  }

  const blob = new Blob(chunks, { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
