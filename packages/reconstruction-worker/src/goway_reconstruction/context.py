"""What a running job can see of its own lease."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field

from .contract import FailureCode


class JobFailure(Exception):
    """A classified failure. ``detail`` is short and contains no sensitive values."""

    def __init__(self, code: FailureCode, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail[:300]


class Cancelled(JobFailure):
    def __init__(self) -> None:
        super().__init__("cancelled", "cancelled by the backend")


@dataclass
class JobContext:
    job_id: str
    attempt: int
    stage: str = "preparing"
    progress: float = 0.0
    cancelled: threading.Event = field(default_factory=threading.Event)
    stage_listeners: list = field(default_factory=list)

    def enter(self, stage: str) -> None:
        """Begin a stage. Every stage boundary is a safe cancellation point."""
        self.check()
        self.stage = stage
        self.progress = 0.0
        for listener in self.stage_listeners:
            listener(stage)

    def report(self, progress: float) -> None:
        self.progress = max(0.0, min(1.0, progress))
        self.check()

    def check(self) -> None:
        if self.cancelled.is_set():
            raise Cancelled()
