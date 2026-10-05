"""The job loop: lease, heartbeat, run, report, release.

SQS is the lease. A received message is invisible for the visibility timeout;
a heartbeat thread extends it while the job runs and reports progress on the
events queue at the same cadence. If the process dies, both stop, and SQS hands
the job to a worker again when the lease lapses — the backend sees the missing
heartbeats too.

The message is deleted only after the job's terminal event (completed, failed or
cancelled) has been sent. Retrying a failed attempt is the backend's decision,
made from that event; the worker never silently retries on its own.

Duplicate delivery is expected. A job this worker already completed is
re-reported from the ledger without recomputing, and each attempt writes under
its own prefix, so a duplicate can never overwrite another attempt's output.
"""

from __future__ import annotations

import json
import logging
import signal
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from pydantic import ValidationError

from .aws import Aws
from .config import WorkerConfig
from .context import JobContext, JobFailure
from .contract import RETRYABLE_FAILURES, CapturePrivacyJob, Event, Failure, ResultRef, parse_job
from .storage import ContentCache, Ledger, Scratch
from .telemetry import healthy

log = logging.getLogger("goway.worker")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Runner:
    def __init__(self, config: WorkerConfig, aws: Aws) -> None:
        self.config = config
        self.aws = aws
        self.worker_id = config.worker_id()
        self.cache = ContentCache(config.cache_dir, int(config.cache_max_gb * 2**30))
        self.scratch = Scratch(config.scratch_dir, config.failed_scratch_keep_hours)
        self.ledger = Ledger(config.state_path)
        self.draining = threading.Event()
        self._detectors = None
        self._depth = None
        self._device = None
        self.completed = 0

    # ── lifecycle ──────────────────────────────────────────────────────────

    def drain_flag(self) -> Path:
        return self.config.data_dir / "drain"

    def install_signals(self) -> None:
        def handler(signum, _frame):  # noqa: ANN001
            log.info("drain requested; finishing the current job")
            self.draining.set()

        signal.signal(signal.SIGTERM, handler)
        signal.signal(signal.SIGINT, handler)

    def recover(self) -> None:
        """What a previous process left behind."""
        interrupted = self.ledger.interrupted()
        if interrupted:
            log.info("%d job(s) were interrupted; their checkpoints are kept for redelivery", len(interrupted))
        removed = self.scratch.sweep()
        if removed:
            log.info("removed %d stale scratch director(ies)", removed)

    def device(self):
        if self._device is None:
            import torch

            from . import toolchain

            toolchain.prepare(self.config.build_dir)
            self._device = torch.device("cuda")
        return self._device

    def detectors(self):
        if self._detectors is None:
            from .privacy.detectors import PrivacyDetectors

            self._detectors = PrivacyDetectors(self.config.models_dir, self.device())
        return self._detectors

    def depth_prior(self):
        if self._depth is None:
            from .recon.depth import DepthPrior

            self._depth = DepthPrior(self.config.models_dir, self.device())
        return self._depth

    # ── loop ───────────────────────────────────────────────────────────────

    def run(self, *, max_jobs: int | None = None, max_hours: float | None = None) -> int:
        deadline = time.monotonic() + max_hours * 3600 if max_hours else None
        self.recover()
        while not self.draining.is_set() and not self.drain_flag().exists():
            if max_jobs is not None and self.completed >= max_jobs:
                break
            if deadline is not None and time.monotonic() >= deadline:
                break
            ok, reason = healthy(self.config.max_gpu_temperature_c, self.config.min_free_disk_gb, self.config.data_dir)
            if not ok:
                log.warning("not accepting work: %s", reason)
                time.sleep(60)
                continue
            message = self.aws.receive()
            if message is None:
                continue
            self.handle(message)
        return self.completed

    def handle(self, message) -> None:  # noqa: ANN001
        try:
            job = parse_job(message.body)
        except (ValidationError, ValueError):
            # Not ours to interpret. Leave it: the redrive policy moves it to the DLQ.
            log.error("received a message that is not a valid job envelope")
            return
        attempt = message.attempt
        ctx = JobContext(job_id=job.jobId, attempt=attempt)

        def emit(kind: str, **extra) -> None:
            event = Event(eventId=str(uuid.uuid4()), jobId=job.jobId, attempt=attempt, workerId=self.worker_id, type=kind, at=_now(), **extra)
            self.aws.emit(event.model_dump(exclude_none=True))

        done = self.ledger.completed_result(job.jobId)
        if done is not None and self.aws.exists(done[0]):
            emit("completed", result=ResultRef(key=done[0], sha256=done[1], byteSize=done[2]))
            self.aws.delete(message)
            log.info("job %s was already completed here; re-reported", job.jobId)
            return
        if self.aws.exists(f"jobs/{job.jobId}/cancel"):
            emit("cancelled")
            self.aws.delete(message)
            return

        self.ledger.start(job.jobId, attempt)
        lease_seconds = self.config.visibility_timeout_seconds
        emit("leased", leaseExpiresAt=_iso_in(lease_seconds))
        ctx.stage_listeners.append(lambda stage: emit("stage", stage=stage, progress=0.0))

        stop = threading.Event()

        def heartbeat() -> None:
            while not stop.wait(self.config.heartbeat_seconds):
                try:
                    self.aws.extend(message, lease_seconds)
                    emit("heartbeat", stage=ctx.stage, progress=round(ctx.progress, 3), leaseExpiresAt=_iso_in(lease_seconds))
                    if self.aws.exists(f"jobs/{job.jobId}/cancel"):
                        ctx.cancelled.set()
                except Exception:  # noqa: BLE001 - a missed beat is not fatal; the lease is long
                    log.warning("heartbeat failed for job %s", job.jobId)

        beat = threading.Thread(target=heartbeat, daemon=True)
        beat.start()
        work = self.scratch.for_job(job.jobId)
        started = time.monotonic()
        try:
            result = self._execute(job, ctx, work)
            payload = json.dumps(result.model_dump(exclude_none=True), separators=(",", ":")).encode()
            key = f"{job.outputPrefix}attempt-{attempt}/result.json"
            sha, size = self.aws.put(key, payload, "application/json")
            emit("completed", result=ResultRef(key=key, sha256=sha, byteSize=size), metrics={"wallSeconds": round(time.monotonic() - started, 1)})
            self.ledger.finish(job.jobId, "completed", (key, sha, size))
            self.ledger.bump("gpu_seconds", time.monotonic() - started)
            self.scratch.finish(job.jobId)
            self.completed += 1
            log.info("job %s completed (%s)", job.jobId, job.jobType)
        except JobFailure as failure:
            kind = "cancelled" if failure.code == "cancelled" else "failed"
            if kind == "cancelled":
                emit("cancelled", stage=ctx.stage)
            else:
                emit(
                    "failed",
                    stage=ctx.stage,
                    failure=Failure(code=failure.code, retryable=failure.code in RETRYABLE_FAILURES, detail=failure.detail),
                )
            self.ledger.finish(job.jobId, kind)
            self.scratch.keep_diagnostics(job.jobId, {"code": failure.code, "detail": failure.detail, "stage": ctx.stage})
            log.info("job %s %s at %s: %s", job.jobId, kind, ctx.stage, failure.code)
        except Exception as error:  # noqa: BLE001
            emit("failed", stage=ctx.stage, failure=Failure(code="internal", retryable=True, detail=type(error).__name__))
            self.ledger.finish(job.jobId, "failed")
            self.scratch.keep_diagnostics(job.jobId, {"code": "internal", "error": type(error).__name__, "stage": ctx.stage})
            log.exception("job %s failed unexpectedly", job.jobId)
        finally:
            stop.set()
            beat.join(timeout=5)
        self.aws.delete(message)

    def _execute(self, job, ctx: JobContext, work: Path):  # noqa: ANN001
        if isinstance(job, CapturePrivacyJob):
            from .privacy import job as privacy_job

            return privacy_job.run(job, ctx, self.aws, self.detectors(), work)
        from .recon import job as scene_job

        device = self.device()
        # The monocular depth prior stays available (depth_prior=self.depth_prior())
        # but is not used by default: in side-by-side tests it softened scenes.
        return scene_job.run(job, ctx, self.aws, self.cache, work, device)


def _iso_in(seconds: int) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
