"""
Per-connection probe used by the TCP server.

A `ConnectionTap` turns what a `ClientSession` reads and writes into
`TelemetryEvent`s. It knows the connection id, both endpoints, and which
account the socket belongs to.

Events seen before `AUTH` succeeds are held back. The browser only receives
traffic for the signed-in account, and a socket has no account until then.
On `230` the held events are released with their original timestamps. A
socket that never authenticates is never shown.

Passwords in `AUTH` and `REGISTER` are masked in both the text and the hex
preview. `frame_bytes` still reports the true size on the wire.
"""

import secrets
import time
from collections import deque

from .events import PREVIEW_BYTES, ChunkInfo, Direction, EventType, Layer, TelemetryEvent
from .hub import TelemetryHub

MAX_PENDING = 32
ROLLING_WINDOW = 16
MIB = 1024 * 1024

COMMAND_COPY = {
    "AUTH": "Client authenticates this control connection. The password is masked here but crosses port 2121 in cleartext.",
    "REGISTER": "Client asks the server to create an account.",
    "PWD": "Client asks which sandbox directory this session is bound to.",
    "LIST": "Client asks for a directory listing of the sandbox.",
    "SIZE": "Client asks for the byte size of one file.",
    "STOR": "Client announces an upload. The last field is the exact byte count that will follow the 150 reply.",
    "RETR": "Client requests a file. The server answers 150, then an 8-byte length prefix, then the raw bytes.",
    "QUIT": "Client ends the session. The server answers 221 and closes the socket.",
}

STATUS_COPY = {
    "150": "Server is ready. Raw file bytes follow on the same TCP stream.",
    "200": "Command succeeded.",
    "213": "Server returns the file size.",
    "220": "Service banner. The server speaks first once the handshake completes.",
    "221": "Server acknowledges QUIT and will close the connection.",
    "226": "Transfer complete. Every announced byte has crossed the stream.",
    "230": "Login accepted. The session is now bound to this account's sandbox.",
    "257": "Server reports the current directory.",
    "451": "Transfer aborted by a local error on the server.",
    "501": "Syntax error in the command arguments.",
    "502": "Command not implemented by this server.",
    "530": "Not logged in, or the credentials were rejected.",
    "550": "Requested file is unavailable.",
    "553": "Name rejected by the sandbox. Path traversal is refused.",
}

SECRET_VERBS = {"AUTH", "REGISTER"}


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n")


def _mask_secret(line: str) -> tuple[str, bytes]:
    """Return (display text, preview bytes) with the password field hidden."""
    verb, _, rest = line.partition(" ")
    user, sep, password = rest.partition(" ")
    if verb.upper() not in SECRET_VERBS or not sep:
        return line, line.encode("utf-8")
    shown = f"{verb} {user} {'•' * 8}"
    preview = f"{verb} {user} {'*' * len(password.encode('utf-8'))}".encode("utf-8")
    return shown, preview


class ConnectionTap:
    def __init__(
        self, hub: TelemetryHub, address: tuple, server_port: int, server_ip: str = ""
    ) -> None:
        self.hub = hub
        self.connection_id = secrets.token_hex(4)
        self.client_addr = f"{address[0]}:{address[1]}"
        self.server_addr = f"{server_ip}:{server_port}"
        self.username: str | None = None
        self._pending: list[TelemetryEvent] = []
        self._samples: deque[tuple[float, int]] = deque(maxlen=ROLLING_WINDOW)

    # --- emission plumbing ---

    def _emit(
        self,
        *,
        direction: Direction,
        layer: Layer,
        event_type: EventType,
        frame_bytes: int,
        raw: str,
        description: str,
        verb: str | None = None,
        preview: bytes = b"",
        chunk: ChunkInfo | None = None,
        timestamp: float | None = None,
    ) -> None:
        if not self.hub.enabled:
            return
        event = TelemetryEvent(
            timestamp=timestamp if timestamp is not None else time.time() * 1000,
            connection_id=self.connection_id,
            username=self.username,
            client_addr=self.client_addr,
            server_addr=self.server_addr,
            direction=direction,
            layer=layer,
            event_type=event_type,
            verb=verb,
            frame_bytes=frame_bytes,
            raw_frame_repr=raw[:512],
            payload_hex=preview[:PREVIEW_BYTES].hex(),
            description=description,
            chunk=chunk,
        )
        if self.username is None:
            if len(self._pending) < MAX_PENDING:
                self._pending.append(event)
            return
        self.hub.emit(event)

    def authenticated(self, username: str) -> None:
        """Bind the socket to an account and release what it said before AUTH."""
        self.username = username
        pending, self._pending = self._pending, []
        for event in pending:
            self.hub.emit(event.model_copy(update={"username": username}))

    # --- L4 marks ---

    def connected(self) -> None:
        self._emit(
            direction="CLIENT_TO_SERVER",
            layer="L4_TCP",
            event_type="TCP_CONNECT",
            frame_bytes=0,
            raw="SYN → SYN/ACK → ACK",
            description=(
                "Three-way handshake. The kernel completed it before accept() returned, "
                "so this mark is taken at accept(). Wireshark shows the three segments individually."
            ),
            verb="SYN",
        )

    def closed(self, initiator: str) -> None:
        """`initiator` is "client" (EOF seen), "server" (after 221) or "reset"."""
        if initiator == "reset":
            direction: Direction = "CLIENT_TO_SERVER"
            raw = "RST"
            text = "The connection dropped mid-session. Wireshark shows a RST instead of an orderly FIN exchange."
        elif initiator == "server":
            direction = "SERVER_TO_CLIENT"
            raw = "FIN → ACK"
            text = "Server closes its side after 221. The client answers with its own FIN and ACK."
        else:
            direction = "CLIENT_TO_SERVER"
            raw = "FIN → ACK"
            text = "Client closed its side. recv() returned 0 bytes, which is how a socket sees FIN."
        self._emit(
            direction=direction,
            layer="L4_TCP",
            event_type="TCP_CLOSE",
            frame_bytes=0,
            raw=raw,
            description=text,
            verb="RST" if initiator == "reset" else "FIN",
        )
        self._pending.clear()

    # --- L7 frames ---

    def command(self, line: str) -> None:
        verb = line.split(" ", 1)[0].upper()
        shown, preview = _mask_secret(line)
        self._emit(
            direction="CLIENT_TO_SERVER",
            layer="L7_APP",
            event_type="COMMAND_FRAME",
            frame_bytes=len(line.encode("utf-8")) + 1,
            raw=_escape(shown + "\n"),
            description=COMMAND_COPY.get(verb, "Unrecognised command. The server will answer 502."),
            verb=verb[:16],
            preview=preview + b"\n",
        )

    def reply(self, line: str) -> None:
        code = line[:3]
        encoded = (line + "\n").encode("utf-8")
        self._emit(
            direction="SERVER_TO_CLIENT",
            layer="L7_APP",
            event_type="STATUS_FRAME",
            frame_bytes=len(encoded),
            raw=_escape(line + "\n"),
            description=STATUS_COPY.get(code, "Server reply."),
            verb=code if code.isdigit() else None,
            preview=encoded,
        )

    def listing_entry(self, line: str, index: int, count: int) -> None:
        encoded = (line + "\n").encode("utf-8")
        self._emit(
            direction="SERVER_TO_CLIENT",
            layer="L7_APP",
            event_type="DATA_CHUNK",
            frame_bytes=len(encoded),
            raw=_escape(line + "\n"),
            description=f"Directory entry {index} of {count}, framed as TYPE|NAME|SIZE and a newline.",
            verb="LIST",
            preview=encoded,
            chunk=ChunkInfo(
                chunk_index=index,
                chunk_count=max(count, 1),
                chunk_bytes=len(encoded),
                offset=0,
                total_bytes=0,
                rolling_mbps=0,
            ),
        )

    def length_prefix(self, header: bytes, size: int) -> None:
        self._emit(
            direction="SERVER_TO_CLIENT",
            layer="L7_APP",
            event_type="LENGTH_PREFIX",
            frame_bytes=len(header),
            raw="[" + " ".join(f"0x{byte:02X}" for byte in header) + "]",
            description=(
                f"struct.pack('>Q', {size}). Eight big-endian bytes tell the client exactly "
                "where the file ends, because TCP itself has no message boundaries."
            ),
            verb="LEN",
            preview=header,
        )

    # --- binary stream ---

    def begin_stream(self) -> None:
        self._samples.clear()
        self._samples.append((time.perf_counter(), 0))

    def chunk(
        self,
        data: bytes,
        *,
        direction: Direction,
        index: int,
        count: int,
        offset: int,
        total: int,
        filename: str,
    ) -> None:
        if not self.hub.enabled:
            return
        now = time.perf_counter()
        moved = offset + len(data)
        self._samples.append((now, moved))
        first_at, first_bytes = self._samples[0]
        span = now - first_at
        mbps = ((moved - first_bytes) / span / MIB) if span > 0 else 0.0
        verb = "STOR" if direction == "CLIENT_TO_SERVER" else "RETR"
        action = "read from" if direction == "CLIENT_TO_SERVER" else "written to"
        self._emit(
            direction=direction,
            layer="L4_TCP",
            event_type="DATA_CHUNK",
            frame_bytes=len(data),
            raw=f"{verb} payload [{offset}:{moved}] of {total}",
            description=(
                f"Chunk {index} of {count}, {action} the socket by the server. "
                "TCP may have carried it as many smaller segments. The protocol only counts bytes."
            ),
            verb=verb,
            preview=data[:16],
            chunk=ChunkInfo(
                chunk_index=index,
                chunk_count=max(count, 1),
                chunk_bytes=len(data),
                offset=offset,
                total_bytes=total,
                rolling_mbps=round(max(mbps, 0.0), 2),
                filename=filename,
            ),
        )
