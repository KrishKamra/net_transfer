export type AuthResult = {
  access_token: string
  token_type: string
  username: string
  user_id: number
}

export type Session = {
  accessToken: string
  username: string
  userId: number
}

export type FileItem = {
  name: string
  size: number
  is_dir: boolean
}

export type HistoryRecord = {
  id: string
  filename: string
  direction: 'UPLOAD' | 'DOWNLOAD'
  size: number
  bytes_transferred: number
  status: string
  started_at: string
  completed_at: string | null
}

export type TransferDirection = 'UPLOAD' | 'DOWNLOAD'

export type TransferStatus = 'QUEUED' | 'TRANSFERRING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

export type TransferPhase = 'queued' | 'control-plane' | 'tcp' | 'done'

export type TransferJob = {
  id: string
  filename: string
  direction: TransferDirection
  totalBytes: number
  transferredBytes: number
  speedBps: number
  etaSeconds: number | null
  status: TransferStatus
  phase: TransferPhase
  error?: string
  startedAt: number
  finishedAt?: number
}
