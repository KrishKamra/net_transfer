"""
Transfer Manager: Coordinates file transfers, metric calculations (speed, ETA),
and state synchronization with SQLite and live listeners.
"""

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from ..storage.db import (
    record_transfer_finish,
    record_transfer_start,
    set_transfer_size,
)


@dataclass
class TransferSnapshot:
    transfer_id: str
    user_id: int
    filename: str
    direction: str  # "UPLOAD" or "DOWNLOAD"
    total_bytes: int
    transferred_bytes: int
    progress_pct: float
    speed_bps: float
    speed_mbps: float
    eta_seconds: int | None
    status: str


class ActiveTransfer:
    def __init__(
        self,
        transfer_id: str,
        user_id: int,
        filename: str,
        direction: str,
        total_bytes: int,
        on_update: Callable[[TransferSnapshot], None] | None = None,
    ):
        self.transfer_id = transfer_id
        self.user_id = user_id
        self.filename = filename
        self.direction = direction
        self.total_bytes = total_bytes
        self.transferred_bytes = 0
        self.status = "TRANSFERRING"
        self.start_time = time.time()
        self.last_update_time = self.start_time
        self.last_bytes = 0
        self.current_speed = 0.0
        self.on_update = on_update

        # Persist initial record
        record_transfer_start(
            self.transfer_id,
            self.user_id,
            self.filename,
            self.direction,
            self.total_bytes,
        )

    def update_bytes(self, chunk_len: int) -> None:
        self.transferred_bytes += chunk_len
        now = time.time()
        elapsed = now - self.last_update_time
        first_bytes = self.last_bytes == 0 and self.transferred_bytes > 0

        # First chunk is reported immediately. Later samples stay on a 250ms window.
        if first_bytes or elapsed >= 0.25 or self.transferred_bytes >= self.total_bytes:
            instant_bytes = self.transferred_bytes - self.last_bytes
            self.current_speed = instant_bytes / max(elapsed, 0.001)
            self.last_update_time = now
            self.last_bytes = self.transferred_bytes

            if self.on_update:
                self.on_update(self.snapshot())

    def finish(self, status: str = "COMPLETED") -> None:
        self.status = status
        record_transfer_finish(self.transfer_id, self.status, self.transferred_bytes)
        if self.on_update:
            self.on_update(self.snapshot())

    def set_total(self, total_bytes: int) -> None:
        self.total_bytes = total_bytes
        set_transfer_size(self.transfer_id, total_bytes)
        if self.on_update:
            self.on_update(self.snapshot())

    def snapshot(self) -> TransferSnapshot:
        if self.total_bytes > 0:
            pct = round((self.transferred_bytes / self.total_bytes) * 100, 2)
        elif self.status == "COMPLETED":
            pct = 100.0
        else:
            pct = 0.0
        remaining_bytes = max(self.total_bytes - self.transferred_bytes, 0)
        if self.total_bytes <= 0 and self.status != "COMPLETED":
            eta = None
        elif self.current_speed > 0 and remaining_bytes > 0:
            eta = int(remaining_bytes / self.current_speed)
        elif remaining_bytes == 0:
            eta = 0
        else:
            eta = None

        return TransferSnapshot(
            transfer_id=self.transfer_id,
            user_id=self.user_id,
            filename=self.filename,
            direction=self.direction,
            total_bytes=self.total_bytes,
            transferred_bytes=self.transferred_bytes,
            progress_pct=pct,
            speed_bps=round(self.current_speed, 2),
            speed_mbps=round(self.current_speed / (1024 * 1024), 2),
            eta_seconds=eta,
            status=self.status,
        )


class TransferManager:
    """Singleton-style coordinator for tracking active uploads/downloads."""

    def __init__(self):
        self._active_transfers: dict[str, ActiveTransfer] = {}

    def start_transfer(
        self,
        user_id: int,
        filename: str,
        direction: str,
        total_bytes: int,
        on_update: Callable[[TransferSnapshot], None] | None = None,
        transfer_id: str | None = None,
    ) -> ActiveTransfer:
        transfer_id = transfer_id or str(uuid.uuid4())
        transfer = ActiveTransfer(
            transfer_id=transfer_id,
            user_id=user_id,
            filename=filename,
            direction=direction,
            total_bytes=total_bytes,
            on_update=on_update,
        )
        self._active_transfers[transfer_id] = transfer
        return transfer

    def get_transfer(self, transfer_id: str) -> ActiveTransfer | None:
        return self._active_transfers.get(transfer_id)

    def remove_transfer(self, transfer_id: str) -> None:
        self._active_transfers.pop(transfer_id, None)


# Global transfer manager instance
transfer_manager = TransferManager()
