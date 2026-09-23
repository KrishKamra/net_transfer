"""
FastAPI Control Plane Routes:
- POST /api/auth/register
- POST /api/auth/login
- GET  /api/files
- DELETE /api/files/{filename}
- POST /api/transfers/upload
- GET  /api/transfers/download/{filename}
- GET  /api/transfers/history
"""

import asyncio
import io
import re
import tempfile

from fastapi import (  # pyright: ignore[reportMissingImports]
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..auth.credentials import forget_password, recall_password, remember_password
from ..auth.jwt import create_access_token, decode_access_token
from ..auth.security import hash_password, verify_password
from ..networking.protocol import ProtocolError
from ..networking.tcp_client_bridge import TCPClientBridge
from ..storage.db import (
    create_user,
    get_user_by_username,
    get_user_transfers,
)
from ..storage.layout import USER_STORAGE_DIR
from ..transfer.manager import ActiveTransfer, transfer_manager
from .live import transfer_hub

router = APIRouter(prefix="/api")
tcp_bridge = TCPClientBridge()
UPLOAD_FILE = File(...)

# Same account sandboxes the TCP server uses for LIST, STOR, and RETR.
BASE_STORAGE = USER_STORAGE_DIR


# --- Models ---
class UserAuthRequest(BaseModel):
    username: str
    password: str


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str
    user_id: int


class FileItem(BaseModel):
    name: str
    size: int
    is_dir: bool


# --- Auth Dependency ---
def get_current_user(authorization: str | None = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header.",
        )
    token = authorization.split(" ")[1]
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
        )
    return payload


current_user_dependency = Depends(get_current_user)
TRANSFER_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
TCP_ERRORS = (OSError, ValueError, RuntimeError, ProtocolError)


def tcp_password(user: dict, provided: str | None) -> str:
    stored = recall_password(user.get("jti"))
    if stored:
        return stored
    if provided:
        return provided
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Sign in again so the control plane can open the TCP session.",
    )


def _remember_login(token: str, password: str) -> None:
    payload = decode_access_token(token)
    if payload and payload.get("jti") and payload.get("exp"):
        remember_password(payload["jti"], password, int(payload["exp"]))


async def spool_upload(upload: UploadFile):
    """Count the body and keep it off the heap once it passes 1 MiB.

    STOR has to announce the size before any payload byte, so the body is
    read to the end first. Past the spool limit it lives in a temp file.
    """
    spool = tempfile.SpooledTemporaryFile(max_size=1024 * 1024)
    total = 0
    try:
        while True:
            chunk = await upload.read(64 * 1024)
            if not chunk:
                break
            spool.write(chunk)
            total += len(chunk)
        spool.seek(0)
        return total, spool
    except Exception:
        spool.close()
        raise


def clean_transfer_id(raw: str | None) -> str | None:
    if raw and TRANSFER_ID.fullmatch(raw):
        return raw
    return None


def begin_transfer(
    user_id: int,
    filename: str,
    direction: str,
    total_bytes: int,
    transfer_id: str | None,
) -> ActiveTransfer:
    transfer = transfer_manager.start_transfer(
        user_id=user_id,
        filename=filename,
        direction=direction,
        total_bytes=total_bytes,
        on_update=transfer_hub.publish,
        transfer_id=clean_transfer_id(transfer_id),
    )
    transfer_hub.publish(transfer.snapshot())
    return transfer


def close_transfer(transfer: ActiveTransfer | None) -> None:
    if transfer is None:
        return
    try:
        if transfer.status == "TRANSFERRING":
            transfer.finish("FAILED")
    finally:
        transfer_manager.remove_transfer(transfer.transfer_id)


# --- Endpoints ---


@router.post("/auth/register", response_model=AuthResponse)
def register(req: UserAuthRequest):
    username = req.username.strip().lower()
    if len(username) < 3 or len(req.password) < 6:
        raise HTTPException(
            status_code=400,
            detail="Username must be at least 3 characters and password at least 6.",
        )

    pw_hash = hash_password(req.password)
    user_id = create_user(username, pw_hash)
    if not user_id:
        raise HTTPException(status_code=409, detail="Username already taken.")

    # Auto-provision user directory
    (BASE_STORAGE / username).mkdir(parents=True, exist_ok=True)

    token = create_access_token(user_id, username)
    _remember_login(token, req.password)
    return AuthResponse(access_token=token, username=username, user_id=user_id)


@router.post("/auth/login", response_model=AuthResponse)
def login(req: UserAuthRequest):
    username = req.username.strip().lower()
    user = get_user_by_username(username)
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    token = create_access_token(user["id"], user["username"])
    _remember_login(token, req.password)
    return AuthResponse(
        access_token=token, username=user["username"], user_id=user["id"]
    )


@router.post("/auth/logout")
def logout(user: dict = current_user_dependency):
    forget_password(user.get("jti"))
    return {"status": "signed-out"}


@router.get("/files", response_model=list[FileItem])
def list_files(user: dict = current_user_dependency):
    user_dir = BASE_STORAGE / user["username"]
    user_dir.mkdir(parents=True, exist_ok=True)

    items = []
    for path in user_dir.iterdir():
        items.append(
            FileItem(
                name=path.name,
                size=path.stat().st_size if path.is_file() else 0,
                is_dir=path.is_dir(),
            )
        )
    return sorted(items, key=lambda x: (not x.is_dir, x.name.lower()))


@router.delete("/files/{filename}")
def delete_file(filename: str, user: dict = current_user_dependency):
    user_dir = BASE_STORAGE / user["username"]
    safe_path = (user_dir / filename.lstrip("/\\")).resolve()

    if user_dir not in safe_path.parents or not safe_path.exists():
        raise HTTPException(status_code=404, detail="File not found.")

    if safe_path.is_file():
        safe_path.unlink()
    return {"detail": f"File '{filename}' deleted successfully."}


@router.post("/transfers/upload")
async def upload_file(
    file: UploadFile = UPLOAD_FILE,
    user: dict = current_user_dependency,
    x_password: str | None = Header(None),
    x_transfer_id: str | None = Header(None),
):
    """
    Accepts a file over HTTP and writes it with STOR.
    The body is spooled, then streamed. Progress is published on /ws/transfers.
    """
    transfer: ActiveTransfer | None = None
    spool = None
    try:
        password = tcp_password(user, x_password)
        filename = file.filename
        if filename is None:
            raise HTTPException(status_code=400, detail="A filename is required.")
        file_size, spool = await spool_upload(file)

        transfer = begin_transfer(
            user["user_id"], filename, "UPLOAD", file_size, x_transfer_id
        )
        resp = await asyncio.to_thread(
            tcp_bridge.upload_stream,
            user["username"],
            password,
            filename,
            file_size,
            spool,
            transfer.update_bytes,
        )
        transfer.finish("COMPLETED")
        return {
            "status": "success",
            "tcp_response": resp,
            "filename": filename,
            "size": file_size,
            "transfer_id": transfer.transfer_id,
        }
    except HTTPException:
        raise
    except TCP_ERRORS as err:
        raise HTTPException(status_code=500, detail=f"TCP transfer error: {err}") from err
    finally:
        close_transfer(transfer)
        if spool is not None:
            spool.close()


@router.get("/transfers/download/{filename}")
async def download_file(
    filename: str,
    user: dict = current_user_dependency,
    x_password: str | None = Header(None),
    x_transfer_id: str | None = Header(None),
):
    """
    Retrieves file over raw TCP RETR command and streams it out to the HTTP client.
    Byte progress during RETR is published on /ws/transfers.
    """
    transfer: ActiveTransfer | None = None
    try:
        password = tcp_password(user, x_password)
        transfer = begin_transfer(user["user_id"], filename, "DOWNLOAD", 0, x_transfer_id)

        def on_size(total: int) -> None:
            assert transfer is not None
            transfer.set_total(total)

        file_size, raw_bytes = await asyncio.to_thread(
            tcp_bridge.download_file,
            user["username"],
            password,
            filename,
            on_size,
            transfer.update_bytes,
        )
        transfer.finish("COMPLETED")
        return StreamingResponse(
            io.BytesIO(raw_bytes),
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Length": str(file_size),
                "X-Transfer-Id": transfer.transfer_id,
            },
        )
    except TCP_ERRORS as err:
        raise HTTPException(status_code=500, detail=f"TCP download error: {err}") from err
    finally:
        close_transfer(transfer)


@router.get("/transfers/history")
def transfer_history(authorization: str | None = Header(None)):
    user = get_current_user(authorization)
    return get_user_transfers(user["user_id"])
