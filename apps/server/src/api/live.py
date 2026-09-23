"""WebSocket fan-out for live TCP transfer progress.

Snapshots are produced on the worker thread that speaks TCP. They are scheduled
onto the FastAPI event loop and sent only to sockets owned by that user.
"""

import asyncio
import json
import threading
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth.jwt import decode_access_token
from ..transfer.manager import TransferSnapshot

router = APIRouter()


def snapshot_payload(snapshot: TransferSnapshot) -> dict[str, Any]:
    return {
        "type": "transfer",
        "transfer_id": snapshot.transfer_id,
        "filename": snapshot.filename,
        "direction": snapshot.direction,
        "total_bytes": snapshot.total_bytes,
        "transferred_bytes": snapshot.transferred_bytes,
        "progress_pct": snapshot.progress_pct,
        "speed_bps": snapshot.speed_bps,
        "speed_mbps": snapshot.speed_mbps,
        "eta_seconds": snapshot.eta_seconds,
        "status": snapshot.status,
    }


class TransferHub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sockets: dict[int, set[WebSocket]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        with self._lock:
            self._sockets.setdefault(user_id, set()).add(websocket)

    def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        with self._lock:
            sockets = self._sockets.get(user_id)
            if not sockets:
                return
            sockets.discard(websocket)
            if not sockets:
                self._sockets.pop(user_id, None)

    def publish(self, snapshot: TransferSnapshot) -> None:
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        message = json.dumps(snapshot_payload(snapshot))
        user_id = snapshot.user_id

        def schedule() -> None:
            asyncio.create_task(self._broadcast(user_id, message))

        loop.call_soon_threadsafe(schedule)

    async def _broadcast(self, user_id: int, message: str) -> None:
        with self._lock:
            sockets = list(self._sockets.get(user_id, ()))
        for websocket in sockets:
            try:
                await websocket.send_text(message)
            except Exception:
                self.disconnect(user_id, websocket)


transfer_hub = TransferHub()


@router.websocket("/ws/transfers")
async def transfers_socket(websocket: WebSocket) -> None:
    """Authenticate with the first text frame, not the URL.

    A proxy that records request paths will not see the JWT. The frame is
    `{"type":"auth","token":"<jwt>"}` and must arrive within 5 seconds.
    """
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5)
        message = json.loads(raw)
    except (asyncio.TimeoutError, json.JSONDecodeError, WebSocketDisconnect, UnicodeDecodeError):
        await websocket.close(code=1008)
        return

    token = message.get("token") if isinstance(message, dict) and message.get("type") == "auth" else None
    user = decode_access_token(token) if isinstance(token, str) else None
    if user is None or not user.get("jti"):
        await websocket.close(code=1008)
        return

    user_id = int(user["user_id"])
    await transfer_hub.connect(user_id, websocket)
    await websocket.send_text(json.dumps({"type": "ready"}))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        transfer_hub.disconnect(user_id, websocket)
