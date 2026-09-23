"""
Milestone 2 interactive CLI harness.
Supports AUTH, LIST, PWD, SIZE, STOR (upload), and RETR (download) with progress.
"""

import socket
import sys
import time
from pathlib import Path

from .protocol import (
    read_exact,
    read_line,
    send_exact,
    send_line,
    unpack_payload_header,
)

CHUNK_SIZE = 64 * 1024


def print_progress(transferred: int, total: int, prefix: str = "Progress"):
    percent = (transferred / total) * 100 if total > 0 else 100
    bar_length = 30
    filled = int(bar_length * transferred // total) if total > 0 else bar_length
    bar = "█" * filled + "░" * (bar_length - filled)
    sys.stdout.write(f"\r{prefix} |{bar}| {percent:.1f}% ({transferred}/{total} bytes)")
    sys.stdout.flush()
    if transferred >= total:
        sys.stdout.write("\n")


def handle_upload(sock: socket.socket, buffer: bytearray, local_path_str: str):
    local_path = Path(local_path_str)
    if not local_path.is_file():
        print(f"[!] Local file '{local_path}' does not exist.")
        return

    file_size = local_path.stat().st_size
    filename = local_path.name

    # 1. Send STOR command
    send_line(sock, f"STOR {filename} {file_size}")

    # 2. Wait for 150 Ready
    resp = read_line(sock, buffer)
    if not resp or not resp.startswith("150"):
        print(f"[Server Error] {resp}")
        return

    print(f"[Server] {resp}")
    print(f"[*] Uploading {filename} ({file_size} bytes)...")

    # 3. Stream binary data in 64 KB chunks
    sent = 0
    start_time = time.time()
    with open(local_path, "rb") as f:
        while chunk := f.read(CHUNK_SIZE):
            send_exact(sock, chunk)
            sent += len(chunk)
            print_progress(sent, file_size, prefix="Uploading")

    elapsed = max(time.time() - start_time, 0.001)
    speed_mb = (sent / (1024 * 1024)) / elapsed
    print(f"[*] Upload completed in {elapsed:.2f}s ({speed_mb:.2f} MB/s)")

    # 4. Read final confirmation
    final_resp = read_line(sock, buffer)
    print(f"[Server] {final_resp}")


def handle_download(sock: socket.socket, buffer: bytearray, remote_filename: str):
    # 1. Send RETR command
    send_line(sock, f"RETR {remote_filename}")

    # 2. Wait for 150 response
    resp = read_line(sock, buffer)
    if not resp or not resp.startswith("150"):
        print(f"[Server Error] {resp}")
        return

    print(f"[Server] {resp}")

    # 3. Read 8-byte length prefix
    expected_size = unpack_payload_header(sock, buffer)
    print(f"[*] Receiving {remote_filename} ({expected_size} bytes)...")

    # 4. Stream bytes into local file
    out_dir = Path("./downloads")
    out_dir.mkdir(exist_ok=True)
    out_file = out_dir / remote_filename

    received = 0
    start_time = time.time()
    with open(out_file, "wb") as f:
        while received < expected_size:
            needed = expected_size - received
            chunk_to_read = min(needed, CHUNK_SIZE)
            chunk = read_exact(sock, chunk_to_read, buffer)
            f.write(chunk)
            received += len(chunk)
            print_progress(received, expected_size, prefix="Downloading")

    elapsed = max(time.time() - start_time, 0.001)
    speed_mb = (received / (1024 * 1024)) / elapsed
    print(f"[*] Saved to {out_file} in {elapsed:.2f}s ({speed_mb:.2f} MB/s)")

    # 5. Read final confirmation
    final_resp = read_line(sock, buffer)
    print(f"[Server] {final_resp}")


def run_client(host: str = "127.0.0.1", port: int = 2121):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect((host, port))
        buffer = bytearray()

        banner = read_line(sock, buffer)
        print(f"[Server] {banner}")

        while True:
            cmd = input("NetTransfer> ").strip()
            if not cmd:
                continue

            parts = cmd.split(" ", 1)
            action = parts[0].upper()
            target = parts[1].strip() if len(parts) > 1 else ""

            if action == "PUT":
                if not target:
                    print("Usage: PUT <local_path>")
                    continue
                handle_upload(sock, buffer, target)
            elif action == "GET":
                if not target:
                    print("Usage: GET <remote_filename>")
                    continue
                handle_download(sock, buffer, target)
            else:
                send_line(sock, cmd)
                response = read_line(sock, buffer)
                if response is None:
                    print("[!] Server closed connection.")
                    break
                print(f"[Server] {response}")

                if response.startswith("150") and action == "LIST":
                    while True:
                        line = read_line(sock, buffer)
                        if line is None:
                            break
                        print(f"  {line}")
                        if line.startswith("226"):
                            break

                if action == "QUIT":
                    break

    except KeyboardInterrupt:
        print("\nExiting...")
    except ConnectionRefusedError:
        print(f"[!] Could not connect to {host}:{port}. Is the server running?")
    finally:
        sock.close()


if __name__ == "__main__":
    h = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    p = int(sys.argv[2]) if len(sys.argv) > 2 else 2121
    run_client(h, p)