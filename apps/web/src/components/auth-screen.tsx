import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, login, register } from '../lib/api'
import { cn } from '../lib/cn'
import { saveSession, sessionFromAuth } from '../lib/session'
import type { Session } from '../types'
import { Button } from './button'
import { Logo } from './logo'
import { SignalLoader } from './signal-loader'

type Mode = 'login' | 'register'

const SPEC = [
  ['STOR', 'Upload. The size is declared, then the bytes follow.'],
  ['RETR', 'Download. An 8-byte header, then the payload.'],
  ['LIST', 'One directory per account. Paths cannot leave it.'],
] as const

type Props = {
  onAuthenticated: (session: Session) => void
}

export function AuthScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const tabsRef = useRef<HTMLDivElement>(null)
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })

  useLayoutEffect(() => {
    const list = tabsRef.current
    if (!list) return
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[aria-pressed="true"]')
      if (!active) return
      setIndicator({ left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [mode])

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = username.trim().toLowerCase()
    if (name.length < 3 || password.length < 6) {
      setError('Username must be at least 3 characters and password at least 6.')
      return
    }
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
      setError('Username cannot contain path characters.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const result = mode === 'login' ? await login(name, password) : await register(name, password)
      const session = sessionFromAuth(result)
      saveSession(session)
      onAuthenticated(session)
    } catch (err) {
      const fallback = mode === 'login' ? 'Sign in failed.' : 'Could not create the account.'
      setError(err instanceof ApiError ? err.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-canvas lg:flex-row">
      <aside className="nt-wash flex flex-col justify-between gap-10 px-5 py-5 sm:px-8 lg:w-[44%] lg:px-12 lg:py-10">
        <div className="flex items-center gap-3">
          <Logo size={36} title="NetTransfer" />
          <div>
            <p className="text-[15px] font-medium tracking-[-0.02em]">NetTransfer</p>
            <p className="font-mono text-[12px] text-muted">TCP file service</p>
          </div>
        </div>

        <div className="nt-rise hidden max-w-[420px] lg:block">
          <p className="max-w-[18ch] text-[28px] leading-[1.2] font-medium tracking-[-0.03em]">
            A file, two sockets, one sandbox.
          </p>
          <p className="mt-3 max-w-[36ch] text-[14px] leading-6 text-muted">
            The browser talks to the control plane. The control plane opens TCP, then runs the transfer.
          </p>
          <dl className="nt-plate mt-8 overflow-hidden rounded-lg">
            {SPEC.map(([code, detail]) => (
              <div key={code} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-b border-line px-4 py-3 last:border-b-0">
                <dt className="font-mono text-[12px] text-signal">{code}</dt>
                <dd className="text-[13px] leading-5 text-ink">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="hidden font-mono text-[12px] text-muted lg:block">HTTP 8000 · length prefix 8 bytes</p>
      </aside>

      <main className="nt-auth-stage flex flex-1 items-center justify-center px-4 py-8 sm:px-8 lg:px-12">
        <div className="nt-plate nt-auth-form nt-rise w-full max-w-[420px] rounded-lg px-6 py-7 sm:px-8 lg:px-0 lg:py-0">
          <div key={mode} className="nt-mode">
            <h1 className="text-[26px] leading-8 font-medium tracking-[-0.03em]">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </h1>
            <p className="mt-1.5 text-[13px] leading-5 text-muted">
              {mode === 'login'
                ? 'Files for this account stay in its sandbox.'
                : 'Creates the account and its sandbox directory.'}
            </p>
          </div>

          <div
            ref={tabsRef}
            className="relative mt-6 flex gap-5 border-b border-line"
            role="group"
            aria-label="Account action"
          >
            <ModeTab active={mode === 'login'} onClick={() => switchMode('login')}>
              Sign in
            </ModeTab>
            <ModeTab active={mode === 'register'} onClick={() => switchMode('register')}>
              Create account
            </ModeTab>
            <span
              className="nt-tab-indicator"
              style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }}
              aria-hidden="true"
            />
          </div>

          <form className="mt-5 grid gap-4" onSubmit={onSubmit} noValidate>
            <label className="grid gap-1.5">
              <span className="text-[12px] text-muted">Username</span>
              <input
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="nt-field nt-field-lg"
                required
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-[12px] text-muted">Password</span>
              <input
                name="password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="nt-field nt-field-lg"
                required
              />
              <span className="text-[12px] leading-5 text-muted">
                At least 6 characters. Used to open the TCP session, then kept only in server memory for this login.
              </span>
            </label>

            {error ? (
              <p role="alert" className="border-l-2 border-oxide pl-3 text-[13px] leading-5 text-oxide">
                {error}
              </p>
            ) : null}

            <Button type="submit" variant="primary" className="nt-submit mt-1 h-10 w-full" disabled={busy} aria-busy={busy}>
              {busy ? <SignalLoader /> : null}
              <span key={busy ? 'busy' : mode} className="nt-mode">
                {busy ? 'Checking…' : mode === 'login' ? 'Sign in' : 'Create account'}
              </span>
            </Button>
          </form>

          <p className="mt-6 font-mono text-[12px] text-muted lg:hidden">HTTP 8000 · TCP 2121 · 8-byte length prefix</p>
        </div>
      </main>
    </div>
  )
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'relative z-10 pb-2.5 text-[13px] font-medium transition-colors duration-200',
        active ? 'text-ink' : 'text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}
