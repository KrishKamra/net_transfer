"""
Internal bridge allowing FastAPI endpoints to execute file operations
over raw TCP sockets against the running NetTransfer TCP server.
"""

import socket
from collections.abc import Callable
from typing import BinaryIO

from .protocol import (
    ProtocolError,
    read_exact,
    read_line,
    send_exact,
    send_line,
    unpack_payload_header,
)

CHUNK_SIZE = 64 * 1024


class TCPClientBridge:
    def __init__(self, host: str = "127.0.0.1", port: int = 2121):
        self.host = host
        self.port = port

    def _connect_and_auth(self, username: str, raw_password: str) -> tuple[socket.socket, bytearray]:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.connect((self.host, self.port))
        buf = bytearray()
        
        banner = read_line(sock, buf)
        if not banner or not banner.startswith("220"):
            sock.close()
            raise ProtocolError(f"Bad banner: {banner}")

        send_line(sock, f"AUTH {username} {raw_password}")
        resp = read_line(sock, buf)
        if not resp or not resp.startswith("230"):
            sock.close()
            raise ProtocolError(f"Auth failed on TCP layer: {resp}")

        return sock, buf

    def upload_stream(
        self,
        username: str,
        raw_password: str,
        filename: str,
        file_size: int,
        stream: BinaryIO,
        on_progress: Callable[[int], None] | None = None,
    ) -> str:
        """Connects over TCP and streams upload bytes."""
        sock, buf = self._connect_and_auth(username, raw_password)
        try:
            send_line(sock, f"STOR {filename} {file_size}")
            resp = read_line(sock, buf)
            if not resp or not resp.startswith("150"):
                raise ProtocolError(f"Server rejected STOR: {resp}")

            sent = 0
            while sent < file_size:
                chunk = stream.read(CHUNK_SIZE)
                if not chunk:
                    break
                send_exact(sock, chunk)
                sent += len(chunk)
                if on_progress:
                    on_progress(len(chunk))

            final_resp = read_line(sock, buf)
            if not final_resp or not final_resp.startswith("226"):
                raise ProtocolError(f"Upload failed to finalize: {final_resp}")

            return final_resp
        finally:
            send_line(sock, "QUIT")
            sock.close()

    def download_file(
        self,
        username: str,
        raw_password: str,
        filename: str,
        on_size: Callable[[int], None] | None = None,
        on_progress: Callable[[int], None] | None = None,
    ) -> tuple[int, bytes]:
        """Connects over TCP, executes RETR, and returns file bytes."""
        sock, buf = self._connect_and_auth(username, raw_password)
        try:
            send_line(sock, f"RETR {filename}")
            resp = read_line(sock, buf)
            if not resp or not resp.startswith("150"):
                raise ProtocolError(f"Server rejected RETR: {resp}")

            file_size = unpack_payload_header(sock, buf)
            if on_size:
                on_size(file_size)

            received = 0
            parts: list[bytes] = []
            while received < file_size:
                chunk = read_exact(sock, min(CHUNK_SIZE, file_size - received), buf)
                parts.append(chunk)
                received += len(chunk)
                if on_progress:
                    on_progress(len(chunk))
            data = b"".join(parts)

            read_line(sock, buf)
            return file_size, data
        finally:
            send_line(sock, "QUIT")
            sock.close()