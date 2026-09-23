import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, deleteFile, endSession, isAbortError, listFiles, transferHistory } from '../lib/api'
import { clearSession } from '../lib/session'
import type { FileItem, HistoryRecord, Session } from '../types'
import { useTransferQueue } from '../hooks/use-transfer-queue'
import { Button } from './button'
import { CommandPalette, type Command } from './command-palette'
import { FileExplorer } from './file-explorer'
import { LinkLight, type LinkState } from './link-light'
import { Logo } from './logo'
import { TransferRail } from './transfer-rail'

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
  const refreshGeneration = useRef(0)

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

  useEffect(() => {
    void refresh()
    return () => {
      refreshGeneration.current += 1
    }
  }, [refresh])

  useEffect(() => {
    document.title = `NetTransfer · ${session.username}`
  }, [session.username])

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
    { id: 'upload', label: 'Upload files', hint: 'STOR', run: () => setUploadToken((value) => value + 1) },
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
      <header className="nt-chrome flex h-12 shrink-0 items-center justify-between gap-4 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo size={22} />
          <p className="text-[14px] font-medium tracking-[-0.02em]">NetTransfer</p>
          <span className="mx-1 hidden h-3 w-px bg-line sm:block" aria-hidden="true" />
          <span className="hidden sm:inline-flex">
            <LinkLight state={link} />
          </span>
        </div>
        <div className="flex items-center gap-1">
          <p className="px-2 font-mono text-[12px]">{session.username}</p>
          <Button variant="ghost" onClick={() => setPaletteOpen(true)} title="Open commands">
            <span className="font-mono text-[11px] text-muted">{shortcut}</span>
          </Button>
          <Button variant="ghost" onClick={logout}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
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
