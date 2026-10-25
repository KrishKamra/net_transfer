"""
Telemetry event schema for the Protocol Inspector.

One `TelemetryEvent` describes one thing that crossed port 2121: the accepted
connection, a newline-framed command or reply, the 8-byte length prefix in
front of a RETR payload, a 64 KB slice of file bytes, or the close.

The same model is serialised by the TCP server process, validated again when
the control plane ingests it, and sent to the browser as JSON. The TypeScript
mirror lives in `apps/web/src/types/telemetry.ts`.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Direction = Literal["CLIENT_TO_SERVER", "SERVER_TO_CLIENT"]
Layer = Literal["L4_TCP", "L7_APP"]
EventType = Literal[
    "TCP_CONNECT",
    "COMMAND_FRAME",
    "STATUS_FRAME",
    "LENGTH_PREFIX",
    "DATA_CHUNK",
    "TCP_CLOSE",
]

# Bytes of real payload copied into `payload_hex`. Enough for a command line
# or the start of a chunk. The full frame size is always in `frame_bytes`.
PREVIEW_BYTES = 64


class ChunkInfo(BaseModel):
    """Position of one DATA_CHUNK inside its STOR or RETR stream."""

    model_config = ConfigDict(extra="forbid")

    chunk_index: int = Field(ge=1)
    chunk_count: int = Field(ge=1)
    chunk_bytes: int = Field(ge=0)
    offset: int = Field(ge=0, description="Stream offset of the first byte in this chunk.")
    total_bytes: int = Field(ge=0)
    rolling_mbps: float = Field(ge=0, description="MiB/s over the last few chunks.")
    filename: str | None = None


class TelemetryEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int = Field(default=0, ge=0, description="Assigned by the control plane hub on ingest.")
    timestamp: float = Field(description="Unix epoch in milliseconds, with sub-ms precision.")
    connection_id: str = Field(min_length=1, max_length=32)
    username: str | None = Field(default=None, max_length=64)
    client_addr: str = Field(max_length=64)
    server_addr: str = Field(max_length=64)
    direction: Direction
    layer: Layer
    event_type: EventType
    verb: str | None = Field(default=None, max_length=16, description="Command verb or 3-digit reply code.")
    frame_bytes: int = Field(ge=0, description="Bytes this frame occupied on the wire.")
    raw_frame_repr: str = Field(max_length=512)
    payload_hex: str = Field(default="", max_length=PREVIEW_BYTES * 2)
    description: str = Field(max_length=512)
    chunk: ChunkInfo | None = None
