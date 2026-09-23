"""
Authentication and password hashing utilities using bcrypt.
"""

from importlib import import_module
from typing import Any

# Load the optional dependency dynamically so static analyzers do not require
# third-party stubs to be installed in the analysis environment.
bcrypt: Any = import_module("bcrypt")


def hash_password(plain_password: str) -> str:
    salt = bcrypt.gensalt(rounds=12)
    hashed = bcrypt.hashpw(plain_password.encode("utf-8"), salt)
    return hashed.decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(
            plain_password.encode("utf-8"), hashed_password.encode("utf-8")
        )
    except (TypeError, ValueError):
        return False
