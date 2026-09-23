"""
Database layer for NetTransfer using standard library sqlite3.
Handles users, authentication queries, and transfer records.
"""

import sqlite3
from typing import Any

from .layout import DB_PATH


def get_db_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db() -> None:
    """Initialize database tables if they do not exist."""
    conn = get_db_connection()
    with conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS transfers (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                direction TEXT CHECK(direction IN ('UPLOAD', 'DOWNLOAD')) NOT NULL,
                size INTEGER NOT NULL,
                bytes_transferred INTEGER DEFAULT 0,
                status TEXT CHECK(status IN ('QUEUED', 'TRANSFERRING', 'COMPLETED', 'FAILED', 'CANCELLED')) DEFAULT 'QUEUED',
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers(user_id);
            CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
        """)
    conn.close()


def create_user(username: str, password_hash: str) -> int | None:
    """Create a user. Returns new user id or None if username already exists."""
    conn = get_db_connection()
    try:
        with conn:
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username.strip().lower(), password_hash)
            )
            return cursor.lastrowid
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()


def get_user_by_username(username: str) -> dict[str, Any] | None:
    """Retrieve user record by username."""
    conn = get_db_connection()
    try:
        cursor = conn.execute(
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ?",
            (username.strip().lower(),)
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    finally:
        conn.close()

def record_transfer_start(
    transfer_id: str,
    user_id: int,
    filename: str,
    direction: str,
    size: int,
) -> None:
    """Insert a new transfer with status QUEUED/TRANSFERRING."""
    conn = get_db_connection()
    try:
        with conn:
            conn.execute(
                """
                INSERT INTO transfers (id, user_id, filename, direction, size, bytes_transferred, status, started_at)
                VALUES (?, ?, ?, ?, ?, 0, 'TRANSFERRING', CURRENT_TIMESTAMP)
                """,
                (transfer_id, user_id, filename, direction, size),
            )
    finally:
        conn.close()


def set_transfer_size(transfer_id: str, size: int) -> None:
    """Record the byte length once RETR has announced it."""
    conn = get_db_connection()
    try:
        with conn:
            conn.execute(
                "UPDATE transfers SET size = ? WHERE id = ?",
                (size, transfer_id),
            )
    finally:
        conn.close()


def update_transfer_progress(transfer_id: str, bytes_transferred: int) -> None:
    """Update byte counter for an active transfer."""
    conn = get_db_connection()
    try:
        with conn:
            conn.execute(
                "UPDATE transfers SET bytes_transferred = ? WHERE id = ?",
                (bytes_transferred, transfer_id),
            )
    finally:
        conn.close()


def record_transfer_finish(transfer_id: str, status: str, bytes_transferred: int) -> None:
    """Mark transfer as COMPLETED, FAILED, or CANCELLED."""
    conn = get_db_connection()
    try:
        with conn:
            conn.execute(
                """
                UPDATE transfers 
                SET status = ?, bytes_transferred = ?, completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (status, bytes_transferred, transfer_id),
            )
    finally:
        conn.close()


def get_user_transfers(user_id: int) -> list[dict[str, Any]]:
    """Fetch transfer history for a specific user."""
    conn = get_db_connection()
    try:
        cursor = conn.execute(
            """
            SELECT id, filename, direction, size, bytes_transferred, status, started_at, completed_at
            FROM transfers
            WHERE user_id = ?
            ORDER BY started_at DESC
            LIMIT 50
            """,
            (user_id,),
        )
        return [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()