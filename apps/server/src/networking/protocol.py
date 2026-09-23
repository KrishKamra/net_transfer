"""
Protocol framing layer for NetTransfer.

TCP is a continuous byte stream without application-level boundaries.
This module enforces:
1. Command framing: Delimiter-based ('\\n') text parsing.
2. Binary framing: Length-prefixed header (8-byte unsigned integer, big-endian '>Q').
"""

import socket
import struct

HEADER_FORMAT = ">Q"  # 8-byte unsigned long long (up to 18 Exabytes)
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)


class ProtocolError(Exception):
    """Raised when protocol invariants are violated or streams disconnect unexpectedly."""


def send_line(sock: socket.socket, line: str) -> None:
    """Send a newline-terminated UTF-8 command string."""
    if not line.endswith("\n"):
        line += "\n"
    sock.sendall(line.encode("utf-8"))


def read_line(sock: socket.socket, buffer: bytearray) -> str | None:
    """
    Read from a socket until a newline delimiter is found, using an internal bytearray buffer.
    Returns the decoded string (without '\\n') or None if client closed connection.
    """
    while True:
        newline_idx = buffer.find(b"\n")
        if newline_idx != -1:
            line_bytes = buffer[:newline_idx]
            # Strip trailing carriage return if CRLF was sent
            if line_bytes.endswith(b"\r"):
                line_bytes = line_bytes[:-1]
            del buffer[: newline_idx + 1]
            return line_bytes.decode("utf-8")

        chunk = sock.recv(4096)
        if not chunk:
            if buffer:
                # Connection dropped mid-command
                remaining = buffer.decode("utf-8", errors="replace")
                buffer.clear()
                return remaining
            return None
        buffer.extend(chunk)


def send_exact(sock: socket.socket, data: bytes) -> None:
    """Send an exact byte slice using socket.sendall."""
    sock.sendall(data)


def read_exact(sock: socket.socket, num_bytes: int, buffer: bytearray) -> bytes:
    """
    Read an exact number of bytes from the buffer and socket.
    Raises ProtocolError if the connection drops prematurely.
    """
    out = bytearray()

    # Drain available bytes from buffer first
    if buffer:
        take = min(len(buffer), num_bytes)
        out.extend(buffer[:take])
        del buffer[:take]

    # Fetch remaining bytes from the network
    while len(out) < num_bytes:
        needed = num_bytes - len(out)
        chunk = sock.recv(min(needed, 65536))
        if not chunk:
            raise ProtocolError(
                f"Unexpected EOF: expected {num_bytes} bytes, received {len(out)} bytes."
            )
        out.extend(chunk)

    return bytes(out)


def pack_payload(payload: bytes) -> bytes:
    """Prefix binary data with an 8-byte big-endian length header."""
    return struct.pack(HEADER_FORMAT, len(payload)) + payload


def unpack_payload_header(sock: socket.socket, buffer: bytearray) -> int:
    """Read and decode the 8-byte payload size header."""
    raw_header = read_exact(sock, HEADER_SIZE, buffer)
    (payload_length,) = struct.unpack(HEADER_FORMAT, raw_header)
    return payload_length
