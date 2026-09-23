import type { AuthResult, Session } from '../types'

const STORAGE_KEY = 'nettransfer.session'

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Session>
    if (!parsed.accessToken || !parsed.username || typeof parsed.userId !== 'number') {
      return null
    }
    return {
      accessToken: parsed.accessToken,
      username: parsed.username,
      userId: parsed.userId,
    }
  } catch {
    return null
  }
}

export function saveSession(session: Session): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearSession(): void {
  sessionStorage.removeItem(STORAGE_KEY)
}

export function sessionFromAuth(result: AuthResult): Session {
  return {
    accessToken: result.access_token,
    username: result.username,
    userId: result.user_id,
  }
}
