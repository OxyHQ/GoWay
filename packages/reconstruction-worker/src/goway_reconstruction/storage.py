"""Local disk: the content cache, per-job scratch and the crash-recovery ledger.

- The CACHE holds privacy-safe derivatives by SHA-256, so a scene that gains
  500 MB of new captures does not re-download the gigabytes it already had. It
  is bounded and least-recently-used, every hit is re-verified, and it is never
  canonical: S3 is. Raw contributor media is never cached.
- SCRATCH is ``work/<jobId>/``, one directory per job. It is deleted after a
  successful upload; after a failure only a small diagnostics file survives,
  and any job directory older than the configured window is removed on start.
- The LEDGER (SQLite) records which jobs this worker started and finished, so a
  restarted process knows what it was doing, resumes a redelivered job from its
  checkpoint, and re-reports an already-finished job instead of redoing it.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import time
from pathlib import Path

from .models import sha256_file


class ContentCache:
    def __init__(self, root: Path, max_bytes: int) -> None:
        self.root = root
        self.max_bytes = max_bytes
        self.hits = 0
        self.misses = 0
        root.mkdir(parents=True, exist_ok=True)

    def _path(self, sha256: str) -> Path:
        return self.root / sha256[:2] / sha256

    def get(self, sha256: str) -> Path | None:
        path = self._path(sha256)
        if not path.exists():
            self.misses += 1
            return None
        if sha256_file(path) != sha256:
            path.unlink(missing_ok=True)
            self.misses += 1
            return None
        os.utime(path)  # LRU clock
        self.hits += 1
        return path

    def put(self, sha256: str, source: Path) -> Path:
        path = self._path(sha256)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        shutil.copyfile(source, tmp)
        os.replace(tmp, path)
        self.evict()
        return path

    def size(self) -> int:
        return sum(p.stat().st_size for p in self.root.glob("*/*") if p.is_file())

    def evict(self) -> None:
        files = [p for p in self.root.glob("*/*") if p.is_file()]
        total = sum(p.stat().st_size for p in files)
        if total <= self.max_bytes:
            return
        for p in sorted(files, key=lambda f: f.stat().st_mtime):
            total -= p.stat().st_size
            p.unlink(missing_ok=True)
            if total <= self.max_bytes * 0.9:
                break

    @property
    def hit_ratio(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0


class Scratch:
    def __init__(self, root: Path, keep_failed_hours: int) -> None:
        self.root = root
        self.keep_failed_seconds = keep_failed_hours * 3600
        root.mkdir(parents=True, exist_ok=True)

    def for_job(self, job_id: str) -> Path:
        path = self.root / job_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def finish(self, job_id: str) -> None:
        shutil.rmtree(self.root / job_id, ignore_errors=True)

    def keep_diagnostics(self, job_id: str, diagnostics: dict) -> None:
        """After a failure keep a small JSON note and drop everything large —
        except ``resume/`` (the aligned camera solve and the training
        checkpoint), which lets a redelivered attempt continue where this one
        stopped instead of starting over."""
        path = self.root / job_id
        if not path.exists():
            return
        for child in path.iterdir():
            if child.name in ("diagnostics.json", "resume"):
                continue
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)
        (path / "diagnostics.json").write_text(json.dumps(diagnostics, indent=1))

    def sweep(self, active: set[str] = frozenset()) -> int:
        removed = 0
        cutoff = time.time() - self.keep_failed_seconds
        for child in self.root.iterdir():
            if child.name in active or not child.is_dir():
                continue
            if child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
        return removed

    def bytes_used(self) -> int:
        return sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file())


class Ledger:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.execute(
            "create table if not exists jobs (job_id text primary key, attempt integer, status text, "
            "started_at real, finished_at real, result_key text, result_sha256 text, result_bytes integer)"
        )
        self.db.execute("create table if not exists stats (key text primary key, value real)")

    def start(self, job_id: str, attempt: int) -> None:
        self.db.execute(
            "insert into jobs(job_id, attempt, status, started_at) values (?, ?, 'running', ?) "
            "on conflict(job_id) do update set attempt=excluded.attempt, status='running', started_at=excluded.started_at",
            (job_id, attempt, time.time()),
        )

    def finish(self, job_id: str, status: str, result: tuple[str, str, int] | None = None) -> None:
        key, sha, size = result if result else (None, None, None)
        self.db.execute(
            "update jobs set status=?, finished_at=?, result_key=?, result_sha256=?, result_bytes=? where job_id=?",
            (status, time.time(), key, sha, size, job_id),
        )

    def completed_result(self, job_id: str) -> tuple[str, str, int] | None:
        row = self.db.execute(
            "select result_key, result_sha256, result_bytes from jobs where job_id=? and status='completed'", (job_id,)
        ).fetchone()
        return tuple(row) if row and row[0] else None

    def interrupted(self) -> list[str]:
        """Jobs a previous process started and never finished."""
        rows = self.db.execute("select job_id from jobs where status='running'").fetchall()
        self.db.execute("update jobs set status='interrupted' where status='running'")
        return [r[0] for r in rows]

    def bump(self, key: str, amount: float) -> None:
        self.db.execute(
            "insert into stats(key, value) values (?, ?) on conflict(key) do update set value = value + excluded.value",
            (key, amount),
        )

    def stats(self) -> dict[str, float]:
        return dict(self.db.execute("select key, value from stats").fetchall())

    def counts(self) -> dict[str, int]:
        return dict(self.db.execute("select status, count(*) from jobs group by status").fetchall())


def fingerprint(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode()).hexdigest()[:16]
