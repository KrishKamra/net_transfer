"""Filesystem locations shared by the TCP server and the HTTP control plane.

The TCP process and FastAPI must read and write the same account sandboxes.
These paths are resolved from this file so a working-directory change cannot
split LIST/STOR/RETR from GET /api/files.
"""

from pathlib import Path

# apps/server/src/storage/layout.py → parents[2] == apps/server
_SERVER_ROOT = Path(__file__).resolve().parents[2]

# Account directories. Matches the files already stored for TCP STOR/RETR.
USER_STORAGE_DIR = (_SERVER_ROOT / "storage" / "users").resolve()

# SQLite database already created beside the server package.
DB_PATH = (_SERVER_ROOT.parent / "storage" / "nettransfer.db").resolve()
