"""
Cross-thread telemetry hub.

The TCP server speaks to each client on its own OS thread. The control plane
serves WebSockets on an asyncio loop. This hub is the seam between the two:

    worker thread ── emit() ── loop.call_soon_threadsafe ──► asyncio.Queue
                                                              │
                                    dispatcher task ◄─────────┘
                                          │  seq, ring buffer
                                          ▼
                              one bounded queue per WebSocket

`emit()` never blocks the thread that is moving file bytes. When the inbox or
a subscriber queue is full the event is dropped and counted, never awaited.

In the TCP server process no loop is bound. There, `emit()` hands the event to
a `TelemetryForwarder` (see `link.py`) that carries it to the control plane.
"""

import asyncio
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Literal, Protocol

from .events import TelemetryEvent

RING_SIZE = 100
INBOX_SIZE = 20_000
SUBSCRIBER_QUEUE_SIZE = 4_000

Item = tuple[Literal["event"], TelemetryEvent] | tuple[Literal["tap"], bool]


class EventSink(Protocol):
    def submit(self, event: TelemetryEvent) -> None: ...


def _owner(username: str | None) -> str | None:
    return username.lower() if username else None


@dataclass(eq=False)
class Subscription:
    username: str
    queue: asyncio.Queue[Item] = field(default_factory=lambda: asyncio.Queue(SUBSCRIBER_QUEUE_SIZE))
    dropped: int = 0

    def offer(self, item: Item) -> None:
        """Queue an item, evicting the oldest one when the socket falls behind."""
        if self.queue.full():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self.dropped += 1
        self.queue.put_nowait(item)


class TelemetryHub:
    def __init__(self, ring_size: int = RING_SIZE) -> None:
        self._lock = threading.Lock()
        self._ring_size = ring_size
        self._rings: dict[str, deque[TelemetryEvent]] = {}
        self._subscribers: set[Subscription] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._inbox: asyncio.Queue[TelemetryEvent] | None = None
        self._dispatcher: asyncio.Task[None] | None = None
        self._sink: EventSink | None = None
        self._seq = 0
        self._taps = 0
        self.dropped = 0

    # --- producer side (any thread) ---

    @property
    def enabled(self) -> bool:
        """False when nothing would receive an event, so callers can skip building one."""
        return self._sink is not None or self._loop is not None

    def attach_sink(self, sink: EventSink | None) -> None:
        """Route emits to another process instead of a local loop."""
        self._sink = sink

    def emit(self, event: TelemetryEvent) -> None:
        """Thread-safe, non-blocking hand-off from a socket worker thread."""
        loop, inbox = self._loop, self._inbox
        if loop is not None and inbox is not None and loop.is_running():
            try:
                loop.call_soon_threadsafe(self._accept, event)
            except RuntimeError:
                # The loop closed between the check and the call.
                self.dropped += 1
            return
        sink = self._sink
        if sink is not None:
            sink.submit(event)

    # --- control-plane side (event loop) ---

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        """Start dispatching on `loop`. Call from inside that loop."""
        self._loop = loop
        self._inbox = asyncio.Queue(INBOX_SIZE)
        self._dispatcher = loop.create_task(self._dispatch(), name="telemetry-dispatch")

    async def close(self) -> None:
        task = self._dispatcher
        self._loop = None
        self._inbox = None
        self._dispatcher = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    def publish(self, event: TelemetryEvent) -> None:
        """Accept an event already on the loop thread, e.g. from the ingest link."""
        self._accept(event)

    def _accept(self, event: TelemetryEvent) -> None:
        inbox = self._inbox
        if inbox is None:
            return
        try:
            inbox.put_nowait(event)
        except asyncio.QueueFull:
            self.dropped += 1

    async def _dispatch(self) -> None:
        inbox = self._inbox
        assert inbox is not None
        while True:
            event = await inbox.get()
            owner = _owner(event.username)
            if owner is None:
                continue
            with self._lock:
                self._seq += 1
                stamped = event.model_copy(update={"seq": self._seq})
                ring = self._rings.get(owner)
                if ring is None:
                    ring = self._rings[owner] = deque(maxlen=self._ring_size)
                ring.append(stamped)
                targets = [sub for sub in self._subscribers if sub.username == owner]
            for sub in targets:
                sub.offer(("event", stamped))

    def subscribe(self, username: str) -> tuple[Subscription, list[TelemetryEvent]]:
        """Register a socket. Returns its queue and the recent backlog for that user."""
        owner = _owner(username) or ""
        sub = Subscription(owner)
        with self._lock:
            self._subscribers.add(sub)
            backlog = list(self._rings.get(owner, ()))
        return sub, backlog

    def unsubscribe(self, sub: Subscription) -> None:
        with self._lock:
            self._subscribers.discard(sub)

    # --- tap presence: is a TCP server feeding this hub? ---

    @property
    def tap_attached(self) -> bool:
        return self._taps > 0

    def set_tap(self, attached: bool) -> None:
        """Called on the loop thread when a TCP server links or unlinks."""
        before = self.tap_attached
        self._taps = max(0, self._taps + (1 if attached else -1))
        if self.tap_attached == before:
            return
        with self._lock:
            targets = list(self._subscribers)
        for sub in targets:
            sub.offer(("tap", self.tap_attached))


telemetry_hub = TelemetryHub()
