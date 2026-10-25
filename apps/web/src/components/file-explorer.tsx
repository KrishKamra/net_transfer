import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Download, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { formatBytes } from '../lib/format'
import { cn } from '../lib/cn'
import type { FileItem } from '../types'
import { Button } from './button'
import { Logo } from './logo'
import { SignalLoader } from './signal-loader'

type Props = {
  username: string
  files: FileItem[] | null
  listing: boolean
  error: string | null
  busyNames: string[]
  deleting: string | null
  focusToken: number
  uploadToken: number
  onRefresh: () => void
  onUpload: (files: File[]) => void
  onDownload: (name: string) => void
  onDelete: (name: string) => void
}

export function FileExplorer({
  username,
  files,
  listing,
  error,
  busyNames,
  deleting,
  focusToken,
  uploadToken,
  onRefresh,
  onUpload,
  onDownload,
  onDelete,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const desktopFilterRef = useRef<HTMLInputElement>(null)
  const mobileFilterRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const dragDepth = useRef(0)

  useEffect(() => {
    if (focusToken === 0) return
    const wide = window.matchMedia('(min-width: 768px)').matches
    const field = wide ? desktopFilterRef.current : mobileFilterRef.current
    field?.focus()
  }, [focusToken])

  useEffect(() => {
    if (uploadToken > 0) fileRef.current?.click()
  }, [uploadToken])

  const inventory = files ?? []
  const needle = query.trim().toLowerCase()
  const visible = needle ? inventory.filter((item) => item.name.toLowerCase().includes(needle)) : inventory
  const fileCount = inventory.filter((item) => !item.is_dir).length
  const totalBytes = inventory.reduce((sum, item) => sum + (item.is_dir ? 0 : item.size), 0)
  const busy = new Set(busyNames)

  function takeFiles(list: FileList | null) {
    const next = list ? Array.from(list) : []
    if (next.length === 0) return
    onUpload(next)
  }

  function onDragEnter(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    takeFiles(event.dataTransfer.files)
  }

  const summary =
    files === null
      ? error
        ? 'Listing unavailable'
        : 'Reading directory'
      : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${formatBytes(totalBytes)}`

  return (
    <section
      className="nt-files relative flex min-h-[28rem] min-w-0 flex-1 flex-col lg:min-h-0"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      aria-label="Sandbox"
    >
      <header className="nt-mast flex shrink-0 items-center gap-4 border-b border-line px-4 sm:px-5">
        <div className="min-w-0 py-2.5">
          <nav aria-label="Sandbox path">
            <ol className="flex items-center gap-1.5 font-mono text-[13px]">
              <li>
                <button
                  type="button"
                  className="text-muted transition-colors duration-150 hover:text-signal"
                  onClick={() => {
                    setQuery('')
                    onRefresh()
                  }}
                >
                  sandbox
                </button>
              </li>
              <li aria-hidden="true" className="text-line-strong">
                /
              </li>
              <li className="truncate font-medium tracking-[-0.01em]">
                <span aria-current="page">{username}</span>
              </li>
            </ol>
          </nav>
          <p className="mt-0.5 truncate font-mono text-[12px] text-muted">{summary}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="relative hidden md:block">
            <span className="sr-only">Filter files by name</span>
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              ref={desktopFilterRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter"
              className="nt-field nt-field-icon h-8 w-44"
              autoComplete="off"
            />
          </label>
          <Button onClick={onRefresh} disabled={listing} aria-busy={listing} title="Reload the sandbox listing">
            <RefreshCw className={cn('size-3.5', listing && 'motion-safe:animate-spin')} aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <Button variant="primary" onClick={() => fileRef.current?.click()}>
            <Upload className="size-3.5" aria-hidden="true" />
            Upload
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              takeFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </div>
      </header>

      <div className="border-b border-line px-4 py-2 md:hidden">
        <label className="relative block">
          <span className="sr-only">Filter files by name</span>
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input
            ref={mobileFilterRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
            className="nt-field nt-field-icon h-8"
            autoComplete="off"
          />
        </label>
      </div>

      {error && files ? (
        <p role="alert" className="border-b border-line px-4 py-2 text-[13px] text-oxide">
          {error}
        </p>
      ) : null}

      {dragging ? (
        <div className="nt-drop pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg">
          <p className="text-[13px] font-medium">Drop to upload</p>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {files === null && !error ? (
          <SkeletonRows />
        ) : files === null && error ? (
          <ListingFailure message={error} onRetry={onRefresh} />
        ) : visible.length === 0 ? (
          <EmptyState filtered={needle.length > 0} query={query.trim()} onUpload={() => fileRef.current?.click()} />
        ) : (
          <table className="w-full min-w-[560px] border-collapse text-left">
            <caption className="sr-only">Files in {username}&apos;s sandbox</caption>
            <thead className="nt-cols">
              <tr className="border-b border-line text-[12px] text-muted">
                <th scope="col" className="px-4 py-2 font-medium">Name</th>
                <th scope="col" className="w-24 px-3 py-2 font-medium">Kind</th>
                <th scope="col" className="w-28 px-3 py-2 text-right font-medium">Size</th>
                <th scope="col" className="w-40 px-4 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const confirming = pendingDelete === item.name
                const rowBusy = busy.has(item.name) || deleting === item.name
                return (
                  <tr key={item.name} className="nt-row border-b border-line last:border-b-0">
                    <th scope="row" className="max-w-0 px-4 py-2 text-left font-mono text-[13px] font-normal">
                      <span className="block truncate">{item.name}</span>
                    </th>
                    <td className="px-3 py-2 text-[12px] text-muted">{item.is_dir ? 'Folder' : 'File'}</td>
                    <td className="px-3 py-2 text-right font-mono text-[12px]" title={`${item.size} bytes`}>
                      {item.is_dir ? '—' : formatBytes(item.size)}
                    </td>
                    <td className="px-4 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        {item.is_dir ? (
                          <span className="text-[12px] text-muted">Not listed inside</span>
                        ) : confirming ? (
                          <>
                            <span className="mr-1 text-[12px] text-oxide">Delete this file?</span>
                            <Button
                              variant="danger"
                              disabled={deleting === item.name}
                              onClick={() => onDelete(item.name)}
                            >
                              {deleting === item.name ? 'Deleting…' : 'Delete'}
                            </Button>
                            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                              Keep
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              disabled={rowBusy}
                              title={rowBusy ? 'A transfer for this file is already running.' : 'Download with RETR'}
                              onClick={() => onDownload(item.name)}
                            >
                              <Download className="size-3.5" aria-hidden="true" />
                              Download
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={rowBusy}
                              aria-label={`Delete ${item.name}`}
                              title="Delete from the sandbox"
                              onClick={() => setPendingDelete(item.name)}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

function SkeletonRows() {
  return (
    <div className="nt-stage-note" aria-hidden="true">
      <div className="flex flex-col items-center gap-3 text-[13px] text-muted">
        <SignalLoader />
        Reading directory
      </div>
    </div>
  )
}

function ListingFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="nt-stage-note">
      <div className="nt-plate nt-rise w-full max-w-[380px] rounded-lg px-8 py-8 text-center">
        <p role="alert" className="text-[15px] leading-6 font-medium tracking-[-0.02em] text-oxide">
          {message}
        </p>
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Try again
        </Button>
      </div>
    </div>
  )
}

function EmptyState({
  filtered,
  query,
  onUpload,
}: {
  filtered: boolean
  query: string
  onUpload: () => void
}) {
  return (
    <div className="nt-stage-note">
      {filtered ? (
        <p className="text-center text-[14px] leading-6">
          No files match <span className="font-mono">{query}</span>.
        </p>
      ) : (
        <div className="nt-plate nt-rise w-full max-w-[360px] rounded-lg px-8 py-9 text-center">
          <Logo size={40} className="mx-auto" title="NetTransfer" />
          <p className="mt-5 text-[20px] leading-7 font-medium tracking-[-0.03em]">This sandbox is empty.</p>
          <p className="mx-auto mt-2 max-w-[28ch] text-[13px] leading-5 text-muted">
            Upload a file to open a STOR stream into this account.
          </p>
          <Button variant="primary" className="mt-6 h-9 px-4" onClick={onUpload}>
            <Upload className="size-3.5" aria-hidden="true" />
            Upload
          </Button>
        </div>
      )}
    </div>
  )
}
