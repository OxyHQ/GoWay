"""``goway-worker`` — the operator's interface to the external worker.

    goway-worker setup                       verify models, compile GPU kernels
    goway-worker doctor [--smoke]            check GPU, toolchain, disk, AWS access
    goway-worker status                      queue, ledger, cache, scratch, GPU
    goway-worker run [--max-jobs N] [--max-hours H]
    goway-worker drain                       finish the current job, then stop
    goway-worker bench-sfm SCENE [--features sift aliked raco] [--train N]
                                             solve one scene with each feature set

Exit status is nonzero when ``doctor`` finds a blocking problem, so it can gate
an automated start.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from . import __version__, config as config_module
from .telemetry import free_disk_gb, gpu_state


def _ok(label: str, value: str = "") -> None:
    print(f"  ok    {label}{(': ' + value) if value else ''}")


def _fail(label: str, value: str = "") -> None:
    print(f"  FAIL  {label}{(': ' + value) if value else ''}")


def cmd_setup(cfg: config_module.WorkerConfig) -> int:
    from . import toolchain
    from .models import ALL_MODELS, ensure_model

    toolchain.prepare(cfg.build_dir)
    for model in ALL_MODELS:
        ensure_model(model, cfg.models_dir)
        _ok(f"model {model.name}", "verified")
    started = time.monotonic()
    _compile_kernels()
    _ok("GPU kernels", f"ready in {time.monotonic() - started:.0f}s")
    cfg.worker_id()
    return 0


def _compile_kernels() -> None:
    import torch
    from gsplat import rasterization

    dev = torch.device("cuda")
    n = 256
    rasterization(
        torch.randn(n, 3, device=dev),
        torch.nn.functional.normalize(torch.randn(n, 4, device=dev), dim=1),
        torch.rand(n, 3, device=dev) * 0.1,
        torch.rand(n, device=dev),
        torch.rand(n, 3, device=dev),
        torch.eye(4, device=dev)[None] + torch.tensor([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 5.0], [0, 0, 0, 0]], device=dev)[None],
        torch.tensor([[200.0, 0, 64], [0, 200.0, 64], [0, 0, 1]], device=dev)[None],
        128,
        128,
    )
    torch.cuda.synchronize()


def cmd_doctor(cfg: config_module.WorkerConfig, smoke: bool) -> int:
    blocking = 0
    print(f"goway-worker {__version__}")
    gpu = gpu_state()
    if gpu.available:
        _ok("GPU", f"{gpu.memory_total_mb // 1024} GB VRAM, compute {gpu.capability}, {gpu.temperature_c}°C")
    else:
        _fail("GPU", "no NVIDIA GPU visible to NVML")
        blocking += 1
    try:
        import torch

        from . import toolchain

        toolchain.prepare(cfg.build_dir)
        assert torch.cuda.is_available()
        arch = "sm_%d%d" % torch.cuda.get_device_capability(0)
        if arch not in torch.cuda.get_arch_list() and f"compute_{arch[3:]}" not in " ".join(torch.cuda.get_arch_list()):
            raise RuntimeError(f"PyTorch build has no kernels for {arch}")
        _ok("PyTorch CUDA", f"{torch.__version__}, {arch}")
    except Exception as error:  # noqa: BLE001
        _fail("PyTorch CUDA", str(error))
        blocking += 1
    try:
        _compile_kernels()
        _ok("gsplat kernels")
    except Exception as error:  # noqa: BLE001
        _fail("gsplat kernels", type(error).__name__)
        blocking += 1
    try:
        import pycolmap

        _ok("pycolmap", pycolmap.__version__)
    except Exception as error:  # noqa: BLE001
        _fail("pycolmap", str(error))
        blocking += 1
    from .models import ALL_MODELS, ModelIntegrityError, ensure_model

    for model in ALL_MODELS:
        try:
            ensure_model(model, cfg.models_dir, download=False)
            _ok(f"model {model.name}", "digest matches")
        except ModelIntegrityError as error:
            _fail(f"model {model.name}", f"{error} (run worker:setup)")
            blocking += 1
    free = free_disk_gb(cfg.data_dir)
    (_ok if free >= cfg.min_free_disk_gb else _fail)("free disk", f"{free:.0f} GB (floor {cfg.min_free_disk_gb:.0f} GB)")
    blocking += free < cfg.min_free_disk_gb

    if not cfg.configured:
        _fail("configuration", "queues/bucket not set (see config.example.toml)")
        blocking += 1
    else:
        from .aws import Aws

        try:
            aws = Aws(cfg)
            aws.sts.get_caller_identity()
            _ok("AWS credentials", "short-lived role session")
            depth = aws.queue_depth()
            _ok("jobs queue", f"{depth['pending']} pending, {depth['inFlight']} in flight")
            aws.sqs.get_queue_attributes(QueueUrl=cfg.events_queue_url, AttributeNames=["QueueArn"])
            _ok("events queue")
            aws.exists("jobs/.doctor-probe")
            _ok("bucket read access")
        except Exception as error:  # noqa: BLE001
            _fail("AWS access", type(error).__name__)
            blocking += 1

    if smoke:
        try:
            _smoke()
            _ok("smoke test", "GPU render + SPZ round trip")
        except Exception as error:  # noqa: BLE001
            _fail("smoke test", f"{type(error).__name__}: {error}")
            blocking += 1
    print("ready" if not blocking else f"{blocking} blocking problem(s)")
    return 1 if blocking else 0


def _smoke() -> None:
    """A tiny synthetic scene: fit Gaussians to renders of known Gaussians, then
    check the SPZ round trip renders the same image."""
    import numpy as np
    import torch
    from gsplat import rasterization

    from .recon import spz

    dev = torch.device("cuda")
    torch.manual_seed(0)
    n = 2000
    K = torch.tensor([[150.0, 0, 64], [0, 150.0, 64], [0, 0, 1]], device=dev)[None]
    view = torch.eye(4, device=dev)[None]
    view[0, 2, 3] = 4.0
    truth = dict(
        means=torch.randn(n, 3, device=dev),
        quats=torch.nn.functional.normalize(torch.randn(n, 4, device=dev), dim=1),
        scales=torch.full((n, 3), -3.0, device=dev),
        opacities=torch.full((n,), 2.0, device=dev),
        sh0=torch.rand(n, 3, device=dev),
    )

    def render(p: dict) -> torch.Tensor:
        return rasterization(p["means"], p["quats"], torch.exp(p["scales"]), torch.sigmoid(p["opacities"]), p["sh0"][:, None], view, K, 128, 128, sh_degree=0)[0][0]

    target = render(truth)
    cloud = spz.GaussianCloud(
        means=truth["means"].cpu().numpy(),
        quats=truth["quats"].cpu().numpy(),
        scales=truth["scales"].cpu().numpy(),
        opacities=truth["opacities"].cpu().numpy(),
        sh0=truth["sh0"].cpu().numpy(),
        shN=np.zeros((n, 0, 3), np.float32),
    )
    back = spz.decode(spz.encode(cloud))
    decoded = {k: torch.tensor(getattr(back, k), device=dev) for k in ("means", "quats", "scales", "opacities", "sh0")}
    mse = float(((render(decoded) - target) ** 2).mean())
    psnr = -10 * np.log10(max(mse, 1e-10))
    if psnr < 30:
        raise RuntimeError(f"SPZ round trip renders at {psnr:.1f} dB")


def cmd_status(cfg: config_module.WorkerConfig) -> int:
    from .storage import ContentCache, Ledger, Scratch

    gpu = gpu_state()
    status: dict = {
        "worker": cfg.worker_id(),
        "draining": (cfg.data_dir / "drain").exists(),
        "gpu": {"memoryUsedMb": gpu.memory_used_mb, "memoryTotalMb": gpu.memory_total_mb, "temperatureC": gpu.temperature_c, "utilizationPct": gpu.utilization_pct} if gpu.available else None,
        "freeDiskGb": round(free_disk_gb(cfg.data_dir), 1),
        "cacheGb": round(ContentCache(cfg.cache_dir, 0).size() / 2**30, 2) if cfg.cache_dir.exists() else 0,
        "scratchGb": round(Scratch(cfg.scratch_dir, 24).bytes_used() / 2**30, 2) if cfg.scratch_dir.exists() else 0,
    }
    ledger = Ledger(cfg.state_path)
    status["jobs"] = ledger.counts()
    status["totals"] = {k: round(v, 1) for k, v in ledger.stats().items()}
    if cfg.configured:
        from .aws import Aws

        try:
            status["queue"] = Aws(cfg).queue_depth()
        except Exception as error:  # noqa: BLE001
            status["queue"] = f"unavailable ({type(error).__name__})"
    print(json.dumps(status, indent=2))
    return 0


def cmd_run(cfg: config_module.WorkerConfig, max_jobs: int | None, max_hours: float | None) -> int:
    from .aws import Aws
    from .runner import Runner

    if not cfg.configured:
        print("worker is not configured; see config.example.toml", file=sys.stderr)
        return 2
    (cfg.data_dir / "drain").unlink(missing_ok=True)
    runner = Runner(cfg, Aws(cfg))
    runner.install_signals()
    done = runner.run(max_jobs=max_jobs, max_hours=max_hours)
    print(f"completed {done} job(s) this session")
    return 0


def cmd_drain(cfg: config_module.WorkerConfig) -> int:
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    (cfg.data_dir / "drain").write_text("drain\n")
    print("drain requested: the running worker finishes its current job and stops")
    return 0


# Training budget of `bench-sfm --train`: the standard profile's, the same for
# every feature set, and no depth prior, so the held-out PSNR compares the
# cameras and nothing else.
BENCH_MAX_GAUSSIANS = 1_500_000
BENCH_LONG_EDGE = 1600
BENCH_SH_DEGREE = 3


def cmd_bench_sfm(cfg: config_module.WorkerConfig, scene: Path, feature_sets: list[str], train_iterations: int) -> int:
    """Solve a scene (``frames.json``, ``images/``, ``masks/``: what a job leaves in its scratch) with each feature set."""
    from . import toolchain

    toolchain.prepare(cfg.build_dir)  # before torch and gsplat load, as the runner does
    import numpy as np
    import torch

    from .recon.sfm import SfmError, read_frames, solve

    frames = read_frames(scene / "frames.json")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    rows = []
    for name in feature_sets:
        out = scene / "bench" / name
        started = time.monotonic()
        try:
            solved = solve(frames, scene / "images", scene / "masks", out, features=name, models_dir=cfg.models_dir, device=device)
        except SfmError as error:
            rows.append({"features": name, "error": error.code})
            continue
        inliers = [n for _a, _b, n in solved.edges]
        row = {
            "features": name,
            "registered": len(solved.registered),
            "frames": len(frames),
            "sparsePoints": solved.sparse_points,
            "meanReprojectionErrorPx": round(solved.mean_reprojection_error, 3),
            "meanTrackLength": round(solved.reconstruction.compute_mean_track_length(), 2),
            "verifiedPairs": len(inliers),
            "medianInliers": int(np.median(inliers)) if inliers else 0,
            "solveSeconds": round(time.monotonic() - started, 1),
        }
        if train_iterations:
            from .recon.train import train_scene

            trained = train_scene(
                solved.reconstruction,
                scene / "images",
                scene / "masks",
                out / "train",
                iterations=train_iterations,
                max_gaussians=BENCH_MAX_GAUSSIANS,
                long_edge=BENCH_LONG_EDGE,
                sh_degree=BENCH_SH_DEGREE,
                on_progress=lambda _p: None,
                device=device,
            )
            row["heldOutPsnr"] = round(trained.psnr, 3)
        rows.append(row)
        print(json.dumps(row), flush=True)
    (scene / "bench").mkdir(exist_ok=True)
    (scene / "bench" / "results.json").write_text(json.dumps(rows, indent=2))
    return 0 if all("error" not in row for row in rows) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goway-worker")
    parser.add_argument("--config", help="path to the local worker config (default ~/.config/goway-worker/config.toml)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("setup")
    doctor = sub.add_parser("doctor")
    doctor.add_argument("--smoke", action="store_true")
    sub.add_parser("status")
    run = sub.add_parser("run")
    run.add_argument("--max-jobs", type=int)
    run.add_argument("--max-hours", type=float)
    sub.add_parser("drain")
    bench = sub.add_parser("bench-sfm")
    bench.add_argument("scene", help="a directory with frames.json, images/ and masks/ (a job's scratch)")
    bench.add_argument("--features", nargs="+", default=["sift", "aliked", "raco"], help="feature sets to compare")
    bench.add_argument("--train", type=int, default=0, metavar="N", help="also train N iterations per set and report held-out PSNR")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for noisy in ("botocore", "boto3", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    cfg = config_module.load(Path(args.config) if args.config else None)
    if args.command == "setup":
        return cmd_setup(cfg)
    if args.command == "doctor":
        return cmd_doctor(cfg, args.smoke)
    if args.command == "status":
        return cmd_status(cfg)
    if args.command == "run":
        return cmd_run(cfg, args.max_jobs, args.max_hours)
    if args.command == "drain":
        return cmd_drain(cfg)
    if args.command == "bench-sfm":
        from .recon.sfm import FEATURE_SETS

        unknown = sorted(set(args.features) - set(FEATURE_SETS))
        if unknown:
            print(f"unknown feature set(s): {', '.join(unknown)} (choose from {', '.join(FEATURE_SETS)})", file=sys.stderr)
            return 2
        return cmd_bench_sfm(cfg, Path(args.scene), args.features, args.train)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
