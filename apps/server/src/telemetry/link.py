"""
Loopback link from the TCP server process to the control plane.

The TCP server (port 2121) and FastAPI (port 8000) are separate processes, so
an in-memory hub on one side cannot reach WebSockets on the other. The TCP
server runs a `TelemetryForwarder` thread that writes newline-delimited JSON to
127.0.0.1:2199, and the control plane runs `serve_ingest()` on that port and
feeds each line into its own `TelemetryHub`.

The link uses the same framing idea as the file protocol: one JSON document per
line. It is best-effort. Events emitted while the control plane is down are
dropped, so a restart never replays stale traffic into the inspector.
"""

import asyncio
import json
import os
import queue
import socket
import sys
import threading

from pydantic import ValidationError

from .events import TelemetryEvent
from .hub import TelemetryHub

TELEMETRY_HOST = "127.0.0.1"
TELEMETRY_PORT = int(os.environ.get("NETTRANSFER_TELEMETRY_PORT", "2199"))
RETRY_SECONDS = 1.0
MAX_BATCH = 256


class TelemetryForwarder:
    """Background sender used by the TCP server process. `submit()` never blocks."""

    def __init__(
        self,
        server_addr: str,
        host: str = TELEMETRY_HOST,
        port: int = TELEMETRY_PORT,
        max_queue: int = 20_000,
    ) -> None:
        self.server_addr = server_addr
        self.host = host
        self.port = port
        self._queue: queue.Queue[TelemetryEvent] = queue.Queue(max_queue)
        self._stop = threading.Event()
        self._connected = False
        self._thread = threading.Thread(target=self._run, name="telemetry-forwarder", daemon=True)
        self.dropped = 0

    @property
    def connected(self) -> bool:
        return self._connected

    def start(self) -> "TelemetryForwarder":
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)

    def submit(self, event: TelemetryEvent) -> None:
        if not self._connected:
            self.dropped += 1
            return
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            self.dropped += 1

    def _connect(self) -> socket.socket | None:
        try:
            sock = socket.create_connection((self.host, self.port), timeout=RETRY_SECONDS)
        except OSError:
            return None
        sock.settimeout(None)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        hello = {"kind": "hello", "server_addr": self.server_addr}
        try:
            sock.sendall((json.dumps(hello) + "\n").encode("utf-8"))
        except OSError:
            sock.close()
            return None
        return sock

    def _run(self) -> None:
        sock: socket.socket | None = None
        announced = False
        while not self._stop.is_set():
            if sock is None:
                sock = self._connect()
                if sock is None:
                    if not announced:
                        print(
                            f"[*] Telemetry link waiting for the control plane on {self.host}:{self.port}",
                            file=sys.stderr,
                        )
                        announced = True
                    self._stop.wait(RETRY_SECONDS)
                    continue
                self._connected = True
                announced = False
                print(f"[*] Telemetry link attached to {self.host}:{self.port}")

            try:
                first = self._queue.get(timeout=RETRY_SECONDS)
            except queue.Empty:
                continue
            batch = [first]
            while len(batch) < MAX_BATCH:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break

            payload = "".join(
                '{"kind":"event","event":' + event.model_dump_json() + "}\n" for event in batch
            )
            try:
                sock.sendall(payload.encode("utf-8"))
            except OSError:
                self.dropped += len(batch)
                self._connected = False
                sock.close()
                sock = None
                self._drain()

        if sock is not None:
            sock.close()

    def _drain(self) -> None:
        while True:
            try:
                self._queue.get_nowait()
                self.dropped += 1
            except queue.Empty:
                return


async def serve_ingest(
    hub: TelemetryHub,
    host: str = TELEMETRY_HOST,
    port: int = TELEMETRY_PORT,
) -> asyncio.Server:
    """Accept forwarders on loopback and publish their events into `hub`."""

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        linked = False
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(message, dict):
                    continue
                kind = message.get("kind")
                if kind == "hello" and not linked:
                    linked = True
                    hub.set_tap(True)
                elif kind == "event" and linked:
                    try:
                        hub.publish(TelemetryEvent.model_validate(message.get("event")))
                    except ValidationError:
                        continue
        except (ConnectionError, asyncio.LimitOverrunError, ValueError):
            pass
        finally:
            if linked:
                hub.set_tap(False)
            writer.close()

    return await asyncio.start_server(handle, host, port, limit=64 * 1024)
