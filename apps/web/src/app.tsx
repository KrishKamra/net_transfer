import { useCallback, useEffect, useState } from 'react'
import { AuthScreen } from './components/auth-screen'
import { Workspace } from './components/workspace'
import { clearSession, loadSession } from './lib/session'
import type { Session } from './types'

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession())

  const logout = useCallback(() => {
    clearSession()
    setSession(null)
  }, [])

  useEffect(() => {
    if (!session) document.title = 'NetTransfer · Sign in'
  }, [session])

  if (!session) {
    return <AuthScreen onAuthenticated={setSession} />
  }

  return <Workspace session={session} onLogout={logout} />
}
