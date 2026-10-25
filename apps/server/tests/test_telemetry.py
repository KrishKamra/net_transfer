"""Telemetry pipeline: real sockets on port 0, a real hub, no mocks on the wire."""

import asyncio
import io
import json
import math
import socket
import threading

import pytest

from src.auth.jwt import create_access_token
from src.auth.security import hash_password
from src.networking.protocol import read_line, send_line
from src.networking.tcp_client_bridge import TCPClientBridge
from src.networking.tcp_server import CHUNK_SIZE, TCPServer
from src.storage import db
from src.telemetry.events import TelemetryEvent
from src.telemetry.hub import TelemetryHub
from src.telemetry.link import TelemetryForwarder, serve_ingest

PASSWORD = "hunter22"


@pytest.fixture
def account(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "telemetry.db")
    db.init_db()
    db.create_user("alice", hash_password(PASSWORD))
    return "alice"


@pytest.fixture
async def rig(tmp_path, account):
    hub = TelemetryHub()
    hub.bind(asyncio.get_running_loop())
    server = TCPServer(
        host="127.0.0.1", port=0, storage_dir=str(tmp_path / "users"), hub=hub, telemetry=False
    )
    thread = threading.Thread(target=server.start, daemon=True)
    thread.start()
    assert server.ready.wait(5)
    yield hub, server
    server.stop()
    await hub.close()


async def collect_until_close(sub, timeout: float = 10.0) -> list[TelemetryEvent]:
    events: list[TelemetryEvent] = []

    async def pull() -> None:
        while True:
            kind, value = await sub.queue.get()
            if kind != "event":
                continue
            events.append(value)
            if value.event_type == "TCP_CLOSE":
                return

    await asyncio.wait_for(pull(), timeout)
    return events


def test_event_schema_round_trips_json():
    event = TelemetryEvent(
        timestamp=1.5,
        connection_id="abcd",
        username="alice",
        client_addr="127.0.0.1:5000",
        server_addr=":2121",
        direction="CLIENT_TO_SERVER",
        layer="L7_APP",
        event_type="COMMAND_FRAME",
        verb="PWD",
        frame_bytes=4,
        raw_frame_repr="PWD\\n",
        payload_hex="5057440a",
        description="x",
    )
    assert TelemetryEvent.model_validate_json(event.model_dump_json()) == event


async def test_upload_emits_every_frame_in_order(rig):
    hub, server = rig
    sub, _ = hub.subscribe("alice")
    size = CHUNK_SIZE * 3 + 123
    payload = bytes(range(256)) * (size // 256) + b"x" * (size % 256)

    bridge = TCPClientBridge(port=server.port)
    await asyncio.to_thread(
        bridge.upload_stream, "alice", PASSWORD, "report.bin", size, io.BytesIO(payload)
    )
    events = await collect_until_close(sub)

    kinds = [(e.event_type, e.verb) for e in events]
    assert kinds[:6] == [
        ("TCP_CONNECT", "SYN"),
        ("STATUS_FRAME", "220"),
        ("COMMAND_FRAME", "AUTH"),
        ("STATUS_FRAME", "230"),
        ("COMMAND_FRAME", "STOR"),
        ("STATUS_FRAME", "150"),
    ]
    chunks = [e for e in events if e.event_type == "DATA_CHUNK"]
    assert len(chunks) == math.ceil(size / CHUNK_SIZE)
    assert [c.chunk.chunk_index for c in chunks] == [1, 2, 3, 4]
    assert sum(c.chunk.chunk_bytes for c in chunks) == size
    assert chunks[-1].chunk.offset + chunks[-1].chunk.chunk_bytes == size
    assert all(c.direction == "CLIENT_TO_SERVER" for c in chunks)
    assert ("STATUS_FRAME", "226") in kinds
    assert ("COMMAND_FRAME", "QUIT") in kinds
    assert events[-1].event_type == "TCP_CLOSE"

    stor = events[4]
    assert stor.raw_frame_repr == f"STOR report.bin {size}\\n"
    assert stor.frame_bytes == len(f"STOR report.bin {size}\n")

    seqs = [e.seq for e in events]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert len({e.connection_id for e in events}) == 1


async def test_auth_password_never_leaves_the_server(rig):
    hub, server = rig
    sub, _ = hub.subscribe("alice")
    await asyncio.to_thread(
        TCPClientBridge(port=server.port).upload_stream,
        "alice", PASSWORD, "a.txt", 3, io.BytesIO(b"abc"),
    )
    events = await collect_until_close(sub)
    auth = next(e for e in events if e.verb == "AUTH")
    assert PASSWORD not in auth.raw_frame_repr
    assert PASSWORD.encode().hex() not in auth.payload_hex
    assert auth.frame_bytes == len(f"AUTH alice {PASSWORD}\n")
    assert len(bytes.fromhex(auth.payload_hex)) == auth.frame_bytes


async def test_download_reports_length_prefix(rig, tmp_path):
    hub, server = rig
    (tmp_path / "users" / "alice").mkdir(parents=True, exist_ok=True)
    (tmp_path / "users" / "alice" / "notes.bin").write_bytes(b"z" * 70_000)
    sub, _ = hub.subscribe("alice")

    size, data = await asyncio.to_thread(
        TCPClientBridge(port=server.port).download_file, "alice", PASSWORD, "notes.bin"
    )
    assert size == 70_000 and data == b"z" * 70_000
    events = await collect_until_close(sub)

    prefix = next(e for e in events if e.event_type == "LENGTH_PREFIX")
    assert prefix.payload_hex == (70_000).to_bytes(8, "big").hex()
    assert prefix.frame_bytes == 8
    chunks = [e for e in events if e.event_type == "DATA_CHUNK"]
    assert [c.chunk.chunk_bytes for c in chunks] == [CHUNK_SIZE, 70_000 - CHUNK_SIZE]
    assert all(c.direction == "SERVER_TO_CLIENT" for c in chunks)


async def test_unauthenticated_socket_is_never_published(rig):
    hub, server = rig
    sub, _ = hub.subscribe("alice")

    def poke() -> None:
        with socket.create_connection(("127.0.0.1", server.port)) as sock:
            buf = bytearray()
            read_line(sock, buf)
            send_line(sock, "AUTH alice wrong-password")
            read_line(sock, buf)
            send_line(sock, "QUIT")
            read_line(sock, buf)

    await asyncio.to_thread(poke)
    await asyncio.sleep(0.2)
    assert sub.queue.empty()


async def test_ring_buffer_is_per_user_and_bounded():
    hub = TelemetryHub(ring_size=5)
    hub.bind(asyncio.get_running_loop())
    base = dict(
        client_addr="c", server_addr=":2121", direction="CLIENT_TO_SERVER",
        layer="L7_APP", event_type="COMMAND_FRAME", frame_bytes=1,
        raw_frame_repr="x", description="x",
    )
    for index in range(8):
        hub.emit(TelemetryEvent(timestamp=index, connection_id="a", username="Alice", **base))
    hub.emit(TelemetryEvent(timestamp=99, connection_id="b", username="bob", **base))
    await asyncio.sleep(0.05)

    _, alice = hub.subscribe("alice")
    _, bob = hub.subscribe("bob")
    assert [e.timestamp for e in alice] == [3, 4, 5, 6, 7]
    assert [e.timestamp for e in bob] == [99]
    await hub.close()


async def test_forwarder_carries_events_across_processes(unused_tcp_port):
    hub = TelemetryHub()
    hub.bind(asyncio.get_running_loop())
    ingest = await serve_ingest(hub, port=unused_tcp_port)
    sub, _ = hub.subscribe("alice")

    forwarder = TelemetryForwarder(server_addr=":2121", port=unused_tcp_port).start()
    try:
        for _ in range(50):
            if forwarder.connected and hub.tap_attached:
                break
            await asyncio.sleep(0.05)
        assert hub.tap_attached
        assert await asyncio.wait_for(sub.queue.get(), 2) == ("tap", True)

        forwarder.submit(
            TelemetryEvent(
                timestamp=1, connection_id="k", username="alice", client_addr="c",
                server_addr=":2121", direction="SERVER_TO_CLIENT", layer="L7_APP",
                event_type="STATUS_FRAME", verb="226", frame_bytes=4,
                raw_frame_repr="226\\n", description="done",
            )
        )
        while True:
            kind, value = await asyncio.wait_for(sub.queue.get(), 2)
            if kind == "event":
                break
        assert value.verb == "226" and value.seq > 0
    finally:
        forwarder.stop()
        ingest.close()
        await hub.close()


async def test_websocket_requires_auth_and_sends_ready(unused_tcp_port):
    import uvicorn
    import websockets

    from src.main import app

    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=unused_tcp_port, lifespan="off", log_level="warning")
    )
    serving = asyncio.create_task(server.serve())
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.02)
        url = f"ws://127.0.0.1:{unused_tcp_port}/ws/telemetry"

        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"type": "auth", "token": "nope"}))
            with pytest.raises(websockets.ConnectionClosed) as closed:
                await ws.recv()
            assert closed.value.rcvd.code == 1008

        token = create_access_token(1, "alice")
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"type": "auth", "token": token}))
            ready = json.loads(await ws.recv())
            assert ready["type"] == "ready"
            assert ready["events"] == []
            assert ready["tap_attached"] is False
    finally:
        server.should_exit = True
        await serving
