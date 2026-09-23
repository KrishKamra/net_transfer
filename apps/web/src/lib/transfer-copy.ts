import { formatBytes, formatDuration } from './format'
import type { TransferJob } from '../types'

export function phaseCopy(job: TransferJob): string {
  if (job.status === 'FAILED') return job.error || 'Transfer failed.'
  if (job.status === 'CANCELLED') return 'Cancelled.'
  if (job.status === 'QUEUED') return 'Waiting for the TCP session.'
  if (job.status === 'COMPLETED') {
    const verb = job.direction === 'UPLOAD' ? 'STOR complete' : 'RETR complete'
    if (!job.finishedAt) return verb
    return `${verb} in ${formatDuration(job.finishedAt - job.startedAt)}`
  }
  if (job.direction === 'UPLOAD' && job.phase === 'control-plane') {
    return 'Sending to the control plane.'
  }
  if (job.direction === 'UPLOAD' && job.phase === 'tcp') {
    return 'STOR on TCP 2121.'
  }
  if (job.direction === 'DOWNLOAD' && job.phase === 'tcp') {
    return 'RETR on TCP 2121.'
  }
  if (job.direction === 'DOWNLOAD' && job.phase === 'control-plane') {
    return 'Receiving from the control plane.'
  }
  return 'Transferring.'
}

export function byteSummary(job: TransferJob): string {
  if (job.status === 'QUEUED') return formatBytes(job.totalBytes)
  if (job.phase === 'tcp' && job.status === 'TRANSFERRING' && job.transferredBytes <= 0) {
    return job.direction === 'UPLOAD'
      ? `${formatBytes(job.totalBytes)} buffered · awaiting STOR`
      : 'Awaiting RETR'
  }
  if (job.totalBytes <= 0) return formatBytes(job.transferredBytes)
  return `${formatBytes(job.transferredBytes)} / ${formatBytes(job.totalBytes)}`
}

export function progressPresentation(job: TransferJob): {
  mode: 'determinate' | 'indeterminate'
  percent: number
} {
  if (job.status === 'COMPLETED') return { mode: 'determinate', percent: 100 }
  if (
    job.status === 'QUEUED' ||
    (job.status === 'TRANSFERRING' && job.phase === 'tcp' && job.transferredBytes <= 0)
  ) {
    return { mode: 'indeterminate', percent: 0 }
  }
  if (job.totalBytes <= 0) return { mode: 'indeterminate', percent: 0 }
  const percent = Math.max(0, Math.min(100, (job.transferredBytes / job.totalBytes) * 100))
  return { mode: 'determinate', percent }
}
