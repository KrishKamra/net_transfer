"""Passwords the control plane still needs in order to AUTH a TCP session.

They live in process memory, keyed by the JWT id, and are dropped on logout
or when the token's expiry has passed. They are not written to SQLite and
they are not sent back to the browser.
"""

import threading
import time

_lock = threading.Lock()
_passwords: dict[str, tuple[str, int]] = {}


def remember_password(token_id: str, password: str, expires_at: int) -> None:
    with _lock:
        _drop_expired_locked()
        _passwords[token_id] = (password, expires_at)


def recall_password(token_id: str | None) -> str | None:
    if not token_id:
        return None
    now = int(time.time())
    with _lock:
        _drop_expired_locked(now)
        found = _passwords.get(token_id)
        if found is None or found[1] <= now:
            return None
        return found[0]


def forget_password(token_id: str | None) -> None:
    if not token_id:
        return
    with _lock:
        _passwords.pop(token_id, None)


def _drop_expired_locked(now: int | None = None) -> None:
    current = int(time.time()) if now is None else now
    stale = [key for key, (_, exp) in _passwords.items() if exp <= current]
    for key in stale:
        _passwords.pop(key, None)
