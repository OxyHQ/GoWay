"""Dense initial point cloud: fusion, consistency, held-out frames, the vendored network (CPU only)."""

import numpy as np
import pytest
import torch

from goway_reconstruction import models
from goway_reconstruction.recon import dense
from goway_reconstruction.recon.dense import DepthFrame, fuse, pose_scale, preprocess, sfm_scale, umeyama, usable, voxel_downsample
from goway_reconstruction.recon.train import HOLDOUT_EVERY, held_out

H, W = 48, 64
K = np.array([[50.0, 0, W / 2], [0, 50.0, H / 2], [0, 0, 1]])


def _extrinsic(x: float) -> np.ndarray:
    """A camera at (x, 0, 0) looking down +z (world -> camera)."""
    E = np.eye(4)
    E[0, 3] = -x
    return E


def _wall_frame(x: float, z: float = 5.0, valid: np.ndarray | None = None) -> DepthFrame:
    """A fronto-parallel wall at depth ``z`` seen from a camera at (x, 0, 0)."""
    return DepthFrame(
        depth=np.full((H, W), z, np.float32),
        K=K,
        E=_extrinsic(x),
        rgb=np.full((H, W, 3), 128, np.uint8),
        valid=np.ones((H, W), bool) if valid is None else valid,
    )


def test_consistent_depth_fuses_onto_the_surface():
    frames = [_wall_frame(0.1 * i) for i in range(7)]
    xyz, rgb = fuse(frames, samples_per_frame=500)
    assert len(xyz) > 0.5 * 7 * 500
    assert xyz.dtype == np.float32 and rgb.dtype == np.uint8
    assert np.allclose(xyz[:, 2], 5.0, atol=1e-4)
    assert np.all(rgb == 128)


def test_a_lone_frame_adds_nothing():
    xyz, _ = fuse([_wall_frame(0.0)], samples_per_frame=500)
    assert len(xyz) == 0


def test_inconsistent_depth_is_rejected():
    # Frame 3 sees the wall at 8 m where its neighbours see it at 5 m: no neighbour confirms it.
    frames = [_wall_frame(0.1 * i, z=8.0 if i == 3 else 5.0) for i in range(7)]
    xyz, _ = fuse(frames, samples_per_frame=500)
    assert len(xyz) > 0
    assert np.allclose(xyz[:, 2], 5.0, atol=1e-4)


def test_one_agreeing_neighbour_is_not_enough():
    # Only frames 0 and 1 agree with each other; every other frame sees something else.
    frames = [_wall_frame(0.1 * i, z=5.0 if i < 2 else 9.0 + i) for i in range(5)]
    xyz, _ = fuse(frames, samples_per_frame=500)
    assert not np.any(np.isclose(xyz[:, 2], 5.0, atol=1e-3))


def test_masked_pixels_never_become_points():
    valid = np.zeros((H, W), bool)
    valid[:, : W // 2] = True
    frames = [_wall_frame(0.1 * i, valid=valid) for i in range(5)]
    xyz, _ = fuse(frames, samples_per_frame=10_000)
    # Every point lies left of the camera it came from (the left half of the image).
    assert len(xyz) > 0
    assert np.all(xyz[:, 0] < 0.4 + 1e-3)


def test_usable_pixels():
    depth = np.full((4, 4), 5.0, np.float32)
    depth[0, 0], depth[0, 1] = 0.1, 100.0
    conf = np.arange(16, dtype=np.float32).reshape(4, 4)
    sky = np.zeros((4, 4), np.float32)
    sky[3, 3] = 0.9
    mask = np.ones((4, 4), bool)
    mask[2, 2] = False
    good = usable(depth, conf, sky, mask)
    assert not good[0, 0] and not good[0, 1]  # outside the depth range
    assert not good[2, 2]  # privacy mask
    assert not good[3, 3]  # sky
    assert not good[1, 0]  # below the 40th confidence percentile
    assert good[3, 2]


def test_scale_check_rescales_and_drops_disagreeing_frames():
    E = _extrinsic(0.0)
    rng = np.random.default_rng(0)
    uv = rng.uniform([1, 1], [W - 1, H - 1], (200, 2))
    z = rng.uniform(3, 10, 200)
    pts = np.stack([(uv[:, 0] - K[0, 2]) / K[0, 0] * z, (uv[:, 1] - K[1, 2]) / K[1, 1] * z, z], 1)
    depth = np.zeros((H, W), np.float32)
    depth[uv[:, 1].astype(int), uv[:, 0].astype(int)] = 2.5 * z
    assert sfm_scale(depth, K, E, pts) == pytest.approx(2.5, rel=1e-4)
    noisy = depth * rng.uniform(0.3, 1.7, depth.shape).astype(np.float32)
    assert sfm_scale(noisy, K, E, pts) is None
    assert sfm_scale(depth, K, E, pts[:15]) is None  # too few anchors
    assert sfm_scale(depth, K, E, np.zeros((0, 3))) is None


def test_held_out_rule_is_the_trainers():
    assert [held_out(i, 4 * HOLDOUT_EVERY) for i in range(HOLDOUT_EVERY + 1)] == [True] + [False] * (HOLDOUT_EVERY - 1) + [True]
    assert not any(held_out(i, 2 * HOLDOUT_EVERY - 1) for i in range(2 * HOLDOUT_EVERY - 1))


class _Pose:
    def matrix(self) -> np.ndarray:
        return np.eye(4)[:3]


class _Img:
    has_pose = True

    def __init__(self, name: str) -> None:
        self.name = name

    def cam_from_world(self) -> _Pose:
        return _Pose()

    def projection_center(self) -> np.ndarray:
        return np.array([float(self.name[1:4]), 0.0, 0.0])  # a walk along x, one step per frame


class _Model:
    def __init__(self, n: int) -> None:
        # Inserted out of order: the dense stage, like the trainer, sorts by name.
        self.images = {i: _Img(f"f{(i * 7) % n:03d}.jpg") for i in range(n)}


def test_held_out_frames_never_reach_depth_inference(monkeypatch):
    seen: list[str] = []

    class Inferred(Exception):
        pass

    class FakeNet:
        def __init__(self, *_args) -> None:
            pass

        def predict(self, rgbs, *_args):
            raise Inferred(len(rgbs))

        def close(self) -> None:
            pass

    def undistort(_model, img, *_args):
        seen.append(img.name)
        return np.zeros((2, 2, 3), np.uint8), np.zeros((2, 2), np.uint8), np.zeros((2, 2), np.uint8), K

    monkeypatch.setattr(dense, "DenseDepthModel", FakeNet)
    monkeypatch.setattr(dense, "undistort_frame", undistort)
    n = 2 * HOLDOUT_EVERY + 4  # held-out split active, one chunk
    with pytest.raises(Inferred):
        dense.dense_points(_Model(n), None, None, None, torch.device("cpu"))
    names = [f"f{i:03d}.jpg" for i in range(n)]
    assert seen == [name for i, name in enumerate(names) if not held_out(i, n)]
    assert len(seen) == n - 3


def test_job_falls_back_to_sparse_init_on_any_dense_failure(monkeypatch, tmp_path, caplog):
    from goway_reconstruction.context import JobContext
    from goway_reconstruction.recon import job

    def broken(*_args, **_kwargs):
        raise RuntimeError("/private/path/that/must/not/be/logged")

    monkeypatch.setattr(dense, "dense_points", broken)
    ctx = JobContext(job_id="j", attempt=1)
    with caplog.at_level("WARNING"):
        points, component = job._dense_init(None, tmp_path, tmp_path, tmp_path / "resume", tmp_path, torch.device("cpu"), ctx, max_points=10)
    assert points is None and component is None
    assert "RuntimeError" in caplog.text and "/private/path" not in caplog.text
    assert job._components(component).keys() == {"sfm", "trainer", "torch"}


def test_job_never_swallows_cancellation(monkeypatch, tmp_path):
    from goway_reconstruction.context import Cancelled, JobContext
    from goway_reconstruction.recon import job

    def cancelled(*_args, **_kwargs):
        raise Cancelled()

    monkeypatch.setattr(dense, "dense_points", cancelled)
    with pytest.raises(Cancelled):
        job._dense_init(None, tmp_path, tmp_path, tmp_path / "resume", tmp_path, torch.device("cpu"), JobContext(job_id="j", attempt=1), max_points=10)


def test_job_records_dense_provenance_and_reuses_it_on_resume(monkeypatch, tmp_path):
    from goway_reconstruction.context import JobContext
    from goway_reconstruction.recon import job

    calls = []

    def fake(*_args, max_points, **_kwargs):
        calls.append(max_points)
        return dense.DenseResult(xyz=np.zeros((3, 3), np.float32), rgb=np.zeros((3, 3), np.uint8), frames_used=3, frames_dropped=0, seconds=0.0)

    monkeypatch.setattr(dense, "dense_points", fake)
    resume = tmp_path / "resume"
    ctx = JobContext(job_id="j", attempt=1)
    points, component = job._dense_init(None, tmp_path, tmp_path, resume, tmp_path, torch.device("cpu"), ctx, max_points=750_000)
    assert points is not None and len(points[0]) == 3
    assert calls == [750_000]
    assert component == dense.COMPONENT and job._components(component)["denseInit"] == dense.COMPONENT
    # A redelivered job resuming from a checkpoint does not recompute, but keeps the provenance.
    (resume / "train.ckpt").write_bytes(b"")
    points, again = job._dense_init(None, tmp_path, tmp_path, resume, tmp_path, torch.device("cpu"), ctx, max_points=750_000)
    assert points is None and again == component and calls == [750_000]


def test_voxel_downsample_keeps_one_point_per_cell_and_caps():
    xyz = np.array([[0.001, 0.001, 0.001], [0.002, 0.002, 0.002], [0.5, 0.5, 0.5]], np.float32)
    rgb = np.array([[1, 1, 1], [2, 2, 2], [3, 3, 3]], np.uint8)
    out, colours = voxel_downsample(xyz, rgb, voxel=0.03, cap=10)
    assert len(out) == 2 and colours[0, 0] == 1
    many = np.random.default_rng(0).uniform(0, 10, (5000, 3)).astype(np.float32)
    out, colours = voxel_downsample(many, np.zeros((5000, 3), np.uint8), voxel=0.03, cap=1000)
    assert len(out) == 1000 and len(colours) == 1000


def test_preprocess_matches_upstream_resize_and_intrinsics():
    rgb = np.zeros((1080, 1920, 3), np.uint8)
    Kf = np.array([[1500.0, 0, 960], [0, 1500.0, 540], [0, 0, 1]])
    x, k = preprocess(rgb, Kf)
    assert x.shape == (3, 280, 504) and x.dtype == np.float32
    # 1920x1080 -> 504x284 (long edge) -> 504x280 (multiple of 14)
    assert k[0, 0] == pytest.approx(1500 * 504 / 1920) and k[0, 2] == pytest.approx(960 * 504 / 1920)
    assert k[1, 1] == pytest.approx(1500 * 284 / 1080 * 280 / 284)


def test_pose_scale_recovers_a_similarity():
    rng = np.random.default_rng(3)
    centres = np.cumsum(rng.normal(0, 1, (24, 3)), 0)
    theta = 0.4
    R = np.array([[np.cos(theta), -np.sin(theta), 0], [np.sin(theta), np.cos(theta), 0], [0, 0, 1]])
    predicted_centres = 0.37 * centres @ R.T + np.array([1.0, -2.0, 0.5])

    def ext(c: np.ndarray, rot: np.ndarray) -> np.ndarray:
        e = np.tile(np.eye(4), (len(c), 1, 1))
        e[:, :3, :3] = rot.T
        e[:, :3, 3] = -c @ rot  # t = -R^T c with R^T = rot.T
        return e

    assert pose_scale(ext(predicted_centres, R), ext(centres, np.eye(3))) == pytest.approx(0.37, rel=1e-6)
    assert pose_scale(ext(predicted_centres[:6], R), ext(centres[:6], np.eye(3))) == pytest.approx(0.37, rel=1e-6)
    _, _, c = umeyama(centres, predicted_centres)
    assert c == pytest.approx(0.37)


def test_vendored_network_builds_on_cpu_without_weights():
    net = dense.build_network().eval()
    assert 100e6 < sum(p.numel() for p in net.parameters()) < 200e6  # ViT-B backbone + heads
    imgs = torch.randn(1, 2, 3, 28, 42)
    ext = torch.eye(4).repeat(1, 2, 1, 1)
    ext[0, 1, 0, 3] = -0.5
    ix = torch.tensor([[30.0, 0, 21], [0, 30.0, 14], [0, 0, 1]]).repeat(1, 2, 1, 1)
    with torch.inference_mode():
        out = net(imgs, ext, ix, [], False, False, "saddle_balanced")
    assert out["depth"].shape == (1, 2, 28, 42)
    assert out["depth_conf"].shape == (1, 2, 28, 42)
    assert out["extrinsics"].shape[:2] == (1, 2)


def test_dense_depth_weights_are_pinned():
    files = {m.filename: m for m in models.DENSE_DEPTH_MODEL_FILES}
    assert set(files) == {"da3-base/config.json", "da3-base/model.safetensors"}
    for m in files.values():
        assert m.name == "depth-anything-3-base"
        assert len(m.sha256) == 64
        assert f"/depth-anything/DA3-BASE/resolve/{models.DENSE_DEPTH_REVISION}/" in m.url
        assert m in models.ALL_MODELS
    # Only the Apache-2.0 checkpoint; the larger DA3 checkpoints are non-commercial.
    assert not any(bad in m.url.upper() for m in models.ALL_MODELS for bad in ("DA3-LARGE", "DA3-GIANT", "NESTED"))
