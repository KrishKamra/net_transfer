import { formatBytes, formatEta, formatSpeed, formatTimestamp } from '../lib/format'
import type { SocketState } from '../lib/live'
import { cn } from '../lib/cn'
import { byteSummary, phaseCopy, progressPresentation } from '../lib/transfer-copy'
import type { HistoryRecord, TransferJob } from '../types'
import { Button } from './button'

type Props = {
  jobs: TransferJob[]
  history: HistoryRecord[]
  historyError: string | null
  announcement: string
  socketState: SocketState
  canRetry: (id: string) => boolean
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onClearFinished: () => void
}

export function TransferRail({
  jobs,
  history,
  historyError,
  announcement,
  socketState,
  canRetry,
  onCancel,
  onRetry,
  onClearFinished,
}: Props) {
  const active = jobs.filter((job) => job.status === 'QUEUED' || job.status === 'TRANSFERRING').length
  const finished = jobs.length - active

  return (
    <aside
      className="nt-rail flex min-h-[22rem] w-full flex-col border-t border-line lg:min-h-0 lg:w-[340px] lg:shrink-0 lg:border-t-0 lg:border-l-0"
      aria-label="Transfers"
    >
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-[13px] font-medium">Transfers</h2>
          <p className="font-mono text-[12px] text-muted">{active === 0 ? 'Idle' : `${active} active`}</p>
          <LiveSocket state={socketState} />
        </div>
        {finished > 0 ? (
          <Button variant="ghost" onClick={onClearFinished}>
            Clear
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {jobs.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[15px] font-medium tracking-[-0.02em]">No transfers yet.</p>
            <p className="mx-auto mt-1.5 max-w-[26ch] text-[13px] leading-5 text-muted">
              Upload or download a file. Speed and ETA arrive here while TCP is moving.
            </p>
          </div>
        ) : (
          <ul>
            {jobs.map((job) => (
              <li key={job.id} className="border-b border-line">
                <ProgressCard
                  job={job}
                  canRetry={canRetry(job.id)}
                  onCancel={() => onCancel(job.id)}
                  onRetry={() => onRetry(job.id)}
                />
              </li>
            ))}
          </ul>
        )}

        <section className="border-t border-line" aria-label="Recorded transfers">
          <h3 className="px-4 pt-4 pb-1 text-[13px] font-medium">History</h3>
          {historyError ? (
            <p className="px-4 py-3 text-[13px] text-oxide">{historyError}</p>
          ) : history.length === 0 ? (
            <p className="px-6 py-6 text-center text-[13px] leading-5 text-muted">Nothing recorded for this account.</p>
          ) : (
            <ul>
              {history.map((record) => (
                <li key={record.id} className="nt-card border-t border-line px-4 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate font-mono text-[12px]">{record.filename}</p>
                    <p className="shrink-0 font-mono text-[11px] text-muted">{record.status}</p>
                  </div>
                  <p
                    className="mt-1 font-mono text-[11px] text-muted"
                    title={`${record.bytes_transferred} / ${record.size} bytes`}
                  >
                    {record.direction === 'UPLOAD' ? 'STOR' : 'RETR'}
                    {' · '}
                    {formatBytes(record.bytes_transferred)} / {formatBytes(record.size)}
                    {' · '}
                    {formatTimestamp(record.started_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  )
}

function ProgressCard({
  job,
  canRetry,
  onCancel,
  onRetry,
}: {
  job: TransferJob
  canRetry: boolean
  onCancel: () => void
  onRetry: () => void
}) {
  const progress = progressPresentation(job)
  const live = job.status === 'QUEUED' || job.status === 'TRANSFERRING'
  const percentLabel =
    job.status === 'COMPLETED'
      ? '100%'
      : job.status === 'FAILED'
        ? 'Failed'
        : job.status === 'CANCELLED'
          ? 'Cancelled'
          : job.status === 'QUEUED'
            ? 'Queued'
            : progress.mode === 'indeterminate'
              ? 'TCP'
              : `${progress.percent >= 10 ? progress.percent.toFixed(0) : progress.percent.toFixed(1)}%`

  return (
    <article className="nt-card px-4 py-3" aria-label={`${job.direction === 'UPLOAD' ? 'Upload' : 'Download'} ${job.filename}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate font-mono text-[13px]">
          <span className="mr-2 text-[12px] text-muted">{job.direction === 'UPLOAD' ? 'Up' : 'Down'}</span>
          <span className="sr-only">{job.direction === 'UPLOAD' ? 'Upload' : 'Download'} </span>
          {job.filename}
        </h3>
        <p className={cn('shrink-0 font-mono text-[12px]', statusColor(job.status))}>{percentLabel}</p>
      </div>

      <div
        className="nt-track mt-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.mode === 'determinate' ? Math.round(progress.percent) : undefined}
        aria-valuetext={phaseCopy(job)}
        aria-label={job.filename}
      >
        {progress.mode === 'indeterminate' && live ? (
          <div className="nt-indeterminate" />
        ) : (
          <div className="nt-fill" data-tone={barTone(job.status)} style={{ width: `${progress.percent}%` }} />
        )}
      </div>

      <p className="mt-2 flex gap-3 font-mono text-[11px] text-muted">
        <span className="min-w-0 flex-1 truncate">{byteSummary(job)}</span>
        <span>{formatSpeed(job.speedBps)}</span>
        <span>ETA {formatEta(job.etaSeconds)}</span>
      </p>
      <p className="mt-1 text-[12px] leading-5 text-muted">{phaseCopy(job)}</p>

      {live || canRetry ? (
        <div className="mt-2 flex justify-end gap-1">
          {live ? (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {canRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function LiveSocket({ state }: { state: SocketState }) {
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline'
  const led = state === 'live' ? 'is-ready' : state === 'down' ? 'is-down' : 'is-checking'
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted" title="TCP progress socket">
      <span className={cn('nt-led', led)} aria-hidden="true" />
      {label}
    </span>
  )
}

function statusColor(status: TransferJob['status']): string {
  if (status === 'COMPLETED') return 'text-pine'
  if (status === 'FAILED') return 'text-oxide'
  if (status === 'TRANSFERRING') return 'text-signal'
  return 'text-ink'
}

function barTone(status: TransferJob['status']): string {
  if (status === 'COMPLETED') return 'done'
  if (status === 'FAILED') return 'fail'
  if (status === 'CANCELLED') return 'stop'
  if (status === 'TRANSFERRING') return 'live'
  return 'live'
}
