"""A dense initial point cloud from pose-conditioned multi-view depth.

Gaussians initialised only on sparse SfM points leave flat, low-texture
surfaces (the road, walls) to densification, which on a street capture turns
them into smears. Depth Anything 3 BASE (Apache-2.0, vendored under
``vendor/depth_anything_3``), conditioned on the solved poses and intrinsics,
predicts a dense depth map per frame. Nothing is generated: every point kept is
depth measured from a real frame, and only where neighbouring frames agree.

Per frame, in sorted-name order and in chunks of ``CHUNK`` frames:

1. preprocessing as upstream's ``api.inference`` does it: long edge resized to
   ``PROCESS_RES``, sides rounded to a multiple of 14, ImageNet normalisation,
   intrinsics scaled with the image, extrinsics normalised to the chunk's first
   camera and its median camera distance; then an autocast forward pass, and the
   predicted depth brought to the input poses' scale (Umeyama Sim(3) of the
   predicted to the input camera centres, ``depth /= scale``);
2. a scale check against the frame's own SfM points: depth is rescaled by the
   median ratio, and the frame is dropped when the ratios disagree (median
   absolute deviation above ``MAX_SCALE_MAD``) — its depth's shape does not
   match the solved geometry;
3. usable pixels: privacy mask (undistorted) valid, confidence above the
   frame's ``CONF_PERCENTILE``-th percentile, not sky, depth within
   [``MIN_DEPTH``, ``MAX_DEPTH``] metres.

Then multi-view consistency: a sampled pixel becomes a world point only if at
least ``MIN_VOTES`` of its ``NEIGHBOURS`` nearest frames on either side see the
same surface (their depth at its projection within ``AGREEMENT``). Held-out
frames (the trainer's own rule, :func:`train.held_out`) never reach this module:
they neither add points nor vote, so the evaluation stays honest. The fused
cloud is voxel-downsampled and capped.
"""

from __future__ import annotations

import gc
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pycolmap
import torch

from ..models import DENSE_DEPTH_MODEL_FILES, DENSE_DEPTH_REVISION, ensure_model
from .train import held_out, posed_images, undistort_frame

log = logging.getLogger("goway.worker")

CHUNK = 24
PROCESS_RES = 504
PATCH = 14
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], np.float32)
RANSAC_MIN_VIEWS, RANSAC_ITERS, RANSAC_SEED = 10, 10, 42

MIN_SCALE_ANCHORS = 20
MAX_SCALE_MAD = 0.15
CONF_PERCENTILE = 40.0
MAX_SKY = 0.5
MIN_DEPTH, MAX_DEPTH = 0.3, 60.0
NEIGHBOURS, MIN_VOTES, AGREEMENT = 3, 2, 0.05
SAMPLES_PER_FRAME = 30_000
VOXEL_M = 0.03
MAX_POINTS = 1_500_000

COMPONENT = f"depth-anything/DA3-BASE {DENSE_DEPTH_REVISION}"


class DenseInitError(RuntimeError):
    """The dense initial point cloud could not be produced; training uses sparse points."""


@dataclass
class DepthFrame:
    """One frame's metric depth at the processing resolution."""

    depth: np.ndarray  # float32 HxW, scene metres
    K: np.ndarray  # 3x3 at the depth's resolution
    E: np.ndarray  # 4x4 world -> camera
    rgb: np.ndarray  # uint8 HxWx3
    valid: np.ndarray  # bool HxW: pixels allowed to become points


@dataclass
class DenseResult:
    xyz: np.ndarray  # float32 Nx3, world (scene) coordinates
    rgb: np.ndarray  # uint8 Nx3
    frames_used: int
    frames_dropped: int
    seconds: float


# ── the model ──────────────────────────────────────────────────────────────


def build_network() -> torch.nn.Module:
    """The DA3-BASE network from the vendored config, with untrained weights."""
    from ..vendor.depth_anything_3 import CONFIG_DIR
    from ..vendor.depth_anything_3.cfg import create_object, load_config

    return create_object(load_config(CONFIG_DIR / "da3-base.yaml"))


# Upstream loads the checkpoint non-strictly: it carries no weights for the
# upper levels of the auxiliary ray head, an output this pipeline never reads.
_UNUSED_MISSING = "head.scratch.output_conv2_aux."


class DenseDepthModel:
    def __init__(self, models_dir: Path, device: torch.device) -> None:
        from safetensors.torch import load_file

        for pinned in DENSE_DEPTH_MODEL_FILES:
            ensure_model(pinned, models_dir)
        folder = models_dir / DENSE_DEPTH_MODEL_FILES[0].filename.split("/")[0]
        if json.loads((folder / "config.json").read_text()).get("model_name") != "da3-base":
            raise DenseInitError("pinned checkpoint is not DA3-BASE")
        net = build_network()
        state = {k.removeprefix("model."): v for k, v in load_file(folder / "model.safetensors").items()}
        missing, unexpected = net.load_state_dict(state, strict=False)
        if unexpected or any(not k.startswith(_UNUSED_MISSING) for k in missing):
            raise DenseInitError("checkpoint does not match the vendored network")
        self.net = net.eval().to(device)
        self.device = device

    def close(self) -> None:
        """Release the network and its GPU memory before training needs it."""
        self.net = None
        gc.collect()
        if self.device.type == "cuda":
            torch.cuda.empty_cache()

    @torch.inference_mode()
    def predict(self, rgbs: list[np.ndarray], extrinsics: np.ndarray, intrinsics: np.ndarray) -> dict[str, np.ndarray | None]:
        """Depth in the input poses' units, confidence and sky for one chunk.

        ``rgbs`` are undistorted uint8 RGB frames, ``extrinsics`` Nx4x4
        world->camera, ``intrinsics`` Nx3x3 at the frames' resolution. Returns
        ``depth``/``conf``/``sky`` (N x h x w at the processing resolution;
        ``sky`` may be None), the processed ``intrinsics`` and, per frame, the
        resize ``size`` (w, h) and centre ``crop`` (left, top) that map a
        full-resolution image onto the depth grid.
        """
        from ..vendor.depth_anything_3.utils.geometry import affine_inverse

        tensors, Ks, sizes = [], [], []
        for rgb, K in zip(rgbs, intrinsics):
            x, k = preprocess(rgb, K)
            tensors.append(x)
            Ks.append(k)
            sizes.append((x.shape[2], x.shape[1]))
        tensors, Ks, crops = unify_shapes(tensors, Ks)
        imgs = torch.from_numpy(np.stack(tensors)).to(self.device)[None]
        ex = torch.from_numpy(np.asarray(extrinsics, np.float32)).to(self.device)[None]
        ix = torch.from_numpy(np.stack(Ks).astype(np.float32)).to(self.device)[None]

        # Extrinsics relative to the first camera, scaled to a median camera distance of 1.
        ex_norm = ex @ affine_inverse(ex[:, :1])
        median = torch.median(affine_inverse(ex_norm)[..., :3, 3].norm(dim=-1)).clamp(min=1e-1)
        ex_norm[..., :3, 3] = ex_norm[..., :3, 3] / median

        if self.device.type == "cuda":
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        else:
            dtype = torch.bfloat16
        with torch.autocast(device_type=self.device.type, dtype=dtype):
            out = self.net(imgs, ex_norm, ix, [], False, False, "saddle_balanced")

        depth = out["depth"].squeeze(0).float().cpu().numpy()
        conf = out["depth_conf"].squeeze(0).float().cpu().numpy() if "depth_conf" in out else None
        sky = out["sky"].squeeze(0).float().cpu().numpy() if "sky" in out else None
        predicted = out["extrinsics"].squeeze(0).float().cpu().numpy()
        depth = depth / pose_scale(predicted, np.asarray(extrinsics, np.float64))
        return {"depth": depth, "conf": conf, "sky": sky, "intrinsics": np.stack(Ks), "sizes": sizes, "crops": crops}


# ── preprocessing (upstream InputProcessor, upper_bound_resize) ───────────


def _scale_K(K: np.ndarray, w0: int, h0: int, w1: int, h1: int) -> np.ndarray:
    K = K.copy()
    K[:1] *= w1 / float(w0)
    K[1:2] *= h1 / float(h0)
    return K


def _nearest_multiple(x: int, p: int = PATCH) -> int:
    down = (x // p) * p
    up = down + p
    return max(1, up if abs(up - x) <= abs(x - down) else down)


def preprocess(rgb: np.ndarray, K: np.ndarray, process_res: int = PROCESS_RES) -> tuple[np.ndarray, np.ndarray]:
    """uint8 HxWx3 RGB -> normalised float32 3xhxw (h, w multiples of 14) and the matching K."""
    K = np.asarray(K, np.float64)
    h, w = rgb.shape[:2]
    if max(w, h) != process_res:
        scale = process_res / float(max(w, h))
        nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        rgb = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_CUBIC if scale > 1.0 else cv2.INTER_AREA)
        K = _scale_K(K, w, h, nw, nh)
        w, h = nw, nh
    nw, nh = _nearest_multiple(w), _nearest_multiple(h)
    if (nw, nh) != (w, h):
        rgb = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_CUBIC if (nw > w or nh > h) else cv2.INTER_AREA)
        K = _scale_K(K, w, h, nw, nh)
    x = (rgb.astype(np.float32) / 255.0 - IMAGENET_MEAN) / IMAGENET_STD
    return np.ascontiguousarray(x.transpose(2, 0, 1)), K


def unify_shapes(tensors: list[np.ndarray], Ks: list[np.ndarray]) -> tuple[list[np.ndarray], list[np.ndarray], list[tuple[int, int]]]:
    """Centre-crop a chunk to its smallest frame (frames of different cameras), shifting principal points."""
    hs, ws = [t.shape[1] for t in tensors], [t.shape[2] for t in tensors]
    mh, mw = min(hs), min(ws)
    out, out_K, crops = [], [], []
    for t, K in zip(tensors, Ks):
        top, left = max(0, (t.shape[1] - mh) // 2), max(0, (t.shape[2] - mw) // 2)
        out.append(t[:, top : top + mh, left : left + mw])
        K = K.copy()
        K[0, 2] -= left
        K[1, 2] -= top
        out_K.append(K)
        crops.append((left, top))
    return out, out_K, crops


# ── scale alignment (upstream utils/pose_align.py, without evo) ───────────


def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Least-squares similarity (Umeyama 1991): ``dst ~ c * R @ src + t`` for Nx3 point sets."""
    n = len(src)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    var_s = float((xs**2).sum() / n)
    U, D, Vt = np.linalg.svd(xd.T @ xs / n)
    if np.count_nonzero(D > np.finfo(D.dtype).eps) < 2 or var_s <= 0:
        raise ValueError("degenerate point configuration")
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    c = float(np.trace(np.diag(D) @ S) / var_s)
    return R, mu_d - c * R @ mu_s, c


def pose_scale(predicted_ext: np.ndarray, input_ext: np.ndarray) -> float:
    """Scale from the input poses to the predicted ones (upstream's ``align_poses_umeyama``).

    Camera centres of the input extrinsics are aligned to those of the
    predicted extrinsics, with upstream's RANSAC from ``RANSAC_MIN_VIEWS``
    views. A degenerate configuration returns 1.0: the per-frame SfM check
    sets the final scale either way.
    """

    def centres(ext: np.ndarray) -> np.ndarray:
        ext = np.asarray(ext, np.float64)
        return -np.einsum("nji,nj->ni", ext[:, :3, :3], ext[:, :3, 3])

    src, dst = centres(input_ext), centres(predicted_ext)
    n = len(src)
    try:
        r0, t0, s0 = umeyama(src, dst)
    except (ValueError, np.linalg.LinAlgError):
        return 1.0
    if n < RANSAC_MIN_VIEWS:
        return s0
    aligned = s0 * src @ r0.T + t0
    thresh = float(np.median([np.linalg.norm(dst - p, axis=1).min() for p in aligned]))
    rng = np.random.default_rng(RANSAC_SEED)
    best, best_inliers, best_score = (r0, t0, s0), None, (-1, np.inf)
    for _ in range(RANSAC_ITERS):
        sample = rng.choice(n, size=max(3, (n + 1) // 2), replace=False)
        try:
            r, t, s = umeyama(src[sample], dst[sample])
        except (ValueError, np.linalg.LinAlgError):
            continue
        errs = np.linalg.norm(s * src @ r.T + t - dst, axis=1)
        inliers = errs <= thresh
        k = int(inliers.sum())
        mean_err = float(errs[inliers].mean()) if k else np.inf
        if k > best_score[0] or (k == best_score[0] and mean_err < best_score[1]):
            best, best_inliers, best_score = (r, t, s), inliers, (k, mean_err)
    if best_inliers is not None and best_inliers.sum() >= 3:
        try:
            return umeyama(src[best_inliers], dst[best_inliers])[2]
        except (ValueError, np.linalg.LinAlgError):
            pass
    return best[2]


# ── per-frame checks ───────────────────────────────────────────────────────


def sfm_scale(depth: np.ndarray, K: np.ndarray, E: np.ndarray, points: np.ndarray) -> float | None:
    """Median ratio of predicted depth to the depth of the frame's own SfM points.

    None when too few points project into the frame, or when the ratios
    disagree: the predicted shape does not match the solved geometry.
    """
    if len(points) == 0:
        return None
    h, w = depth.shape
    cam = points @ E[:3, :3].T + E[:3, 3]
    cam = cam[cam[:, 2] > 0.1]
    uv = cam @ K.T
    uv = uv[:, :2] / uv[:, 2:]
    ok = (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
    if ok.sum() <= MIN_SCALE_ANCHORS:
        return None
    ratio = depth[uv[ok, 1].astype(int), uv[ok, 0].astype(int)] / cam[ok, 2]
    median = float(np.median(ratio))
    if not np.isfinite(median) or median <= 0 or np.median(np.abs(ratio / median - 1)) > MAX_SCALE_MAD:
        return None
    return median


def usable(depth: np.ndarray, conf: np.ndarray | None, sky: np.ndarray | None, mask: np.ndarray) -> np.ndarray:
    good = mask & (depth > MIN_DEPTH) & (depth < MAX_DEPTH)
    if conf is not None:
        good &= conf > np.percentile(conf, CONF_PERCENTILE)
    if sky is not None:
        good &= sky < MAX_SKY
    return good


# ── fusion ─────────────────────────────────────────────────────────────────


def fuse(frames: list[DepthFrame], samples_per_frame: int = SAMPLES_PER_FRAME) -> tuple[np.ndarray, np.ndarray]:
    """World points (float32) and colours (uint8) that neighbouring frames confirm."""
    pts, cols = [], []
    for i, frame in enumerate(frames):
        vv, uu = np.nonzero(frame.valid)
        if len(vv) == 0:
            continue
        if len(vv) > samples_per_frame:
            sel = np.random.default_rng(i).choice(len(vv), samples_per_frame, replace=False)
            vv, uu = vv[sel], uu[sel]
        z = frame.depth[vv, uu].astype(np.float64)
        K, E = frame.K, frame.E
        cam = np.stack([(uu + 0.5 - K[0, 2]) / K[0, 0] * z, (vv + 0.5 - K[1, 2]) / K[1, 1] * z, z], 1)
        world = (cam - E[:3, 3]) @ E[:3, :3]
        votes = np.zeros(len(world), np.int32)
        for k in range(i - NEIGHBOURS, i + NEIGHBOURS + 1):
            if k == i or k < 0 or k >= len(frames):
                continue
            other = frames[k]
            c = world @ other.E[:3, :3].T + other.E[:3, 3]
            zz = c[:, 2]
            uv = (c @ other.K.T)[:, :2] / np.maximum(zz, 1e-6)[:, None]
            u2, v2 = uv[:, 0].astype(np.int64), uv[:, 1].astype(np.int64)
            h2, w2 = other.depth.shape
            ok = (zz > 0.1) & (u2 >= 0) & (u2 < w2) & (v2 >= 0) & (v2 < h2)
            agree = np.zeros(len(world), bool)
            agree[ok] = np.abs(other.depth[v2[ok], u2[ok]] / zz[ok] - 1) < AGREEMENT
            votes += agree
        keep = votes >= MIN_VOTES
        pts.append(world[keep].astype(np.float32))
        cols.append(frame.rgb[vv[keep], uu[keep]].astype(np.uint8))
    if not pts:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
    return np.concatenate(pts), np.concatenate(cols)


def voxel_downsample(xyz: np.ndarray, rgb: np.ndarray, voxel: float = VOXEL_M, cap: int = MAX_POINTS, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """One point per ``voxel`` cube (the first seen), then a uniform random cap."""
    if len(xyz) == 0:
        return xyz, rgb
    cells = np.floor(xyz / voxel).astype(np.int64)
    cells -= cells.min(0)
    if cells.max() < 1 << 21:  # one int64 key per cell: far faster than unique rows
        _, first = np.unique((cells[:, 0] << 42) | (cells[:, 1] << 21) | cells[:, 2], return_index=True)
    else:
        _, first = np.unique(cells, axis=0, return_index=True)
    first.sort()
    xyz, rgb = xyz[first], rgb[first]
    if len(xyz) > cap:
        keep = np.random.default_rng(seed).choice(len(xyz), cap, replace=False)
        xyz, rgb = xyz[keep], rgb[keep]
    return xyz, rgb


# ── the stage ──────────────────────────────────────────────────────────────


def _chunks(n: int, size: int = CHUNK) -> list[range]:
    starts = list(range(0, n, size))
    out = [range(s, min(n, s + size)) for s in starts]
    if len(out) > 1 and len(out[-1]) < 2:  # a lone frame has no partner to condition on
        out[-2] = range(out[-2].start, out[-1].stop)
        out.pop()
    return out


def dense_points(
    model: pycolmap.Reconstruction,
    images_dir: Path,
    masks_dir: Path,
    models_dir: Path,
    device: torch.device,
    on_progress: Callable[[float], None] | None = None,
    max_points: int = MAX_POINTS,
) -> DenseResult:
    """World points and colours to initialise Gaussians with (at most ``max_points``)."""
    started = time.monotonic()
    posed = posed_images(model)
    training = [img for i, img in enumerate(posed) if not held_out(i, len(posed))]
    if len(training) < 2:
        raise DenseInitError("too few frames for multi-view depth")
    frames: list[DepthFrame] = []
    dropped = 0
    net = DenseDepthModel(models_dir, device)
    try:
        chunks = _chunks(len(training))
        for done, chunk in enumerate(chunks):
            batch = [training[i] for i in chunk]
            rgbs, masks, exts, ixts = [], [], [], []
            for img in batch:
                bgr, mask, valid, K = undistort_frame(model, img, images_dir, masks_dir)
                rgbs.append(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
                masks.append(((mask > 127) & (valid > 127)).astype(np.uint8))
                E = np.eye(4)
                E[:3] = img.cam_from_world().matrix()
                exts.append(E)
                ixts.append(K)
            pred = net.predict(rgbs, np.stack(exts), np.stack(ixts))
            for j, img in enumerate(batch):
                depth = pred["depth"][j]
                h, w = depth.shape
                (sw, sh), (left, top) = pred["sizes"][j], pred["crops"][j]
                points = np.array([model.points3D[p.point3D_id].xyz for p in img.points2D if p.has_point3D()]).reshape(-1, 3)
                ratio = sfm_scale(depth, pred["intrinsics"][j], exts[j], points)
                if ratio is None:
                    dropped += 1
                    continue
                depth = (depth / ratio).astype(np.float32)
                mask = cv2.resize(masks[j], (sw, sh), interpolation=cv2.INTER_NEAREST)[top : top + h, left : left + w] > 0
                rgb = cv2.resize(rgbs[j], (sw, sh), interpolation=cv2.INTER_AREA)[top : top + h, left : left + w]
                conf = pred["conf"][j] if pred["conf"] is not None else None
                sky = pred["sky"][j] if pred["sky"] is not None else None
                frames.append(DepthFrame(depth=depth, K=pred["intrinsics"][j], E=exts[j], rgb=rgb, valid=usable(depth, conf, sky, mask)))
            if on_progress is not None:
                on_progress((done + 1) / len(chunks))
    finally:
        net.close()
        del net
    xyz, rgb = voxel_downsample(*fuse(frames), cap=max_points)
    if len(xyz) == 0:
        raise DenseInitError("no multi-view consistent depth")
    return DenseResult(xyz=xyz, rgb=rgb, frames_used=len(frames), frames_dropped=dropped, seconds=time.monotonic() - started)
