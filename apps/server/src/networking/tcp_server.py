"""
Multi-threaded TCP File Server.
Provides socket binding, connection dispatching, SQLite persistent auth,
directory listing, sandboxed upload (STOR), and download (RETR).

Every frame a session reads or writes is also reported to the telemetry hub
through a `ConnectionTap`. With the control plane running, the hub forwards
those events to the Protocol Inspector over the loopback telemetry link.
"""

import math
import os
import socket
import struct
import sys
import threading
from pathlib import Path

from ..auth.security import hash_password, verify_password
from ..storage.db import create_user, get_user_by_username, init_db
from ..storage.layout import USER_STORAGE_DIR
from ..telemetry.hub import TelemetryHub, telemetry_hub
from ..telemetry.link import TelemetryForwarder
from ..telemetry.tap import ConnectionTap
from .protocol import (
    HEADER_FORMAT,
    ProtocolError,
    read_exact,
    read_line,
    send_exact,
    send_line,
)

CHUNK_SIZE = 64 * 1024  # 64 KB transfer chunks


def _parse_stor(args: str) -> tuple[str, int] | None:
    """The last field is the size. Everything before it is the filename.

    `STOR notes.bin 12` and `STOR my notes.bin 12` are both valid. A slash
    or `..` in the name is rejected here.
    """
    text = args.strip()
    filename, separator, size_text = text.rpartition(" ")
    if not separator or not filename.strip():
        return None
    try:
        total_bytes = int(size_text)
    except ValueError:
        return None
    if total_bytes < 0:
        return None
    name = filename.strip()
    if not name or any(mark in name for mark in ("/", "\\", "..", "\n", "\r")):
        return None
    return name, total_bytes


class ClientSession:
    def __init__(
        self,
        client_socket: socket.socket,
        address: tuple,
        base_storage_dir: Path,
        server_port: int = 2121,
        hub: TelemetryHub = telemetry_hub,
    ):
        self.sock = client_socket
        self.address = address
        self.buffer = bytearray()
        self.authenticated_user: str | None = None
        self.user_id: int | None = None
        self.base_storage_dir = base_storage_dir.resolve()
        self.user_dir: Path | None = None
        try:
            server_ip = client_socket.getsockname()[0]
        except OSError:
            server_ip = ""
        self.tap = ConnectionTap(hub, address, server_port, server_ip)

    def reply(self, line: str) -> None:
        """Send one newline-framed reply and report it to the inspector."""
        send_line(self.sock, line)
        self.tap.reply(line)

    def handle(self) -> None:
        client_ip, client_port = self.address
        print(f"[*] Connection accepted from {client_ip}:{client_port}")
        self.tap.connected()
        initiator = "client"

        try:
            self.reply("220 Welcome to NetTransfer TCP Service")
            while True:
                line = read_line(self.sock, self.buffer)
                if line is None:
                    print(f"[-] Client {client_ip}:{client_port} disconnected cleanly.")
                    break

                line = line.strip()
                if not line:
                    continue

                self.tap.command(line)
                parts = line.split(" ", 1)
                cmd = parts[0].upper()
                args = parts[1] if len(parts) > 1 else ""

                if cmd == "QUIT":
                    self.reply("221 Service closing control connection.")
                    initiator = "server"
                    break

                self.dispatch_command(cmd, args)

        except (ConnectionError, ProtocolError) as err:
            initiator = "reset"
            print(f"[!] Connection error with {client_ip}:{client_port} - {err}")
        finally:
            self.sock.close()
            self.tap.closed(initiator)

    def dispatch_command(self, cmd: str, args: str) -> None:
        if cmd == "REGISTER":
            self.handle_register(args)
            return
        if cmd == "AUTH":
            self.handle_auth(args)
            return

        if not self.authenticated_user:
            self.reply("530 Not logged in. Send AUTH <user> <pass> first.")
            return

        if cmd == "PWD":
            self.reply(f'257 "/{self.authenticated_user}" is current directory.')
        elif cmd == "LIST":
            self.handle_list()
        elif cmd == "SIZE":
            self.handle_size(args)
        elif cmd == "STOR":
            self.handle_stor(args)
        elif cmd == "RETR":
            self.handle_retr(args)
        else:
            self.reply(f"502 Command '{cmd}' not implemented.")

    def _resolve_safe_path(self, target_filename: str) -> Path | None:
        """
        Enforce strict filesystem sandbox. Rejects path traversal attempts.
        """
        assert self.user_dir is not None
        clean_name = target_filename.lstrip("/\\")
        candidate = (self.user_dir / clean_name).resolve()

        if self.user_dir == candidate or self.user_dir in candidate.parents:
            return candidate
        return None

    def handle_register(self, args: str) -> None:
        tokens = args.split(" ")
        if len(tokens) != 2:
            self.reply("501 Syntax error: expected REGISTER <user> <pass>")
            return

        username, password = tokens[0].strip(), tokens[1]
        if len(username) < 3 or len(password) < 6:
            self.reply("501 Username min 3 chars, password min 6 chars.")
            return

        pw_hash = hash_password(password)
        user_id = create_user(username, pw_hash)
        if user_id:
            self.reply(f"200 Registration successful for {username}. Please AUTH.")
            print(f"[+] User registered: {username} (ID: {user_id})")
        else:
            self.reply("550 Username already taken.")

    def handle_auth(self, args: str) -> None:
        tokens = args.split(" ")
        if len(tokens) != 2:
            self.reply("501 Syntax error: expected AUTH <user> <pass>")
            return

        username, password = tokens[0].strip(), tokens[1]
        user_record = get_user_by_username(username)

        if user_record and verify_password(password, user_record["password_hash"]):
            authenticated_user = str(user_record["username"])
            self.authenticated_user = authenticated_user
            self.user_id = user_record["id"]
            self.user_dir = (self.base_storage_dir / authenticated_user).resolve()
            self.user_dir.mkdir(parents=True, exist_ok=True)
            self.tap.authenticated(authenticated_user)
            self.reply(f"230 User {self.authenticated_user} logged in successfully.")
            print(f"[+] User '{self.authenticated_user}' authenticated via SQLite.")
        else:
            self.reply("530 Authentication failed.")

    def handle_list(self) -> None:
        assert self.user_dir is not None
        try:
            entries = []
            for item in self.user_dir.iterdir():
                item_type = "DIR" if item.is_dir() else "FILE"
                size = item.stat().st_size if item.is_file() else 0
                entries.append(f"{item_type}|{item.name}|{size}")

            self.reply(f"150 Opening ASCII mode data listing for {len(entries)} items.")
            for index, entry in enumerate(entries, start=1):
                send_line(self.sock, entry)
                self.tap.listing_entry(entry, index, len(entries))
            self.reply("226 Transfer complete.")
        except OSError as err:
            self.reply(f"550 Failed to list directory: {err}")

    def handle_size(self, args: str) -> None:
        filename = args.strip()
        safe_path = self._resolve_safe_path(filename)
        if not safe_path or not safe_path.is_file():
            self.reply(f"550 File '{filename}' not found.")
            return

        size = safe_path.stat().st_size
        self.reply(f"213 {size}")

    def handle_stor(self, args: str) -> None:
        parsed = _parse_stor(args)
        if parsed is None:
            self.reply("501 Syntax error: expected STOR <filename> <size>")
            return

        filename, total_bytes = parsed

        dest_path = self._resolve_safe_path(filename)
        if not dest_path:
            self.reply("553 Requested action not taken. Path traversal detected.")
            return

        self.reply(f"150 Ready to receive {total_bytes} bytes.")

        received = 0
        chunk_count = max(1, math.ceil(total_bytes / CHUNK_SIZE))
        self.tap.begin_stream()
        try:
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            with open(dest_path, "wb") as f:
                index = 0
                while received < total_bytes:
                    needed = total_bytes - received
                    chunk_to_read = min(needed, CHUNK_SIZE)
                    chunk = read_exact(self.sock, chunk_to_read, self.buffer)
                    f.write(chunk)
                    index += 1
                    self.tap.chunk(
                        chunk,
                        direction="CLIENT_TO_SERVER",
                        index=index,
                        count=chunk_count,
                        offset=received,
                        total=total_bytes,
                        filename=filename,
                    )
                    received += len(chunk)

            self.reply(f"226 Transfer complete. Saved {received} bytes.")
            print(f"[+] Successfully received file: {filename} ({received} bytes)")
        except OSError as err:
            self.reply(f"451 Transfer aborted due to local error: {err}")
            if dest_path.exists():
                dest_path.unlink(missing_ok=True)

    def handle_retr(self, args: str) -> None:
        filename = args.strip()
        safe_path = self._resolve_safe_path(filename)

        if not safe_path or not safe_path.is_file():
            self.reply(f"550 File '{filename}' not found.")
            return

        file_size = safe_path.stat().st_size
        self.reply(f"150 Opening binary mode transfer for {file_size} bytes.")

        try:
            header = struct.pack(HEADER_FORMAT, file_size)
            send_exact(self.sock, header)
            self.tap.length_prefix(header, file_size)

            sent = 0
            chunk_count = max(1, math.ceil(file_size / CHUNK_SIZE))
            self.tap.begin_stream()
            with open(safe_path, "rb") as f:
                index = 0
                while chunk := f.read(CHUNK_SIZE):
                    send_exact(self.sock, chunk)
                    index += 1
                    self.tap.chunk(
                        chunk,
                        direction="SERVER_TO_CLIENT",
                        index=index,
                        count=chunk_count,
                        offset=sent,
                        total=file_size,
                        filename=safe_path.name,
                    )
                    sent += len(chunk)

            self.reply("226 Transfer complete.")
            print(f"[+] Successfully sent file: {filename} ({sent} bytes)")
        except OSError as err:
            print(f"[!] Error during RETR: {err}")


class TCPServer:
    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 2121,
        storage_dir: str | None = None,
        hub: TelemetryHub = telemetry_hub,
        telemetry: bool | None = None,
    ):
        self.host = host
        self.port = port
        self.storage_dir = (
            Path(storage_dir).resolve() if storage_dir else USER_STORAGE_DIR
        )
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.server_socket: socket.socket | None = None
        self.running = False
        self.hub = hub
        # NETTRANSFER_TELEMETRY=0 turns the inspector feed off entirely.
        self.telemetry = (
            telemetry
            if telemetry is not None
            else os.environ.get("NETTRANSFER_TELEMETRY", "1") != "0"
        )
        self.forwarder: TelemetryForwarder | None = None
        self.ready = threading.Event()
        init_db()

    def start(self) -> None:
        self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_socket.bind((self.host, self.port))
        self.server_socket.listen(128)
        self.port = self.server_socket.getsockname()[1]
        self.running = True
        print(f"[*] NetTransfer TCP Server listening on {self.host}:{self.port}")
        print("[*] Database initialized: SQLite")
        print(f"[*] Sandboxed root storage: {self.storage_dir}")
        if self.telemetry and not self.hub.enabled:
            self.forwarder = TelemetryForwarder(server_addr=f":{self.port}").start()
            self.hub.attach_sink(self.forwarder)
        self.ready.set()

        try:
            while self.running:
                client_sock, addr = self.server_socket.accept()
                session = ClientSession(
                    client_sock, addr, self.storage_dir, server_port=self.port, hub=self.hub
                )
                t = threading.Thread(target=session.handle, daemon=True)
                t.start()
        except KeyboardInterrupt:
            print("\n[*] Shutting down server socket...")
        except OSError:
            # stop() closed the listening socket from another thread.
            if self.running:
                raise
        finally:
            self.stop()

    def stop(self) -> None:
        self.running = False
        if self.server_socket:
            self.server_socket.close()
        if self.forwarder is not None:
            self.hub.attach_sink(None)
            self.forwarder.stop()
            self.forwarder = None


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 2121
    server = TCPServer(port=port)
    server.start()