# TASK SPECIFICATION: Live TCP Protocol Inspector & Real-Time Telemetry Pipeline for NetTransfer

## 1. Context & Objective
NetTransfer is an academic networking and full-stack project implementing a custom, FTP-inspired application-layer protocol directly over raw TCP sockets (`apps/server/src/networking/tcp_server.py`) with a FastAPI control plane and a React 19 + TypeScript frontend.

Instead of building a detached toy simulation, we want a **real-time "Protocol Inspector / Wireshark in the Browser"** view. 
When real files are uploaded or downloaded through the UI/API, the backend must emit real network and protocol frame telemetry over WebSockets to React. The React frontend will render a live, animated sequence ladder, a layer 4 vs. layer 7 frame parser breakdown, and live wire metrics matching actual Wireshark captures.

---

## 2. Architecture & Telemetry Pipeline


```

[ React Frontend ]  ◄── WebSocket (`/ws/telemetry`) ──►  [ FastAPI Event Broadcaster ]
│                                                              ▲
│ HTTP REST (Upload/Download/Auth)                             │ In-memory async queue /
▼                                                              │ event hook
[ FastAPI Bridge ] ──── Raw TCP Sockets (port 2121) ────► [ TCP File Server ]
(Emits Telemetry Events:
CONNECT, HANDSHAKE, AUTH,
STOR, RETR, CHUNK, 226, CLOSE)

```

---

## 3. Detailed Technical Requirements

### A. Backend: Telemetry Engine (`apps/server/src/telemetry/`)
1. **Event Schema (`apps/server/src/telemetry/events.py`):**
   Define structured Pydantic models for socket telemetry events:
   - `timestamp`: Float ISO millisecond epoch.
   - `connection_id`: Unique ID for each client socket connection.
   - `direction`: `"CLIENT_TO_SERVER"` | `"SERVER_TO_CLIENT"`.
   - `layer`: `"L4_TCP"` | `"L7_APP"`.
   - `event_type`: 
     - `"TCP_CONNECT"` (3-way handshake synthetic mark)
     - `"COMMAND_FRAME"` (`AUTH`, `PWD`, `LIST`, `STOR`, `RETR`, `SIZE`, `QUIT`)
     - `"STATUS_FRAME"` (`150`, `200`, `220`, `226`, `530`, `550`, etc.)
     - `"DATA_CHUNK"` (for binary stream: `chunk_index`, `chunk_bytes`, `total_bytes`, `rolling_mbps`)
     - `"TCP_CLOSE"` (`FIN/ACK`)
   - `raw_frame_repr`: Exact byte string representation (e.g., `STOR report.pdf 1048576\n` or `[0x00 0x00 0x00 0x00 0x00 0x10 0x00 0x00]`).
   - `description`: Plain-English explanation for educational evaluators.

2. **Telemetry Broadcaster (`apps/server/src/telemetry/hub.py`):**
   - Thread-safe singleton hub.
   - Accepts event emissions from the synchronous, multi-threaded `tcp_server.py`.
   - Dispatches events to an asynchronous `asyncio.Queue` consumed by FastAPI's WebSocket endpoint.
   - Keeps an in-memory ring-buffer of the last 100 events so newly connected React clients receive immediate context.

3. **Instrumenting the TCP Server (`apps/server/src/networking/tcp_server.py`):**
   - Emit `"TCP_CONNECT"` upon `server_socket.accept()`.
   - Emit `"COMMAND_FRAME"` for each newline-delimited command read.
   - Emit `"STATUS_FRAME"` for each server response sent.
   - Emit `"DATA_CHUNK"` on every 64 KB chunk in both `handle_stor` and `handle_retr` with byte offsets and timing.
   - Emit `"TCP_CLOSE"` when the socket cleanly closes or disconnects.

4. **FastAPI WebSocket Route (`apps/server/src/main.py` & `routes.py`):**
   - Expose `ws://localhost:8000/ws/telemetry`.
   - Handles client connect/disconnect without breaking the main API server.
   - Pushes serialized JSON telemetry frames in real time.

---

### B. Frontend: UI/UX & Visualizer Architecture (`apps/web/src/`)
Implement an elegant, modern dark-mode dashboard reflecting Linear/Vercel design sensibilities:
- Dark slate/zinc palette (`#090d16` canvas, `#0f172a` card base, `#1e293b` borders).
- 1px specular gradient borders on cards.
- Bioluminescent status pills (Emerald for active connection, Cyan for TCP streaming).
- High visual scannability, zero AI slop, strict typographic hierarchy (`tabular-nums` for speeds and bytes).

#### 1. Navigation Shell & Mode Switcher
In the top navigation bar, provide a seamless segmented toggle:
- **[ 📁 File Manager ]**: Full file explorer table, breadcrumbs, upload drag-and-drop, and active transfer card.
- **[ ⚡ Protocol Inspector ]**: The live networking telemetric observatory.
- Display a live WebSocket connection beacon in the top right: `● LIVE SOCKET CONNECTED`.

#### 2. The Protocol Inspector Layout (`apps/web/src/pages/ProtocolInspector.tsx`)
Split into 3 distinct functional panes:

- **Pane 1: Animated Live Sequence Ladder (Left, 55% width)**
  - Two vertical timelines representing `Client (127.0.0.1:port)` and `Server (:2121)`.
  - Horizontally traversing packet nodes with directional arrows.
  - Color-coded packet pills:
    - **Purple:** TCP Handshake / Teardown (`SYN`, `ACK`, `FIN`)
    - **Blue:** L7 Command (`STOR`, `RETR`, `AUTH`, `LIST`)
    - **Green:** L7 Status Response (`150 Ready`, `226 Complete`, `230 OK`)
    - **Cyan Shimmer:** Binary Data Chunks (`Chunk 3/16 • 64 KB • 124.5 MB/s`)
  - Auto-scroll to latest packet with a toggleable "Pause / Auto-scroll" lock.
  - Clicking any packet opens its byte payload in Pane 2.

- **Pane 2: Deep-Dive Packet & Stream Framing Inspector (Right Top, 45% width)**
  - **The "Why TCP is Hard" explainer box**:
    - Displays raw Layer 4 continuous byte stream.
    - Shows how NetTransfer protocol framing splits it into Delimiter (`\n`) vs. 8-Byte Length-Prefix Header (`struct.pack('>Q')`).
  - Raw Hex / ASCII preview of the selected packet frame.
  - Calculated wire metrics: Frame payload size, latency delta from previous packet.

- **Pane 3: Wireshark Correlator & Live Telemetry Summary (Right Bottom)**
  - Live summary statistics: Total bytes transferred, active socket connection duration, throughput meter.
  - "Wireshark Parity Mode" toggle: Formats the packet list into a classic Wireshark column layout (`No.`, `Time`, `Source`, `Destination`, `Protocol`, `Length`, `Info`) so the student can compare it side-by-side with an actual Wireshark capture window during university defense.

---

## 4. File-by-File Implementation Plan

Claude Code should create/modify the following files in order:

1. **`apps/server/src/telemetry/events.py`**: Pydantic models for socket events.
2. **`apps/server/src/telemetry/hub.py`**: Async/sync cross-thread telemetry dispatch hub.
3. **`apps/server/src/networking/tcp_server.py`**: Connect hooks to emit telemetry events on connect, commands, binary chunks, and disconnects.
4. **`apps/server/src/main.py`**: Add `/ws/telemetry` WebSocket endpoint.
5. **`apps/web/src/types/telemetry.ts`**: TypeScript definitions matching Python Pydantic models.
6. **`apps/web/src/hooks/useTelemetryWebSocket.ts`**: Custom hook managing WebSocket connection, reconnect logic, and event ring-buffer.
7. **`apps/web/src/components/inspector/SequenceLadder.tsx`**: The animated client/server packet ladder.
8. **`apps/web/src/components/inspector/FrameInspector.tsx`**: Raw stream defragmentation and Hex/ASCII breakdown.
9. **`apps/web/src/components/inspector/WiresharkTable.tsx`**: Filterable packet log with Wireshark styling.
10. **`apps/web/src/pages/ProtocolInspector.tsx`**: Integrated page view.
11. **`apps/web/src/App.tsx`**: Wire up navigation switching between File Explorer and Protocol Inspector.

---

## 5. Execution Rules for Claude Code
- **No Mock or Random Timers:** Do not invent `setInterval` dummy packets in React. Every event on the sequence ladder must come from real socket activity via the WebSocket.
- **Thread Safety:** The TCP server runs on multiple Python OS threads while FastAPI runs an `asyncio` event loop. Claude Code must properly bridge thread-safe calls (`loop.call_soon_threadsafe` or `asyncio.run_coroutine_threadsafe`) when forwarding events to the WebSocket queue.
- **Type Safety & Zero Build Errors:** Ensure `uv run pytest`, `pnpm build`, and TypeScript compilation pass with 0 errors.

```

---