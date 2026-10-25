"""WebSocket feed for the Protocol Inspector.

Frames on the socket:

    client → {"type":"auth","token":"<jwt>"}          first frame, within 5 s
    server → {"type":"ready","tap_attached":bool,"events":[...]}  backlog
    server → {"type":"events","events":[...]}          live batches
    server → {"type":"tap","attached":bool}            TCP server linked/unlinked
    client → {"type":"ping"}                           ignored keep-alive

Each socket only receives events for the account in its token.
"""

import asyncio
import contextlib
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth.jwt import decode_access_token
from ..telemetry.hub import RING_SIZE, Item, Subscription, telemetry_hub

router = APIRouter()

MAX_BATCH = 256


def _events_frame(events: list[dict[str, Any]]) -> str:
    return json.dumps({"type": "events", "events": events}, separators=(",", ":"))


async def _pump(websocket: WebSocket, sub: Subscription) -> None:
    """Drain the subscription in batches so a 16k-chunk upload is not 16k frames."""
    while True:
        items: list[Item] = [await sub.queue.get()]
        while len(items) < MAX_BATCH:
            try:
                items.append(sub.queue.get_nowait())
            except asyncio.QueueEmpty:
                break

        events: list[dict[str, Any]] = []
        for kind, value in items:
            if kind == "event":
                events.append(value.model_dump(mode="json"))
                continue
            if events:
                await websocket.send_text(_events_frame(events))
                events = []
            await websocket.send_text(json.dumps({"type": "tap", "attached": value}))
        if events:
            await websocket.send_text(_events_frame(events))


async def _listen(websocket: WebSocket) -> None:
    while True:
        await websocket.receive_text()


@router.websocket("/ws/telemetry")
async def telemetry_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=5)
        message = json.loads(raw)
    except (asyncio.TimeoutError, json.JSONDecodeError, WebSocketDisconnect, UnicodeDecodeError):
        with contextlib.suppress(RuntimeError):
            await websocket.close(code=1008)
        return

    token = message.get("token") if isinstance(message, dict) and message.get("type") == "auth" else None
    user = decode_access_token(token) if isinstance(token, str) else None
    if user is None or not user.get("username"):
        await websocket.close(code=1008)
        return

    sub, backlog = telemetry_hub.subscribe(str(user["username"]))
    try:
        await websocket.send_text(
            json.dumps(
                {
                    "type": "ready",
                    "tap_attached": telemetry_hub.tap_attached,
                    "ring_size": RING_SIZE,
                    "events": [event.model_dump(mode="json") for event in backlog],
                },
                separators=(",", ":"),
            )
        )
        pump = asyncio.create_task(_pump(websocket, sub))
        listen = asyncio.create_task(_listen(websocket))
        done, pending = await asyncio.wait({pump, listen}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in pending:
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await task
        for task in done:
            with contextlib.suppress(WebSocketDisconnect, RuntimeError, OSError):
                task.result()
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        telemetry_hub.unsubscribe(sub)
