"""Gaussian training on solved, privacy-masked frames (gsplat baseline).

The trainer is the minimal faithful version of gsplat's reference loop:
Gaussians initialised from the sparse points, Adam per parameter, gsplat's
DefaultStrategy for densification, L1 + SSIM loss. Three GoWay-specific rules
sit on top:

- the loss only sees pixels the privacy mask allows. People and vehicles never
  contribute appearance, so they cannot be learned into the scene;
- the Gaussian count is a budget, not an outcome. The default densification is
  gsplat's MCMC strategy, which relocates Gaussians within a fixed cap instead
  of growing until something stops it, with light opacity and scale
  regularisation against floaters;
- contributions are shot on different days, devices and exposures, so each
  training frame gets a small learned colour transform (3x3 + bias) applied to
  the render before the loss. The scene learns the common appearance; the
  per-frame transforms absorb exposure and white balance and are discarded;
- every ``CHECKPOINT_EVERY`` steps the state is written to the job's scratch
  directory, so a restarted worker resumes instead of starting over.

Two more rules fight the artefacts of sparse, one-directional street capture:
a monocular depth prior (``depth.py``) the rendered inverse depth must
correlate with, and visibility pruning at export — a Gaussian that fewer than
``MIN_VISIBLE_VIEWS`` training frames ever saw is not evidence, it is a guess,
and it is what turns into shards the moment the viewer looks elsewhere.

Every eighth registered frame is held out and scored afterwards; that score is
a publication gate.
"""

from __future__ import annotations

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

from .spz import GaussianCloud

SH_C0 = 0.28209479177387814
CHECKPOINT_EVERY = 2000
MIN_VISIBLE_VIEWS = 3
DEPTH_WEIGHT_START, DEPTH_WEIGHT_END = 0.2, 0.02
MAX_ANISOTROPY = 8.0
ANISOTROPY_WEIGHT = 0.1
HOLDOUT_EVERY = 8


@dataclass
class View:
    name: str
    image: torch.Tensor  # uint8 HxWx3 on device
    mask: torch.Tensor  # bool HxW on device
    K: torch.Tensor  # 3x3
    viewmat: torch.Tensor  # 4x4 world->camera
    center: np.ndarray


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


def load_views(model: pycolmap.Reconstruction, images_dir: Path, masks_dir: Path, long_edge: int, device: torch.device) -> list[View]:
    """Undistort and downscale every registered frame and its mask."""
    views: list[View] = []
    for img in sorted(model.images.values(), key=lambda i: i.name):
        if not img.has_pose:
            continue
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
        h, w = bgr.shape[:2]
        scale = min(1.0, long_edge / max(h, w))
        if scale < 1.0:
            size = (round(w * scale), round(h * scale))
            bgr = cv2.resize(bgr, size, interpolation=cv2.INTER_AREA)
            mask = cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST)
            valid = cv2.resize(valid, size, interpolation=cv2.INTER_NEAREST)
        Ks = K.copy()
        Ks[:2] *= scale
        rigid = img.cam_from_world().matrix()
        viewmat = np.eye(4)
        viewmat[:3] = rigid
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


def _ssim(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    """SSIM over NCHW images with an 11-tap Gaussian window; returns the map mean per channel map."""
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


def _knn_scale(points: torch.Tensor) -> torch.Tensor:
    """Mean distance to the 3 nearest neighbours, chunked to bound memory."""
    out = torch.empty(points.shape[0], device=points.device)
    for start in range(0, points.shape[0], 4096):
        d = torch.cdist(points[start : start + 4096], points)
        out[start : start + 4096] = d.topk(4, largest=False).values[:, 1:].mean(1)
    return out.clamp(min=1e-4)


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
        strategy: str = "default",
        depth_prior=None,  # noqa: ANN001 - depth.DepthPrior, imported lazily
        seed: int = 0,
    ) -> None:
        torch.manual_seed(seed)
        self.device = device
        self.iterations = iterations
        self.max_gaussians = max_gaussians
        self.sh_degree = sh_degree
        self.checkpoint = checkpoint
        self.train_views = [v for i, v in enumerate(views) if i % HOLDOUT_EVERY != 0 or len(views) < 2 * HOLDOUT_EVERY]
        self.test_views = [v for i, v in enumerate(views) if i % HOLDOUT_EVERY == 0 and len(views) >= 2 * HOLDOUT_EVERY]

        centers = np.array([v.center for v in views])
        self.scene_center = centers.mean(0)
        self.scene_scale = float(np.linalg.norm(centers - self.scene_center, axis=1).max() * 1.1) or 1.0

        pts = np.array([p.xyz for p in model.points3D.values()], dtype=np.float32)
        rgb = np.array([p.color for p in model.points3D.values()], dtype=np.float32) / 255.0
        means = torch.tensor(pts, device=device)
        dist = _knn_scale(means)
        n = means.shape[0]
        k = (sh_degree + 1) ** 2
        colors = torch.zeros((n, k, 3), device=device)
        colors[:, 0] = (torch.tensor(rgb, device=device) - 0.5) / SH_C0
        self.splats = torch.nn.ParameterDict(
            {
                "means": torch.nn.Parameter(means),
                "scales": torch.nn.Parameter(torch.log(dist)[:, None].repeat(1, 3)),
                "quats": torch.nn.Parameter(torch.rand((n, 4), device=device)),
                "opacities": torch.nn.Parameter(torch.logit(torch.full((n,), 0.5 if strategy == "mcmc" else 0.1, device=device))),
                "sh0": torch.nn.Parameter(colors[:, :1]),
                "shN": torch.nn.Parameter(colors[:, 1:]),
            }
        )
        lrs = {
            "means": 1.6e-4 * self.scene_scale,
            "scales": 5e-3,
            "quats": 1e-3,
            "opacities": 5e-2,
            "sh0": 2.5e-3,
            "shN": 2.5e-3 / 20,
        }
        self.optimizers = {
            name: torch.optim.Adam([{"params": self.splats[name], "lr": lr, "name": name}], eps=1e-15)
            for name, lr in lrs.items()
        }
        self.means_decay = 0.01 ** (1.0 / iterations)
        self.mcmc = strategy == "mcmc"
        if self.mcmc:
            self.strategy = MCMCStrategy(
                cap_max=max_gaussians,
                refine_start_iter=500,
                refine_stop_iter=int(iterations * 0.85),
                refine_every=100,
            )
        else:
            self.strategy = DefaultStrategy(
                refine_start_iter=500,
                refine_stop_iter=int(iterations * 0.5),
                reset_every=3000,
                refine_every=100,
                verbose=False,
            )
        self.disparity = [depth_prior.disparity(v.image) for v in self.train_views] if depth_prior else None
        # Per-frame colour transforms (exposure / white balance), identity at start.
        n_views = len(self.train_views)
        self.colour = torch.nn.Parameter(torch.eye(3, 4, device=device).repeat(n_views, 1, 1))
        self.colour_opt = torch.optim.Adam([self.colour], lr=1e-3)
        self.view_index = {id(v): i for i, v in enumerate(self.train_views)}
        self.strategy.check_sanity(self.splats, self.optimizers)
        self.state = self.strategy.initialize_state() if self.mcmc else self.strategy.initialize_state(scene_scale=self.scene_scale)
        self.step = 0

    # ── checkpoints ────────────────────────────────────────────────────────

    def save(self) -> None:
        tmp = self.checkpoint.with_suffix(".tmp")
        torch.save(
            {
                "step": self.step,
                "splats": self.splats.state_dict(),
                "optimizers": {k: o.state_dict() for k, o in self.optimizers.items()},
                "refine_stop_iter": self.strategy.refine_stop_iter,
                "colour": self.colour.detach(),
            },
            tmp,
        )
        tmp.replace(self.checkpoint)

    def try_resume(self) -> bool:
        if not self.checkpoint.exists():
            return False
        data = torch.load(self.checkpoint, map_location=self.device, weights_only=False)
        for name, tensor in data["splats"].items():
            self.splats[name] = torch.nn.Parameter(tensor)
        for name, opt in self.optimizers.items():
            opt.param_groups[0]["params"] = [self.splats[name]]
            opt.load_state_dict(data["optimizers"][name])
        self.strategy.refine_stop_iter = data["refine_stop_iter"]
        if "colour" in data and data["colour"].shape == self.colour.shape:
            self.colour.data.copy_(data["colour"])
        self.state = self.strategy.initialize_state() if self.mcmc else self.strategy.initialize_state(scene_scale=self.scene_scale)
        self.step = int(data["step"])
        return True

    # ── rendering ──────────────────────────────────────────────────────────

    def render(self, view_K: torch.Tensor, viewmat: torch.Tensor, w: int, h: int, sh_degree: int, mode: str = "RGB"):
        s = self.splats
        colors = torch.cat([s["sh0"], s["shN"]], 1)
        return rasterization(
            means=s["means"],
            quats=s["quats"],
            scales=torch.exp(s["scales"]),
            opacities=torch.sigmoid(s["opacities"]),
            colors=colors,
            viewmats=viewmat[None],
            Ks=view_K[None],
            width=w,
            height=h,
            sh_degree=sh_degree,
            packed=False,
            rasterize_mode="antialiased",
            render_mode=mode,
        )

    # ── training ───────────────────────────────────────────────────────────

    def train(self, on_progress: Callable[[float], None]) -> None:
        rng = np.random.default_rng(self.step)
        while self.step < self.iterations:
            index = int(rng.integers(len(self.train_views)))
            view = self.train_views[index]
            h, w = view.image.shape[:2]
            degree = min(self.step // 1000, self.sh_degree)
            mode = "RGB+ED" if self.disparity is not None else "RGB"
            renders, _alphas, info = self.render(view.K, view.viewmat, w, h, degree, mode)
            colour = self.colour[index]
            pred = (renders[0][..., :3] @ colour[:, :3].T + colour[:, 3]).clamp(0, 1)
            gt = view.image.float() / 255.0
            m = view.mask[..., None].float()
            l1 = (torch.abs(pred - gt) * m).sum() / (m.sum() * 3).clamp(min=1)
            ssim = _ssim((pred * m).permute(2, 0, 1)[None], (gt * m).permute(2, 0, 1)[None]).mean()
            loss = 0.8 * l1 + 0.2 * (1 - ssim)
            if self.mcmc:
                loss = loss + 0.01 * torch.sigmoid(self.splats["opacities"]).mean() + 0.01 * torch.exp(self.splats["scales"]).mean()
            loss = loss + 1e-3 * (self.colour[index] - torch.eye(3, 4, device=self.device)).abs().mean()
            if self.disparity is not None:
                from .depth import pearson_depth_loss

                t = self.step / max(1, self.iterations)
                weight = DEPTH_WEIGHT_START + (DEPTH_WEIGHT_END - DEPTH_WEIGHT_START) * t
                loss = loss + weight * pearson_depth_loss(renders[0][..., 3], self.disparity[index], view.mask)
            # Needles: a street seen from one direction leaves the ground and
            # walls under-constrained, and the optimiser answers with very
            # elongated Gaussians that look like shards from any other angle.
            # Penalise anisotropy beyond MAX_ANISOTROPY (PhysGaussian-style).
            scales = torch.exp(self.splats["scales"])
            ratio = scales.max(dim=1).values / scales.min(dim=1).values.clamp(min=1e-8)
            loss = loss + ANISOTROPY_WEIGHT * torch.relu(ratio - MAX_ANISOTROPY).mean()

            self.strategy.step_pre_backward(self.splats, self.optimizers, self.state, self.step, info)
            loss.backward()
            for opt in self.optimizers.values():
                opt.step()
                opt.zero_grad(set_to_none=True)
            self.colour_opt.step()
            self.colour_opt.zero_grad(set_to_none=True)
            means_lr = self.optimizers["means"].param_groups[0]["lr"]
            self.optimizers["means"].param_groups[0]["lr"] *= self.means_decay
            if self.mcmc:
                self.strategy.step_post_backward(self.splats, self.optimizers, self.state, self.step, info, lr=means_lr)
            else:
                self.strategy.step_post_backward(self.splats, self.optimizers, self.state, self.step, info, packed=False)
                if self.splats["means"].shape[0] >= self.max_gaussians and self.strategy.refine_stop_iter > self.step:
                    self.strategy.refine_stop_iter = self.step  # budget reached: stop growing
            self.step += 1
            if self.step % CHECKPOINT_EVERY == 0:
                self.save()
            if self.step % 100 == 0:
                on_progress(self.step / self.iterations)

    @torch.no_grad()
    def evaluate(self) -> tuple[float, float]:
        if not self.test_views:
            return float("nan"), float("nan")
        psnrs, ssims = [], []
        for view in self.test_views:
            h, w = view.image.shape[:2]
            pred = self.render(view.K, view.viewmat, w, h, self.sh_degree)[0][0].clamp(0, 1)
            gt = view.image.float() / 255.0
            m = view.mask[..., None].float()
            mse = (((pred - gt) ** 2) * m).sum() / (m.sum() * 3).clamp(min=1)
            psnrs.append(float(-10 * torch.log10(mse.clamp(min=1e-10))))
            ssims.append(float(_ssim((pred * m).permute(2, 0, 1)[None], (gt * m).permute(2, 0, 1)[None]).mean()))
        return float(np.mean(psnrs)), float(np.mean(ssims))

    @torch.no_grad()
    def visible_views(self) -> torch.Tensor:
        """How many training frames each Gaussian actually lands in."""
        counts = torch.zeros(self.splats["means"].shape[0], dtype=torch.int32, device=self.device)
        for view in self.train_views:
            h, w = view.image.shape[:2]
            _, _, info = self.render(view.K, view.viewmat, w, h, 0)
            radii = info["radii"][0]
            seen = (radii > 0).all(-1) if radii.dim() == 2 else radii > 0
            counts += seen.int()
        return counts

    @torch.no_grad()
    def export(self) -> GaussianCloud:
        s = self.splats
        keep = torch.ones(s["means"].shape[0], dtype=torch.bool, device=self.device)
        keep &= torch.sigmoid(s["opacities"]) > 0.005
        keep &= torch.isfinite(s["means"]).all(1)
        # Distant Gaussians are sky and floaters, not street; they also leave
        # SPZ's fixed-point range (about ±2 km). Keep a generous radius.
        centre = torch.tensor(self.scene_center, dtype=torch.float32, device=self.device)
        keep &= (s["means"] - centre).norm(dim=1) < max(300.0, 6.0 * self.scene_scale)
        keep &= self.visible_views() >= MIN_VISIBLE_VIEWS
        idx = keep.nonzero().squeeze(1)
        if idx.numel() > self.max_gaussians:
            order = torch.sigmoid(s["opacities"][idx]).argsort(descending=True)
            idx = idx[order[: self.max_gaussians]]
        quats = F.normalize(s["quats"][idx], dim=1)
        return GaussianCloud(
            means=s["means"][idx].cpu().numpy(),
            quats=quats.cpu().numpy(),
            scales=s["scales"][idx].cpu().numpy(),
            opacities=s["opacities"][idx].cpu().numpy(),
            sh0=s["sh0"][idx][:, 0].cpu().numpy(),
            shN=s["shN"][idx].cpu().numpy(),
        )

    @torch.no_grad()
    def initial_view(self, views: list[View]) -> tuple[View, list[float], list[float]]:
        """The frame nearest the middle of the capture, looking where it looked."""
        centers = np.array([v.center for v in views])
        view = views[int(np.argmin(np.linalg.norm(centers - centers.mean(0), axis=1)))]
        rot = view.viewmat[:3, :3].cpu().numpy()
        forward = rot.T @ np.array([0.0, 0.0, 1.0])
        position = view.center
        return view, [float(x) for x in position], [float(x) for x in position + forward * 10.0]

    @torch.no_grad()
    def render_view(self, view: View) -> np.ndarray:
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
    strategy: str = "default",
    depth_prior=None,  # noqa: ANN001
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
    )
    trainer.try_resume()
    trainer.train(on_progress)
    psnr, ssim = trainer.evaluate()
    cloud = trainer.export()
    view, position, target = trainer.initial_view(views)
    poster = trainer.render_view(view)
    if not math.isfinite(psnr):
        psnr, ssim = 0.0, 0.0
    return TrainResult(
        cloud=cloud,
        iterations=trainer.step,
        seconds=time.monotonic() - started,
        peak_vram_mb=int(torch.cuda.max_memory_allocated(device) / 2**20),
        psnr=psnr,
        ssim=ssim,
        poster=poster,
        initial_position=position,
        initial_target=target,
    )
