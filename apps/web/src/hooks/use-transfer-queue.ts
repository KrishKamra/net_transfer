import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, downloadFile, isAbortError, uploadFile, type WirePhase } from '../lib/api'
import { storFilenameError } from '../lib/filenames'
import { openTransferSocket, type LiveTransfer, type SocketState } from '../lib/live'
import type { Session, TransferDirection, TransferJob, TransferStatus } from '../types'

type Sample = { at: number; bytes: number }
type Task = { id: string; run: () => Promise<void> }

function createJob(filename: string, direction: TransferDirection, totalBytes: number): TransferJob {
  return {
    id: crypto.randomUUID(),
    filename,
    direction,
    totalBytes,
    transferredBytes: 0,
    speedBps: 0,
    etaSeconds: null,
    status: 'QUEUED',
    phase: 'queued',
    startedAt: performance.now(),
  }
}

export function useTransferQueue(
  session: Session,
  onSuccess: () => void,
  onAuthFailure: () => void,
) {
  const [jobs, setJobs] = useState<TransferJob[]>([])
  const [announcement, setAnnouncement] = useState('')
  const [socketState, setSocketState] = useState<SocketState>('connecting')
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  const sessionRef = useRef(session)
  sessionRef.current = session
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess
  const onAuthRef = useRef(onAuthFailure)
  onAuthRef.current = onAuthFailure

  const samples = useRef(new Map<string, Sample>())
  const liveSeen = useRef(new Set<string>())
  const painted = useRef(new Map<string, number>())
  const queue = useRef<Task[]>([])
  const draining = useRef(false)
  const cancelled = useRef(new Set<string>())
  const controllers = useRef(new Map<string, AbortController>())
  const files = useRef(new Map<string, File>())

  const patch = useCallback((id: string, updater: (job: TransferJob) => TransferJob) => {
    setJobs((current) => current.map((job) => (job.id === id ? updater(job) : job)))
  }, [])

  const applyLive = useCallback((event: LiveTransfer) => {
    liveSeen.current.add(event.transfer_id)
    const terminal = event.status === 'COMPLETED' || event.status === 'FAILED' || event.status === 'CANCELLED'
    const status = (['QUEUED', 'TRANSFERRING', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(event.status)
      ? event.status
      : 'TRANSFERRING') as TransferStatus

    setJobs((current) => {
      const existing = current.find((job) => job.id === event.transfer_id)
      if (!existing) {
        if (terminal) return current
        const created: TransferJob = {
          id: event.transfer_id,
          filename: event.filename,
          direction: event.direction,
          totalBytes: event.total_bytes,
          transferredBytes: event.transferred_bytes,
          speedBps: event.speed_bps,
          etaSeconds: event.eta_seconds,
          status,
          phase: 'tcp',
          startedAt: performance.now(),
        }
        return [created, ...current]
      }
      return current.map((job) => {
        if (job.id !== event.transfer_id) return job
        if (job.status === 'CANCELLED' || job.status === 'COMPLETED') return job
        return {
          ...job,
          filename: event.filename || job.filename,
          totalBytes: event.total_bytes || job.totalBytes,
          transferredBytes: event.transferred_bytes,
          speedBps: event.speed_bps,
          etaSeconds: event.eta_seconds,
          status,
          phase: terminal ? 'done' : 'tcp',
          error: status === 'FAILED' ? job.error || 'The TCP transfer failed.' : job.error,
          finishedAt: terminal ? job.finishedAt ?? performance.now() : job.finishedAt,
        }
      })
    })
  }, [])

  useEffect(() => {
    return openTransferSocket(session.accessToken, applyLive, setSocketState)
  }, [session.accessToken, applyLive])

  const applyProgress = useCallback(
    (id: string, loaded: number, total: number, phase: WirePhase) => {
      if (liveSeen.current.has(id)) return
      const now = performance.now()
      if (phase === 'tcp') {
        samples.current.delete(id)
        painted.current.set(id, now)
        patch(id, (job) => ({
          ...job,
          status: 'TRANSFERRING',
          phase: 'tcp',
          transferredBytes: loaded,
          totalBytes: total || job.totalBytes,
          speedBps: 0,
          etaSeconds: null,
        }))
        return
      }

      const lastPaint = painted.current.get(id) ?? 0
      const complete = total > 0 && loaded >= total
      if (!complete && now - lastPaint < 100) return
      painted.current.set(id, now)

      const sample = samples.current.get(id)
      let speed = 0
      let hasSpeed = false
      if (sample && (now - sample.at >= 250 || complete)) {
        const dt = (now - sample.at) / 1000
        const delta = loaded - sample.bytes
        if (dt > 0 && delta >= 0) {
          speed = delta / dt
          hasSpeed = true
        }
        samples.current.set(id, { at: now, bytes: loaded })
      } else if (!sample) {
        samples.current.set(id, { at: now, bytes: loaded })
      }

      patch(id, (job) => {
        const nextSpeed = hasSpeed ? speed : job.speedBps
        const remaining = Math.max((total || job.totalBytes) - loaded, 0)
        const eta = nextSpeed > 0 && remaining > 0 ? remaining / nextSpeed : remaining === 0 ? 0 : null
        return {
          ...job,
          status: 'TRANSFERRING',
          phase: 'control-plane',
          transferredBytes: loaded,
          totalBytes: total || job.totalBytes,
          speedBps: nextSpeed,
          etaSeconds: eta,
        }
      })
    },
    [patch],
  )

  const failJob = useCallback(
    (id: string, filename: string, direction: TransferDirection, error: unknown) => {
      if (isAbortError(error) || cancelled.current.has(id)) {
        patch(id, (job) => ({
          ...job,
          status: 'CANCELLED',
          phase: 'done',
          speedBps: 0,
          etaSeconds: null,
          finishedAt: performance.now(),
        }))
        return
      }
      const message = error instanceof Error ? error.message : 'Transfer failed.'
      if (error instanceof ApiError && error.status === 401) onAuthRef.current()
      patch(id, (job) => ({
        ...job,
        status: 'FAILED',
        phase: 'done',
        error: message,
        speedBps: 0,
        etaSeconds: null,
        finishedAt: performance.now(),
      }))
      const verb = direction === 'UPLOAD' ? 'Upload' : 'Download'
      setAnnouncement(`${verb} of ${filename} failed. ${message}`)
    },
    [patch],
  )

  const drain = useCallback(async () => {
    if (draining.current) return
    draining.current = true
    try {
      while (queue.current.length > 0) {
        const task = queue.current.shift()
        if (!task || cancelled.current.has(task.id)) continue
        await task.run()
      }
    } finally {
      draining.current = false
      if (queue.current.some((task) => !cancelled.current.has(task.id))) void drain()
    }
  }, [])

  const enqueue = useCallback(
    (task: Task) => {
      queue.current.push(task)
      void drain()
    },
    [drain],
  )

  const runUpload = useCallback(
    (job: TransferJob, file: File) => {
      enqueue({
        id: job.id,
        run: async () => {
          if (cancelled.current.has(job.id)) return
          const controller = new AbortController()
          controllers.current.set(job.id, controller)
          if (cancelled.current.has(job.id)) {
            controller.abort()
            return
          }
          patch(job.id, (current) => ({
            ...current,
            status: 'TRANSFERRING',
            phase: 'control-plane',
          }))
          setAnnouncement(`Upload of ${file.name} started.`)
          try {
            await uploadFile(
              file,
              sessionRef.current,
              job.id,
              (loaded, total, phase) => {
                if (!cancelled.current.has(job.id)) applyProgress(job.id, loaded, total, phase)
              },
              controller.signal,
            )
            if (cancelled.current.has(job.id)) return
            patch(job.id, (current) => ({
              ...current,
              status: 'COMPLETED',
              phase: 'done',
              transferredBytes: file.size,
              totalBytes: file.size,
              speedBps: 0,
              etaSeconds: 0,
              finishedAt: performance.now(),
            }))
            setAnnouncement(`Upload of ${file.name} complete.`)
            onSuccessRef.current()
          } catch (error) {
            failJob(job.id, file.name, 'UPLOAD', error)
          } finally {
            controllers.current.delete(job.id)
          }
        },
      })
    },
    [applyProgress, enqueue, failJob, patch],
  )

  const uploadFiles = useCallback(
    (list: File[]) => {
      if (list.length === 0) return
      const accepted: Array<{ job: TransferJob; file: File }> = []
      const rejected: TransferJob[] = []

      for (const file of list) {
        const job = createJob(file.name, 'UPLOAD', file.size)
        const problem = storFilenameError(file.name)
        if (problem) {
          rejected.push({
            ...job,
            status: 'FAILED',
            phase: 'done',
            error: problem,
            finishedAt: performance.now(),
          })
          continue
        }
        files.current.set(job.id, file)
        accepted.push({ job, file })
      }

      setJobs((current) => [...rejected, ...accepted.map((item) => item.job), ...current])

      if (rejected.length && accepted.length) {
        setAnnouncement(
          `${accepted.length} upload${accepted.length === 1 ? '' : 's'} queued. ${rejected.length} rejected.`,
        )
      } else if (rejected.length === 1) {
        setAnnouncement(`${rejected[0].filename} was not uploaded. ${rejected[0].error ?? ''}`)
      } else if (rejected.length > 1) {
        setAnnouncement(`${rejected.length} files were rejected. STOR needs a single filename token.`)
      } else if (accepted.length === 1) {
        setAnnouncement(`Upload of ${accepted[0].file.name} queued.`)
      } else {
        setAnnouncement(`${accepted.length} uploads queued.`)
      }

      for (const item of accepted) runUpload(item.job, item.file)
    },
    [runUpload],
  )

  const download = useCallback(
    (filename: string) => {
      const job = createJob(filename, 'DOWNLOAD', 0)
      setJobs((current) => [job, ...current])
      setAnnouncement(`Download of ${filename} queued.`)
      enqueue({
        id: job.id,
        run: async () => {
          if (cancelled.current.has(job.id)) return
          const controller = new AbortController()
          controllers.current.set(job.id, controller)
          if (cancelled.current.has(job.id)) {
            controller.abort()
            return
          }
          patch(job.id, (current) => ({ ...current, status: 'TRANSFERRING', phase: 'tcp' }))
          setAnnouncement(`Download of ${filename} started.`)
          try {
            await downloadFile(
              filename,
              sessionRef.current,
              job.id,
              (loaded, total, phase) => {
                if (!cancelled.current.has(job.id)) applyProgress(job.id, loaded, total, phase)
              },
              controller.signal,
            )
            if (cancelled.current.has(job.id)) return
            patch(job.id, (current) => ({
              ...current,
              status: 'COMPLETED',
              phase: 'done',
              transferredBytes: current.totalBytes || current.transferredBytes,
              speedBps: 0,
              etaSeconds: 0,
              finishedAt: performance.now(),
            }))
            setAnnouncement(`Download of ${filename} complete.`)
            onSuccessRef.current()
          } catch (error) {
            failJob(job.id, filename, 'DOWNLOAD', error)
          } finally {
            controllers.current.delete(job.id)
          }
        },
      })
    },
    [applyProgress, enqueue, failJob, patch],
  )

  const cancel = useCallback((id: string) => {
    const job = jobsRef.current.find((item) => item.id === id)
    if (!job || job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
      return
    }
    cancelled.current.add(id)
    controllers.current.get(id)?.abort()
    queue.current = queue.current.filter((task) => task.id !== id)
    patch(id, (current) => ({
      ...current,
      status: 'CANCELLED',
      phase: 'done',
      speedBps: 0,
      etaSeconds: null,
      finishedAt: performance.now(),
    }))
    setAnnouncement(`${job.filename} cancelled.`)
  }, [patch])

  const retry = useCallback(
    (id: string) => {
      const job = jobsRef.current.find((item) => item.id === id)
      if (!job || (job.status !== 'FAILED' && job.status !== 'CANCELLED')) return
      if (job.direction === 'DOWNLOAD') {
        download(job.filename)
        return
      }
      const file = files.current.get(id)
      if (!file || storFilenameError(file.name)) return
      uploadFiles([file])
    },
    [download, uploadFiles],
  )

  const canRetry = useCallback((id: string) => {
    const job = jobsRef.current.find((item) => item.id === id)
    if (!job || (job.status !== 'FAILED' && job.status !== 'CANCELLED')) return false
    if (job.direction === 'DOWNLOAD') return true
    const file = files.current.get(id)
    return Boolean(file) && !storFilenameError(file?.name ?? '')
  }, [])

  const clearFinished = useCallback(() => {
    setJobs((current) =>
      current.filter((job) => job.status === 'QUEUED' || job.status === 'TRANSFERRING'),
    )
  }, [])

  const cancelAll = useCallback(() => {
    for (const controller of controllers.current.values()) controller.abort()
    for (const job of jobsRef.current) cancelled.current.add(job.id)
    queue.current = []
  }, [])

  const busyNames = jobs
    .filter((job) => job.status === 'QUEUED' || job.status === 'TRANSFERRING')
    .map((job) => job.filename)

  return {
    jobs,
    announcement,
    busyNames,
    uploadFiles,
    download,
    socketState,
    cancel,
    retry,
    canRetry,
    clearFinished,
    cancelAll,
  }
}
