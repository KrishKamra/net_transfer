import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, deleteFile, endSession, isAbortError, listFiles, transferHistory } from '../lib/api'
import { clearSession } from '../lib/session'
import type { FileItem, HistoryRecord, Session } from '../types'
import { useTelemetrySocket } from '../hooks/use-telemetry-socket'
import { useTransferQueue } from '../hooks/use-transfer-queue'
import { ProtocolInspector } from '../pages/protocol-inspector'
import { Button } from './button'
import { CommandPalette, type Command } from './command-palette'
import { FileExplorer } from './file-explorer'
import { LinkLight, type LinkState } from './link-light'
import { Logo } from './logo'
import { ModeSwitch, SocketBeacon, type Mode } from './mode-switch'
import { TransferRail } from './transfer-rail'

function modeFromHash(): Mode {
  return window.location.hash === '#inspector' ? 'inspector' : 'files'
}

type Props = {
  session: Session
  onLogout: () => void
}

export function Workspace({ session, onLogout }: Props) {
  const [files, setFiles] = useState<FileItem[] | null>(null)
  const [listing, setListing] = useState(true)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryRecord[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  const [uploadToken, setUploadToken] = useState(0)
  const [mode, setModeState] = useState<Mode>(modeFromHash)
  const refreshGeneration = useRef(0)

  // The mode lives in the URL hash so a reload or a shared link keeps it.
  const setMode = useCallback((next: Mode) => {
    setModeState(next)
    const hash = next === 'inspector' ? '#inspector' : ''
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
    }
  }, [])

  useEffect(() => {
    const onHash = () => setModeState(modeFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    setListing(true)
    setFilesError(null)
    try {
      const nextFiles = await listFiles(session)
      if (generation !== refreshGeneration.current) return
      setFiles(nextFiles)
      try {
        const nextHistory = await transferHistory(session)
        if (generation !== refreshGeneration.current) return
        setHistory(nextHistory)
        setHistoryError(null)
      } catch (error) {
        if (generation !== refreshGeneration.current) return
        if (error instanceof ApiError && error.status === 401) throw error
        setHistoryError(error instanceof Error ? error.message : 'Transfer history is unavailable.')
      }
    } catch (error) {
      if (generation !== refreshGeneration.current || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 401) {
        clearSession()
        onLogout()
        return
      }
      setFilesError(
        error instanceof ApiError
          ? error.message
          : 'The control plane on port 8000 did not answer. Start FastAPI and the TCP server on port 2121.',
      )
    } finally {
      if (generation === refreshGeneration.current) setListing(false)
    }
  }, [session, onLogout])

  const transfers = useTransferQueue(session, () => void refresh(), onLogout)
  // Open for the whole session so traffic from the file manager is already
  // buffered when the inspector opens.
  const telemetry = useTelemetrySocket(session)
  const activeTransfers = transfers.jobs.filter(
    (job) => job.status === 'QUEUED' || job.status === 'TRANSFERRING',
  ).length

  useEffect(() => {
    void refresh()
    return () => {
      refreshGeneration.current += 1
    }
  }, [refresh])

  useEffect(() => {
    document.title = mode === 'inspector' ? `Inspector · NetTransfer` : `NetTransfer · ${session.username}`
  }, [session.username, mode])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const link: LinkState = files !== null ? 'ready' : filesError ? 'down' : 'checking'
  const shortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
  const commands: Command[] = [
    mode === 'files'
      ? { id: 'inspector', label: 'Open protocol inspector', hint: 'Live', run: () => setMode('inspector') }
      : { id: 'files', label: 'Open file manager', hint: 'Files', run: () => setMode('files') },
    {
      id: 'upload',
      label: 'Upload files',
      hint: 'STOR',
      run: () => {
        setMode('files')
        setUploadToken((value) => value + 1)
      },
    },
    { id: 'refresh', label: 'Refresh sandbox', hint: 'LIST', run: () => void refresh() },
    { id: 'filter', label: 'Filter files', hint: 'Name', run: () => setFocusToken((value) => value + 1) },
    { id: 'signout', label: 'Sign out', hint: session.username, run: logout },
  ]

  async function removeFile(name: string) {
    setDeleting(name)
    setFilesError(null)
    try {
      await deleteFile(session, name)
      await refresh()
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        clearSession()
        onLogout()
        return
      }
      setFilesError(error instanceof Error ? error.message : 'Could not delete that file.')
    } finally {
      setDeleting(null)
    }
  }

  function logout() {
    transfers.cancelAll()
    void endSession(session)
    clearSession()
    onLogout()
  }

  return (
    <div className="flex min-h-dvh flex-col bg-surface lg:h-dvh">
      <header className="nt-chrome flex h-14 shrink-0 items-center justify-between gap-4 px-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3 lg:w-[240px]">
          <Logo size={26} />
          <div className="min-w-0">
            <p className="text-[15px] leading-none font-medium tracking-[-0.03em]">NetTransfer</p>
            <div className="mt-1">
              <LinkLight state={link} />
            </div>
          </div>
        </div>
        <ModeSwitch mode={mode} activeTransfers={activeTransfers} onChange={setMode} />
        <div className="flex items-center justify-end gap-1.5 lg:w-[240px] lg:shrink-0 xl:w-auto">
          <SocketBeacon state={telemetry.state} tapAttached={telemetry.tapAttached} />
          <p className="nt-account hidden font-mono text-[12px] sm:block">{session.username}</p>
          <Button variant="ghost" className="hidden sm:inline-flex" onClick={() => setPaletteOpen(true)} title="Open commands">
            <span className="font-mono text-[11px] text-muted">{shortcut}</span>
          </Button>
          <Button variant="ghost" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      {mode === 'inspector' ? (
        <main className="flex min-h-0 flex-1 flex-col">
          <ProtocolInspector
            telemetry={telemetry}
            onUpload={transfers.uploadFiles}
            onOpenFiles={() => setMode('files')}
          />
        </main>
      ) : null}

      {/* Kept mounted while hidden so the filter and upload picker keep their state. */}
      <main className="flex min-h-0 flex-1 flex-col lg:flex-row" hidden={mode !== 'files'}>
        <FileExplorer
          username={session.username}
          files={files}
          listing={listing}
          error={filesError}
          busyNames={transfers.busyNames}
          deleting={deleting}
          focusToken={focusToken}
          uploadToken={uploadToken}
          onRefresh={() => void refresh()}
          onUpload={transfers.uploadFiles}
          onDownload={transfers.download}
          onDelete={(name) => void removeFile(name)}
        />
        <TransferRail
          jobs={transfers.jobs}
          history={history}
          historyError={historyError}
          announcement={transfers.announcement}
          socketState={transfers.socketState}
          canRetry={transfers.canRetry}
          onCancel={transfers.cancel}
          onRetry={transfers.retry}
          onClearFinished={transfers.clearFinished}
        />
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  )
}
