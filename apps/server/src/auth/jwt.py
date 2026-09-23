"""
JWT token management for the FastAPI control plane.

The signing key comes from NETTRANSFER_JWT_SECRET when that variable is set.
Otherwise each process start generates its own key, so a token from a previous
run will not verify and nothing in the source tree can forge a token.
"""

import os
import secrets
import sys
import uuid
from datetime import datetime, timedelta, timezone

import jwt

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours


def _signing_key() -> str:
    configured = os.environ.get("NETTRANSFER_JWT_SECRET", "").strip()
    if len(configured) >= 32:
        return configured
    print(
        "[!] NETTRANSFER_JWT_SECRET is unset. Tokens are signed with a process-local key.",
        file=sys.stderr,
    )
    return secrets.token_urlsafe(32)


SECRET_KEY = _signing_key()


def create_access_token(user_id: int, username: str) -> str:
    expires_delta = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode = {
        "sub": str(user_id),
        "username": username,
        "jti": str(uuid.uuid4()),
        "exp": expire,
    }
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        expires = payload.get("exp")
        return {
            "user_id": int(payload["sub"]),
            "username": payload["username"],
            "jti": payload.get("jti"),
            "exp": int(expires) if expires is not None else None,
        }
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        return None
