"""Worker configuration: a local TOML file, overridable by environment.

The real values — queue URLs, bucket, the AWS profile that yields short-lived
credentials — live on the worker host in a file git never sees
(``~/.config/goway-worker/config.toml`` by default, or ``GOWAY_WORKER_CONFIG``).
``config.example.toml`` in this package documents every key with placeholders.

Nothing here is a secret: credentials come from the AWS profile's credential
process, never from this file.
"""

from __future__ import annotations

import os
import secrets
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CONFIG = Path.home() / ".config" / "goway-worker" / "config.toml"
DEFAULT_DATA = Path.home() / ".local" / "share" / "goway-worker"


@dataclass
class WorkerConfig:
    region: str = "us-west-2"
    aws_profile: str | None = None
    jobs_queue_url: str = ""
    events_queue_url: str = ""
    bucket: str = ""
    data_dir: Path = DEFAULT_DATA
    cache_max_gb: float = 50.0
    min_free_disk_gb: float = 30.0
    visibility_timeout_seconds: int = 900
    heartbeat_seconds: int = 120
    max_gpu_temperature_c: int = 87
    failed_scratch_keep_hours: int = 24
    profiles: dict = field(default_factory=dict)

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def scratch_dir(self) -> Path:
        return self.data_dir / "work"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def build_dir(self) -> Path:
        return self.data_dir / "build"

    @property
    def state_path(self) -> Path:
        return self.data_dir / "state.sqlite3"

    @property
    def configured(self) -> bool:
        return bool(self.jobs_queue_url and self.events_queue_url and self.bucket)

    def worker_id(self) -> str:
        """A random, persistent, meaningless id — never a hostname."""
        path = self.data_dir / "worker-id"
        if not path.exists():
            self.data_dir.mkdir(parents=True, exist_ok=True)
            path.write_text(f"w-{secrets.token_hex(4)}\n")
        return path.read_text().strip()


_ENV = {
    "GOWAY_WORKER_REGION": ("region", str),
    "GOWAY_WORKER_AWS_PROFILE": ("aws_profile", str),
    "GOWAY_WORKER_JOBS_QUEUE_URL": ("jobs_queue_url", str),
    "GOWAY_WORKER_EVENTS_QUEUE_URL": ("events_queue_url", str),
    "GOWAY_WORKER_BUCKET": ("bucket", str),
    "GOWAY_WORKER_DATA_DIR": ("data_dir", Path),
    "GOWAY_WORKER_CACHE_MAX_GB": ("cache_max_gb", float),
    "GOWAY_WORKER_MIN_FREE_DISK_GB": ("min_free_disk_gb", float),
}


def load(path: Path | None = None) -> WorkerConfig:
    path = path or Path(os.environ.get("GOWAY_WORKER_CONFIG", DEFAULT_CONFIG))
    values: dict = {}
    if path.exists():
        with path.open("rb") as handle:
            raw = tomllib.load(handle)
        for key, value in raw.items():
            if key in WorkerConfig.__dataclass_fields__:
                values[key] = Path(value).expanduser() if key == "data_dir" else value
    for env, (key, cast) in _ENV.items():
        if os.environ.get(env):
            values[key] = cast(os.environ[env])
    return WorkerConfig(**values)
