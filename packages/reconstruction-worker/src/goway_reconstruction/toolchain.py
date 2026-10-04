"""The CUDA toolchain gsplat compiles its kernels with — from the venv, not the host.

uv installs nvcc, the CUDA headers and the runtime as pinned wheels (see
pyproject.toml). Two things the wheels do not lay out the way a JIT build
expects are fixed here, idempotently: a ``lib64`` alias for ``lib`` and the
unversioned ``libcudart.so`` link the linker asks for. Then the environment
points PyTorch's extension builder at that toolkit, at the GPU's own
architecture only, and at a build cache inside the worker's data directory, so
the kernels compile once per worker and per lock.

Call :func:`prepare` before importing gsplat.
"""

from __future__ import annotations

import os
import sysconfig
from pathlib import Path


def toolkit_root() -> Path:
    return Path(sysconfig.get_paths()["purelib"]) / "nvidia" / "cu13"


def prepare(build_dir: Path) -> Path:
    root = toolkit_root()
    if not (root / "bin" / "nvcc").exists():
        raise RuntimeError("the CUDA toolkit wheels are not installed; run `bun run worker:setup`")
    lib = root / "lib"
    lib64 = root / "lib64"
    if not lib64.exists():
        lib64.symlink_to("lib")
    cudart = lib / "libcudart.so"
    if not cudart.exists():
        cudart.symlink_to("libcudart.so.13")

    os.environ["CUDA_HOME"] = str(root)
    # nvcc from the toolkit wheels, ninja from the venv's own scripts.
    scripts = Path(sysconfig.get_paths()["scripts"])
    os.environ["PATH"] = os.pathsep.join([str(root / "bin"), str(scripts), os.environ.get("PATH", "")])
    build_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("TORCH_EXTENSIONS_DIR", str(build_dir))
    os.environ.setdefault("MAX_JOBS", str(max(1, (os.cpu_count() or 2) // 2)))
    tmp = build_dir / "tmp"
    tmp.mkdir(exist_ok=True)
    os.environ["TMPDIR"] = str(tmp)

    import torch

    if torch.cuda.is_available() and "TORCH_CUDA_ARCH_LIST" not in os.environ:
        major, minor = torch.cuda.get_device_capability(0)
        os.environ["TORCH_CUDA_ARCH_LIST"] = f"{major}.{minor}"
    return root
