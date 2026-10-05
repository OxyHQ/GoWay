"""Gaussian training on solved, privacy-masked frames (gsplat).

The recipe follows what measurably works on casual street captures — gsplat's
own reference trainer and practitioners' pipelines — with GoWay's rules on top:

- MCMC densification inside a fixed Gaussian budget, with opacity and scale
  regularisation (robust to imperfect SfM, predictable time and memory);
- anti-aliased rasterisation, so views away from the capture distance do not
  shimmer;
- camera pose refinement: video and phone poses are never pixel-exact, and a
  pose error becomes blur and doubled edges in the scene;
- a bilateral grid per frame for photometric compensation: phones change
  exposure, white balance and local tone mapping frame to frame, and an
  uncompensated difference is learned as floaters;
- the loss only sees pixels the privacy mask allows, so people and vehicles
  never become geometry or appearance;
- optional pseudo-views (generative repair) with their own lower weight, so
  they can fill what was never observed without overriding what was;
- a sky ball: background Gaussians seeded on the upper half of a large
  sphere, so the sky is learned far away instead of as needles near the
  camera (the WildGaussians / Hierarchical 3DGS approach);
- export keeps only Gaussians that real frames actually saw.

Evaluation reports masked PSNR and a colour-corrected PSNR (affine fit to the
held-out frame), because a held-out frame has its own exposure and the
canonical scene colour is arbitrary; without that correction the metric
punishes exactly the compensation that makes the scene look right.
"""

from __future__ import annotations

import dataclasses
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pycolmap
import torch
import torch.nn.functional as F
from gsplat import DefaultStrategy, MCMCStrategy, rasterization

from .bilagrid import BilateralGrid, slice as bilagrid_slice, total_variation_loss
from .spz import GaussianCloud

SH_C0 = 0.28209479177387814
CHECKPOINT_EVERY = 5000
HOLDOUT_EVERY = 8
MIN_VISIBLE_VIEWS = 2
# Floater cleanup at export (no generated content, only removal):
IMPORTANCE_KEEP = 0.995  # keep the Gaussians carrying 99.5% of all rendered contribution
OUTLIER_K, OUTLIER_STD = 16, 3.0  # statistical outlier removal on Gaussian centres
DEPTH_WEIGHT_START, DEPTH_WEIGHT_END = 0.1, 0.01
SSIM_LAMBDA = 0.2
OPACITY_REG = SCALE_REG = 0.01
POSE_LR, POSE_REG = 1e-5, 1e-6
BILAGRID_LR, BILAGRID_TV = 2e-3, 10.0
# Optional regularisers against off-path shards (DropGaussian, anisotropy).
# Off by default: on a dense-foliage street capture they made the scene hazier
# without removing the shards, which there come from missing viewpoints.
DROP_RATE = 0.0
MAX_ANISOTROPY, ANISOTROPY_WEIGHT = 10.0, 0.1
SKY_POINTS = 60_000

try:  # MIT, ~5x faster; optional so the worker still trains without the extension
    from fused_ssim import fused_ssim as _fused_ssim
except Exception:  # noqa: BLE001
    _fused_ssim = None


@dataclass
class View:
    name: str
    image: torch.Tensor | None  # uint8 HxWx3 on device
    mask: torch.Tensor | None  # bool HxW on device
    K: torch.Tensor  # 3x3
    viewmat: torch.Tensor  # 4x4 world->camera
    center: np.ndarray
    # Loss weight. Real frames are 1.0; repaired pseudo-views are lower.
    weight: float = 1.0


@dataclass
class TrainResult:
    cloud: GaussianCloud
    iterations: int
    seconds: float
    peak_vram_mb: int
    psnr: float
    ssim: float
    poster: np.ndarray
    initial_position: list[float]
    initial_target: list[float]
    cc_psnr: float = 0.0


def held_out(index: int, count: int) -> bool:
    """Whether the ``index``-th of ``count`` posed frames (see posed_images) is held out for evaluation.

    The single rule for the trainer's split and for anything else that must
    not learn from held-out frames, such as the dense initial point cloud.
    """
    return count >= 2 * HOLDOUT_EVERY and index % HOLDOUT_EVERY == 0


def posed_images(model: pycolmap.Reconstruction) -> list[pycolmap.Image]:
    """Registered frames in the trainer's order (sorted by name)."""
    return [img for img in sorted(model.images.values(), key=lambda i: i.name) if img.has_pose]


def undistort_frame(
    model: pycolmap.Reconstruction, img: pycolmap.Image, images_dir: Path, masks_dir: Path
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """A frame at full resolution, undistorted: BGR image, privacy mask, valid area (uint8) and K."""
    cam = model.cameras[img.camera_id]
    f, cx, cy = cam.params[0], cam.params[1], cam.params[2]
    k1 = cam.params[3] if len(cam.params) > 3 else 0.0
    bgr = cv2.imread(str(images_dir / img.name), cv2.IMREAD_COLOR)
    mask = cv2.imread(str(masks_dir / f"{img.name}.png"), cv2.IMREAD_GRAYSCALE)
    if bgr is None or mask is None:
        raise FileNotFoundError("frame or mask missing from scratch")
    K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]], dtype=np.float64)
    dist = np.array([k1, 0, 0, 0], dtype=np.float64)
    bgr = cv2.undistort(bgr, K, dist)
    valid = cv2.undistort(np.full(mask.shape, 255, np.uint8), K, dist)
    mask = cv2.undistort(mask, K, dist)
    return bgr, mask, valid, K


def load_views(model: pycolmap.Reconstruction, images_dir: Path, masks_dir: Path, long_edge: int, device: torch.device) -> list[View]:
    """Undistort and downscale every registered frame and its mask."""
    views: list[View] = []
    for img in posed_images(model):
        bgr, mask, valid, K = undistort_frame(model, img, images_dir, masks_dir)
        h, w = bgr.shape[:2]
        scale = min(1.0, long_edge / max(h, w))
        if scale < 1.0:
            size = (round(w * scale), round(h * scale))
            bgr = cv2.resize(bgr, size, interpolation=cv2.INTER_AREA)
            mask = cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST)
            valid = cv2.resize(valid, size, interpolation=cv2.INTER_NEAREST)
        Ks = K.copy()
        Ks[:2] *= scale
        viewmat = np.eye(4)
        viewmat[:3] = img.cam_from_world().matrix()
        views.append(
            View(
                name=img.name,
                image=torch.from_numpy(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)).to(device),
                mask=torch.from_numpy((mask > 127) & (valid > 127)).to(device),
                K=torch.tensor(Ks, dtype=torch.float32, device=device),
                viewmat=torch.tensor(viewmat, dtype=torch.float32, device=device),
                center=img.projection_center(),
            )
        )
    return views


def _ssim_map(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """SSIM over NCHW images with an 11-tap Gaussian window (fallback path)."""
    coords = torch.arange(11, dtype=a.dtype, device=a.device) - 5
    g = torch.exp(-(coords**2) / (2 * 1.5**2))
    g = (g / g.sum()).view(1, 1, 1, 11)
    win_x = g.expand(a.shape[1], 1, 1, 11)
    win_y = g.transpose(2, 3).expand(a.shape[1], 1, 11, 1)

    def blur(x: torch.Tensor) -> torch.Tensor:
        return F.conv2d(F.conv2d(x, win_x, padding=(0, 5), groups=x.shape[1]), win_y, padding=(5, 0), groups=x.shape[1])

    mu_a, mu_b = blur(a), blur(b)
    var_a = blur(a * a) - mu_a**2
    var_b = blur(b * b) - mu_b**2
    cov = blur(a * b) - mu_a * mu_b
    c1, c2 = 0.01**2, 0.03**2
    return ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (var_a + var_b + c2))


def ssim(a_nchw: torch.Tensor, b_nchw: torch.Tensor) -> torch.Tensor:
    if _fused_ssim is not None and a_nchw.is_cuda:
        return _fused_ssim(a_nchw, b_nchw, padding="valid")
    return _ssim_map(a_nchw, b_nchw).mean()


def _knn_scale(points: torch.Tensor) -> torch.Tensor:
    """Mean distance to the 3 nearest neighbours.

    A KD-tree, not all-pairs distances: those are quadratic in time and, per
    chunk, in memory, which a dense initial point cloud of millions of points
    cannot afford.
    """
    from scipy.spatial import cKDTree

    pts = points.detach().cpu().numpy()
    d, _ = cKDTree(pts).query(pts, k=4, workers=-1)
    return torch.from_numpy(d[:, 1:].mean(1)).float().to(points.device).clamp(min=1e-4)


def _rotation_6d_to_matrix(d6: torch.Tensor) -> torch.Tensor:
    a1, a2 = d6[..., :3], d6[..., 3:]
    b1 = F.normalize(a1, dim=-1)
    b2 = F.normalize(a2 - (b1 * a2).sum(-1, keepdim=True) * b1, dim=-1)
    return torch.stack((b1, b2, torch.cross(b1, b2, dim=-1)), dim=-2)


class CameraOpt(torch.nn.Module):
    """Per-frame pose deltas (3D translation + 6D rotation), as in gsplat's examples (Apache-2.0)."""

    def __init__(self, n: int) -> None:
        super().__init__()
        self.embeds = torch.nn.Embedding(n, 9)
        torch.nn.init.zeros_(self.embeds.weight)
        self.register_buffer("identity", torch.tensor([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]))

    def forward(self, viewmat: torch.Tensor, index: int) -> torch.Tensor:
        delta = self.embeds.weight[index]
        transform = torch.eye(4, device=viewmat.device)
        transform[:3, :3] = _rotation_6d_to_matrix(delta[3:] + self.identity)
        transform[:3, 3] = delta[:3]
        return torch.linalg.inv(torch.linalg.inv(viewmat) @ transform)

    def grow(self, extra: int) -> None:
        old = self.embeds.weight.data
        self.embeds = torch.nn.Embedding(old.shape[0] + extra, 9).to(old.device)
        torch.nn.init.zeros_(self.embeds.weight)
        self.embeds.weight.data[: old.shape[0]] = old


def _colour_corrected_psnr(pred: torch.Tensor, gt: torch.Tensor, mask: torch.Tensor) -> float:
    """PSNR after a least-squares affine colour fit (held-out frames have their own exposure)."""
    p = pred[mask].reshape(-1, 3)
    g = gt[mask].reshape(-1, 3)
    if p.shape[0] < 100:
        return float("nan")
    A = torch.cat([p, torch.ones_like(p[:, :1])], 1)
    sol = torch.linalg.lstsq(A, g).solution
    fitted = (A @ sol).clamp(0, 1)
    mse = ((fitted - g) ** 2).mean()
    return float(-10 * torch.log10(mse.clamp(min=1e-10)))


class Trainer:
    def __init__(
        self,
        model: pycolmap.Reconstruction,
        views: list[View],
        *,
        iterations: int,
        max_gaussians: int,
        sh_degree: int,
        checkpoint: Path,
        device: torch.device,
        strategy: str = "mcmc",
        depth_prior=None,  # noqa: ANN001 - depth.DepthPrior, imported lazily
        pose_opt: bool = True,
        bilateral_grid: bool = True,
        sky: bool = True,
        drop_rate: float = DROP_RATE,
        anisotropy: bool = False,
        init_points: tuple[np.ndarray, np.ndarray] | None = None,
        seed: int = 0,
    ) -> None:
        torch.manual_seed(seed)
        self.drop_rate = drop_rate
        self.anisotropy = anisotropy
        self.device = device
        self.iterations = iterations
        self.max_gaussians = max_gaussians
        self.sh_degree = sh_degree
        self.checkpoint = checkpoint
        # Train in a normalised frame (camera centroid at the origin, cameras
        # within a unit radius), exactly as gsplat's reference trainer does:
        # every tested hyperparameter — regularisers, MCMC noise, initial
        # scales — assumes that scale. Export maps back to metric scene space.
        world_centers = np.array([v.center for v in views])
        self.norm_center = world_centers.mean(0)
        self.norm_scale = float(np.linalg.norm(world_centers - self.norm_center, axis=1).max() * 1.1) or 1.0
        views = [self._to_internal(v) for v in views]
        self.train_views = [v for i, v in enumerate(views) if not held_out(i, len(views))]
        self.test_views = [v for i, v in enumerate(views) if held_out(i, len(views))]

        centers = np.array([v.center for v in views])
        self.scene_center = centers.mean(0)
        self.scene_scale = float(np.linalg.norm(centers - self.scene_center, axis=1).max() * 1.1) or 1.0

        pts = ((np.array([p.xyz for p in model.points3D.values()]) - self.norm_center) / self.norm_scale).astype(np.float32)
        rgb = np.array([p.color for p in model.points3D.values()], dtype=np.float32) / 255.0
        if init_points is not None:
            # Extra measured surface points (world xyz, uint8 rgb), such as the
            # fused multi-view depth of recon/dense.py: Gaussians then also
            # start on surfaces the sparse solve missed, with initial scales
            # from the same nearest-neighbour rule as the SfM points.
            xyz, colour = init_points
            pts = np.concatenate([pts, ((np.asarray(xyz, np.float64) - self.norm_center) / self.norm_scale).astype(np.float32)])
            rgb = np.concatenate([rgb, np.asarray(colour, np.float32) / 255.0])
        dist = _knn_scale(torch.tensor(pts, device=device))
        if sky:
            # Fibonacci points on the upper hemisphere (z is up in scene space),
            # far enough to read as background, inside SPZ's fixed-point range.
            self.sky_radius = float(min(1000.0 / self.norm_scale, max(60.0 / self.norm_scale, 5.0 * self.scene_scale)))
            i = np.arange(SKY_POINTS) + 0.5
            z = 1.0 - i / SKY_POINTS * 1.1  # from straight up to slightly below the horizon
            r = np.sqrt(np.clip(1 - z * z, 0, 1))
            phi = i * math.pi * (3 - math.sqrt(5))
            dirs = np.stack([r * np.cos(phi), r * np.sin(phi), z], 1).astype(np.float32)
            sky_pts = self.scene_center.astype(np.float32) + dirs * self.sky_radius
            spacing = self.sky_radius * math.sqrt(4 * math.pi / SKY_POINTS)
            pts = np.concatenate([pts, sky_pts])
            rgb = np.concatenate([rgb, np.full((SKY_POINTS, 3), 0.75, np.float32)])
            dist = torch.cat([dist, torch.full((SKY_POINTS,), spacing, device=device)])
        means = torch.tensor(pts, device=device)
        n = means.shape[0]
        k = (sh_degree + 1) ** 2
        colors = torch.zeros((n, k, 3), device=device)
        colors[:, 0] = (torch.tensor(rgb, device=device) - 0.5) / SH_C0
        self.mcmc = strategy == "mcmc"
        init_opacity = 0.5 if self.mcmc else 0.1
        self.splats = torch.nn.ParameterDict(
            {
                "means": torch.nn.Parameter(means),
                "scales": torch.nn.Parameter(torch.log(dist * (0.1 if self.mcmc else 1.0))[:, None].repeat(1, 3)),
                "quats": torch.nn.Parameter(torch.rand((n, 4), device=device)),
                "opacities": torch.nn.Parameter(torch.logit(torch.full((n,), init_opacity, device=device))),
                "sh0": torch.nn.Parameter(colors[:, :1]),
                "shN": torch.nn.Parameter(colors[:, 1:]),
            }
        )
        lrs = {"means": 1.6e-4 * self.scene_scale, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}
        self.optimizers = {
            name: torch.optim.Adam([{"params": self.splats[name], "lr": lr, "name": name}], eps=1e-15)
            for name, lr in lrs.items()
        }
        self.means_decay = 0.01 ** (1.0 / iterations)
        if self.mcmc:
            self.strategy = MCMCStrategy(cap_max=max_gaussians, refine_start_iter=500, refine_stop_iter=int(iterations * 0.85), refine_every=100)
            self.state = self.strategy.initialize_state()
        else:
            self.strategy = DefaultStrategy(refine_start_iter=500, refine_stop_iter=int(iterations * 0.5), reset_every=3000, refine_every=100, verbose=False)
            self.state = self.strategy.initialize_state(scene_scale=self.scene_scale)
        self.strategy.check_sanity(self.splats, self.optimizers)

        self.pose = CameraOpt(len(self.train_views)).to(device) if pose_opt else None
        self.pose_opt = torch.optim.Adam(self.pose.parameters(), lr=POSE_LR, weight_decay=POSE_REG) if pose_opt else None
        self.bilagrid = BilateralGrid(len(self.train_views), grid_X=16, grid_Y=16, grid_W=8).to(device) if bilateral_grid else None
        self.bilagrid_opt = torch.optim.Adam(self.bilagrid.parameters(), lr=BILAGRID_LR, eps=1e-15) if bilateral_grid else None
        self.disparity = [depth_prior.disparity(v.image) for v in self.train_views] if depth_prior else None
        self.step = 0

    # ── normalised frame ──────────────────────────────────────────────────

    def _to_internal(self, view: View) -> View:
        c = torch.tensor(self.norm_center, dtype=torch.float32, device=view.viewmat.device)
        vm = view.viewmat.clone()
        vm[:3, 3] = (vm[:3, :3] @ c + vm[:3, 3]) / self.norm_scale
        return dataclasses.replace(view, viewmat=vm, center=(np.asarray(view.center) - self.norm_center) / self.norm_scale)

    def to_world_point(self, p: np.ndarray) -> np.ndarray:
        return np.asarray(p) * self.norm_scale + self.norm_center

    # ── views added mid-run (generative repair) ────────────────────────────

    def add_views(self, views: list[View]) -> None:
        if not views:
            return
        self.train_views.extend(views)
        if self.disparity is not None:
            self.disparity.extend([None] * len(views))
        if self.pose is not None:
            self.pose.grow(len(views))
            self.pose_opt = torch.optim.Adam(self.pose.parameters(), lr=POSE_LR, weight_decay=POSE_REG)
        if self.bilagrid is not None:
            old = self.bilagrid
            grown = BilateralGrid(len(self.train_views), grid_X=16, grid_Y=16, grid_W=8).to(self.device)
            grown.grids.data[: old.grids.shape[0]] = old.grids.data
            self.bilagrid = grown
            self.bilagrid_opt = torch.optim.Adam(self.bilagrid.parameters(), lr=BILAGRID_LR, eps=1e-15)

    # ── checkpoints ────────────────────────────────────────────────────────

    def save(self) -> None:
        self.checkpoint.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.checkpoint.with_suffix(".tmp")
        torch.save(
            {
                "step": self.step,
                "splats": self.splats.state_dict(),
                "optimizers": {k: o.state_dict() for k, o in self.optimizers.items()},
                "refine_stop_iter": self.strategy.refine_stop_iter,
                "pose": self.pose.state_dict() if self.pose is not None else None,
                "bilagrid": self.bilagrid.state_dict() if self.bilagrid is not None else None,
                "n_views": len(self.train_views),
            },
            tmp,
        )
        tmp.replace(self.checkpoint)

    def try_resume(self) -> bool:
        if not self.checkpoint.exists():
            return False
        data = torch.load(self.checkpoint, map_location=self.device, weights_only=False)
        if data.get("n_views") not in (None, len(self.train_views)):
            return False
        for name, tensor in data["splats"].items():
            self.splats[name] = torch.nn.Parameter(tensor)
        for name, opt in self.optimizers.items():
            opt.param_groups[0]["params"] = [self.splats[name]]
            opt.load_state_dict(data["optimizers"][name])
        self.strategy.refine_stop_iter = data["refine_stop_iter"]
        self.state = self.strategy.initialize_state() if self.mcmc else self.strategy.initialize_state(scene_scale=self.scene_scale)
        if self.pose is not None and data.get("pose"):
            self.pose.load_state_dict(data["pose"])
        if self.bilagrid is not None and data.get("bilagrid"):
            self.bilagrid.load_state_dict(data["bilagrid"])
        self.step = int(data["step"])
        return True

    # ── rendering ──────────────────────────────────────────────────────────

    def render(self, view_K: torch.Tensor, viewmat: torch.Tensor, w: int, h: int, sh_degree: int, mode: str = "RGB", drop: float = 0.0):
        s = self.splats
        opacities = torch.sigmoid(s["opacities"])
        if drop > 0:
            # DropGaussian (structural regularisation for sparse views): no single
            # Gaussian may be needed to explain a frame on its own.
            keep = (torch.rand_like(opacities) > drop).float()
            opacities = opacities * keep / (1.0 - drop)
            opacities = opacities.clamp(max=0.999)
        return rasterization(
            means=s["means"],
            quats=s["quats"],
            scales=torch.exp(s["scales"]),
            opacities=opacities,
            colors=torch.cat([s["sh0"], s["shN"]], 1),
            viewmats=viewmat[None],
            Ks=view_K[None],
            width=w,
            height=h,
            sh_degree=sh_degree,
            packed=False,
            rasterize_mode="antialiased",
            render_mode=mode,
        )

    def _compensate(self, rgb: torch.Tensor, index: int) -> torch.Tensor:
        if self.bilagrid is None:
            return rgb
        h, w = rgb.shape[:2]
        gy, gx = torch.meshgrid(
            (torch.arange(h, device=self.device) + 0.5) / h, (torch.arange(w, device=self.device) + 0.5) / w, indexing="ij"
        )
        xy = torch.stack([gx, gy], -1)[None]
        return bilagrid_slice(self.bilagrid, xy, rgb[None], torch.tensor([[index]], device=self.device))["rgb"][0]

    # ── training ───────────────────────────────────────────────────────────

    def train(self, on_progress: Callable[[float], None]) -> None:
        rng = np.random.default_rng(self.step)
        while self.step < self.iterations:
            index = int(rng.integers(len(self.train_views)))
            view = self.train_views[index]
            h, w = view.image.shape[:2]
            degree = min(self.step // 1000, self.sh_degree)
            viewmat = self.pose(view.viewmat, index) if self.pose is not None else view.viewmat
            with_depth = self.disparity is not None and self.disparity[index] is not None
            renders, _alphas, info = self.render(view.K, viewmat, w, h, degree, "RGB+ED" if with_depth else "RGB", drop=self.drop_rate)
            pred = self._compensate(renders[0][..., :3], index).clamp(0, 1)
            gt = view.image.float() / 255.0
            m = view.mask[..., None].float()
            l1 = (torch.abs(pred - gt) * m).sum() / (m.sum() * 3).clamp(min=1)
            s = ssim((pred * m).permute(2, 0, 1)[None], (gt * m).permute(2, 0, 1)[None])
            loss = ((1 - SSIM_LAMBDA) * l1 + SSIM_LAMBDA * (1 - s)) * view.weight
            if self.mcmc:
                loss = loss + OPACITY_REG * torch.sigmoid(self.splats["opacities"]).mean() + SCALE_REG * torch.exp(self.splats["scales"]).mean()
            if self.bilagrid is not None:
                loss = loss + BILAGRID_TV * total_variation_loss(self.bilagrid.grids)
            if self.anisotropy:
                sc = torch.exp(self.splats["scales"])
                ratio = sc.max(dim=1).values / sc.min(dim=1).values.clamp(min=1e-8)
                loss = loss + ANISOTROPY_WEIGHT * torch.relu(ratio - MAX_ANISOTROPY).mean()
            if with_depth:
                from .depth import pearson_depth_loss

                t = self.step / max(1, self.iterations)
                weight = DEPTH_WEIGHT_START + (DEPTH_WEIGHT_END - DEPTH_WEIGHT_START) * t
                loss = loss + weight * pearson_depth_loss(renders[0][..., 3], self.disparity[index], view.mask)

            self.strategy.step_pre_backward(self.splats, self.optimizers, self.state, self.step, info)
            loss.backward()
            for opt in self.optimizers.values():
                opt.step()
                opt.zero_grad(set_to_none=True)
            for opt in (self.pose_opt, self.bilagrid_opt):
                if opt is not None:
                    opt.step()
                    opt.zero_grad(set_to_none=True)
            means_lr = self.optimizers["means"].param_groups[0]["lr"]
            self.optimizers["means"].param_groups[0]["lr"] *= self.means_decay
            if self.mcmc:
                self.strategy.step_post_backward(self.splats, self.optimizers, self.state, self.step, info, lr=means_lr)
            else:
                self.strategy.step_post_backward(self.splats, self.optimizers, self.state, self.step, info, packed=False)
                if self.splats["means"].shape[0] >= self.max_gaussians and self.strategy.refine_stop_iter > self.step:
                    self.strategy.refine_stop_iter = self.step
            self.step += 1
            if self.step % CHECKPOINT_EVERY == 0:
                self.save()
            if self.step % 100 == 0:
                on_progress(self.step / self.iterations)

    @torch.no_grad()
    def evaluate(self) -> tuple[float, float, float]:
        """Masked PSNR, masked SSIM and colour-corrected PSNR on held-out frames."""
        if not self.test_views:
            return float("nan"), float("nan"), float("nan")
        psnrs, ssims, ccs = [], [], []
        for view in self.test_views:
            h, w = view.image.shape[:2]
            pred = self.render(view.K, view.viewmat, w, h, self.sh_degree)[0][0].clamp(0, 1)
            gt = view.image.float() / 255.0
            m = view.mask[..., None].float()
            mse = (((pred - gt) ** 2) * m).sum() / (m.sum() * 3).clamp(min=1)
            psnrs.append(float(-10 * torch.log10(mse.clamp(min=1e-10))))
            ssims.append(float(_ssim_map((pred * m).permute(2, 0, 1)[None], (gt * m).permute(2, 0, 1)[None]).mean()))
            ccs.append(_colour_corrected_psnr(pred, gt, view.mask))
        return float(np.mean(psnrs)), float(np.mean(ssims)), float(np.nanmean(ccs))

    @torch.no_grad()
    def visible_views(self) -> torch.Tensor:
        """How many real training frames each Gaussian actually lands in."""
        counts = torch.zeros(self.splats["means"].shape[0], dtype=torch.int32, device=self.device)
        for view in self.train_views:
            if view.weight < 1.0:
                continue
            h, w = view.image.shape[:2]
            _, _, info = self.render(view.K, view.viewmat, w, h, 0)
            radii = info["radii"][0]
            counts += ((radii > 0).all(-1) if radii.dim() == 2 else radii > 0).int()
        return counts

    def importance(self) -> torch.Tensor:
        """How much each Gaussian contributes to the real frames (LightGaussian-style).

        The gradient of the summed rendered colour with respect to each
        Gaussian's (activated) opacity, times that opacity, accumulates its
        blending contribution over every pixel of every real frame. Floaters —
        semi-transparent fragments that barely affect any real view yet show up
        as shards from new viewpoints — score near zero.
        """
        s = self.splats
        total = torch.zeros(s["means"].shape[0], device=self.device)
        opacity = torch.sigmoid(s["opacities"]).detach()
        for view in self.train_views:
            if view.weight < 1.0:
                continue
            h, w = view.image.shape[:2]
            op = opacity.clone().requires_grad_(True)
            rgb, _, _ = rasterization(
                means=s["means"].detach(), quats=s["quats"].detach(), scales=torch.exp(s["scales"]).detach(), opacities=op,
                colors=torch.cat([s["sh0"], s["shN"]], 1).detach(), viewmats=view.viewmat[None], Ks=view.K[None],
                width=w, height=h, sh_degree=self.sh_degree, packed=False, rasterize_mode="antialiased",
            )
            (rgb * view.mask[None, ..., None]).sum().backward()
            total += (op.grad * op).abs().detach()
        return total

    @torch.no_grad()
    def outliers(self, keep: torch.Tensor) -> torch.Tensor:
        """Isolated Gaussians: mean distance to K neighbours far above the typical spread."""
        from scipy.spatial import cKDTree

        idx = keep.nonzero().squeeze(1)
        pts = self.splats["means"][idx].cpu().numpy()
        d, _ = cKDTree(pts).query(pts, k=OUTLIER_K + 1, workers=-1)
        d = d[:, 1:].mean(1)
        bad = d > d.mean() + OUTLIER_STD * d.std()
        out = torch.zeros_like(keep)
        out[idx[torch.from_numpy(bad).to(self.device)]] = True
        return out

    @torch.no_grad()
    def colour_calibration(self, samples_per_view: int = 4000) -> tuple[torch.Tensor, torch.Tensor]:
        """A global affine colour map (3x3, 3) from raw renders to the real frames.

        Per-frame compensation lets the scene's canonical colour drift (a cast
        no single frame shows). Fitting one affine map over every real frame
        and baking it into the colours removes the cast without touching
        geometry.
        """
        preds, gts = [], []
        gen = torch.Generator(device=self.device).manual_seed(0)
        for view in self.train_views:
            if view.weight < 1.0:
                continue
            h, w = view.image.shape[:2]
            pred = self.render(view.K, view.viewmat, w, h, self.sh_degree)[0][0].clamp(0, 1).reshape(-1, 3)
            gt = (view.image.float() / 255.0).reshape(-1, 3)
            usable = view.mask.reshape(-1).nonzero().squeeze(1)
            if usable.numel() == 0:
                continue
            pick = usable[torch.randint(usable.numel(), (min(samples_per_view, usable.numel()),), generator=gen, device=self.device)]
            preds.append(pred[pick])
            gts.append(gt[pick])
        if not preds:
            return torch.eye(3, device=self.device), torch.zeros(3, device=self.device)
        P, G = torch.cat(preds), torch.cat(gts)
        A = torch.cat([P, torch.ones_like(P[:, :1])], 1)
        sol = torch.linalg.lstsq(A, G).solution  # (4, 3)
        return sol[:3].T, sol[3]

    @torch.no_grad()
    def export(self) -> GaussianCloud:
        s = self.splats
        keep = torch.sigmoid(s["opacities"]) > 0.005
        keep &= torch.isfinite(s["means"]).all(1)
        centre = torch.tensor(self.scene_center, dtype=torch.float32, device=self.device)
        keep &= (s["means"] - centre).norm(dim=1) < max(300.0 / self.norm_scale, 6.0 * self.scene_scale, 1.2 * getattr(self, "sky_radius", 0.0))
        keep &= self.visible_views() >= MIN_VISIBLE_VIEWS
        with torch.enable_grad():
            score = self.importance()
        order = torch.argsort(score, descending=True)
        cumulative = torch.cumsum(score[order], 0)
        cut = int(torch.searchsorted(cumulative, cumulative[-1] * IMPORTANCE_KEEP).item()) + 1
        important = torch.zeros_like(keep)
        important[order[:cut]] = True
        keep &= important
        keep &= ~self.outliers(keep)
        idx = keep.nonzero().squeeze(1)
        if idx.numel() > self.max_gaussians:
            idx = idx[torch.sigmoid(s["opacities"][idx]).argsort(descending=True)[: self.max_gaussians]]
        M, b = self.colour_calibration()
        # colour = SH_C0 * sh0 + 0.5 (+ view-dependent terms, linear in shN)
        base = SH_C0 * s["sh0"][idx][:, 0] + 0.5
        sh0 = ((base @ M.T + b) - 0.5) / SH_C0
        shN = s["shN"][idx] @ M.T
        return GaussianCloud(
            means=(s["means"][idx].cpu().numpy() * self.norm_scale + self.norm_center).astype(np.float32),
            quats=F.normalize(s["quats"][idx], dim=1).cpu().numpy(),
            scales=(s["scales"][idx].cpu().numpy() + math.log(self.norm_scale)).astype(np.float32),
            opacities=s["opacities"][idx].cpu().numpy(),
            sh0=sh0.cpu().numpy(),
            shN=shN.cpu().numpy(),
        )

    @torch.no_grad()
    def initial_view(self, views: list[View]) -> tuple[View, list[float], list[float]]:
        """The world-space frame nearest the middle of the capture, looking where it looked."""
        centers = np.array([v.center for v in views])
        view = views[int(np.argmin(np.linalg.norm(centers - centers.mean(0), axis=1)))]
        forward = view.viewmat[:3, :3].cpu().numpy().T @ np.array([0.0, 0.0, 1.0])
        position = np.asarray(view.center)
        return view, [float(x) for x in position], [float(x) for x in position + forward * 10.0]

    @torch.no_grad()
    def render_view(self, view: View) -> np.ndarray:
        """Render a WORLD-space view (as returned by load_views)."""
        view = self._to_internal(view)
        h, w = view.image.shape[:2]
        pred = self.render(view.K, view.viewmat, w, h, self.sh_degree)[0][0].clamp(0, 1)
        return (pred.cpu().numpy() * 255).astype(np.uint8)


def train_scene(
    model: pycolmap.Reconstruction,
    images_dir: Path,
    masks_dir: Path,
    work_dir: Path,
    *,
    iterations: int,
    max_gaussians: int,
    long_edge: int,
    sh_degree: int,
    on_progress: Callable[[float], None],
    device: torch.device,
    strategy: str = "mcmc",
    depth_prior=None,  # noqa: ANN001
    init_points: tuple[np.ndarray, np.ndarray] | None = None,
) -> TrainResult:
    started = time.monotonic()
    work_dir.mkdir(parents=True, exist_ok=True)
    torch.cuda.reset_peak_memory_stats(device)
    views = load_views(model, images_dir, masks_dir, long_edge, device)
    trainer = Trainer(
        model,
        views,
        iterations=iterations,
        max_gaussians=max_gaussians,
        sh_degree=sh_degree,
        checkpoint=work_dir / "train.ckpt",
        device=device,
        strategy=strategy,
        depth_prior=depth_prior,
        init_points=init_points,
    )
    trainer.try_resume()
    trainer.train(on_progress)
    psnr, ssim_value, cc = trainer.evaluate()
    cloud = trainer.export()
    view, position, target = trainer.initial_view(views)
    poster = trainer.render_view(view)
    if not math.isfinite(psnr):
        psnr, ssim_value = 0.0, 0.0
    return TrainResult(
        cloud=cloud,
        iterations=trainer.step,
        seconds=time.monotonic() - started,
        peak_vram_mb=int(torch.cuda.max_memory_allocated(device) / 2**20),
        psnr=psnr,
        ssim=ssim_value,
        poster=poster,
        initial_position=position,
        initial_target=target,
        cc_psnr=cc if math.isfinite(cc) else 0.0,
    )
