"""Host health the worker checks before accepting work.

Read-only: the worker observes temperature, memory and disk and refuses new
jobs when they are out of bounds. It never changes clocks, power limits or fan
curves.

Hardware identity stays local. ``gpu_summary`` reports what scheduling needs —
memory and compute capability — and the device name only to the operator's
terminal, never into an event, a result or a log line that leaves the host.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class GpuState:
    available: bool
    name: str = ""
    memory_total_mb: int = 0
    memory_used_mb: int = 0
    temperature_c: int = 0
    utilization_pct: int = 0
    capability: str = ""


def gpu_state() -> GpuState:
    try:
        import pynvml

        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
        state = GpuState(
            available=True,
            name=pynvml.nvmlDeviceGetName(handle),
            memory_total_mb=int(mem.total / 2**20),
            memory_used_mb=int(mem.used / 2**20),
            temperature_c=int(pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)),
            utilization_pct=int(pynvml.nvmlDeviceGetUtilizationRates(handle).gpu),
        )
        major, minor = pynvml.nvmlDeviceGetCudaComputeCapability(handle)
        state.capability = f"{major}.{minor}"
        return state
    except Exception:  # noqa: BLE001 - no driver, no device, or WSL without NVML
        return GpuState(available=False)


def free_disk_gb(path: Path) -> float:
    path.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(path).free / 2**30


def healthy(max_temperature_c: int, min_free_disk_gb: float, data_dir: Path) -> tuple[bool, str]:
    gpu = gpu_state()
    if not gpu.available:
        return False, "no GPU visible"
    if gpu.temperature_c >= max_temperature_c:
        return False, "GPU above the configured temperature ceiling"
    if free_disk_gb(data_dir) < min_free_disk_gb:
        return False, "free disk below the configured floor"
    return True, "ok"
