"""Monocular depth priors for Gaussian training.

A street captured along one path leaves most surfaces seen from a narrow range
of directions. Photometric loss alone then accepts shards and floaters that
happen to reproduce those few views. A monocular depth estimate supplies the
missing shape cue: the trainer asks rendered inverse depth to CORRELATE with
the estimate (scale- and shift-free, so the estimate's unknown scale never
fights the metric solve).

Depth Anything V2 Small (Apache-2.0), loaded from SHA-256-pinned files. The
larger checkpoints are non-commercial and are deliberately not supported.
"""

from __future__ import annotations

from pathlib import Path

import torch
import torch.nn.functional as F

from ..models import DEPTH_MODEL_FILES, ensure_model


class DepthPrior:
    def __init__(self, models_dir: Path, device: torch.device) -> None:
        from transformers import AutoModelForDepthEstimation

        for pinned in DEPTH_MODEL_FILES:
            ensure_model(pinned, models_dir)
        folder = models_dir / DEPTH_MODEL_FILES[0].filename.split("/")[0]
        self.model = AutoModelForDepthEstimation.from_pretrained(folder, local_files_only=True).eval().to(device)
        self.device = device
        self.mean = torch.tensor([0.485, 0.456, 0.406], device=device).view(1, 3, 1, 1)
        self.std = torch.tensor([0.229, 0.224, 0.225], device=device).view(1, 3, 1, 1)

    @torch.inference_mode()
    def disparity(self, image_uint8_hwc: torch.Tensor, long_edge: int = 518) -> torch.Tensor:
        """Relative inverse depth at the image's own resolution (float16)."""
        h, w = image_uint8_hwc.shape[:2]
        scale = long_edge / max(h, w)
        th, tw = max(14, round(h * scale / 14) * 14), max(14, round(w * scale / 14) * 14)
        x = image_uint8_hwc.permute(2, 0, 1)[None].float() / 255.0
        x = F.interpolate(x, size=(th, tw), mode="bilinear", align_corners=False)
        out = self.model(pixel_values=(x - self.mean) / self.std).predicted_depth
        out = F.interpolate(out[:, None], size=(h, w), mode="bilinear", align_corners=False)[0, 0]
        return out.half()


def pearson_depth_loss(rendered_depth: torch.Tensor, prior_disparity: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """1 - Pearson correlation between rendered inverse depth and the prior, on usable pixels."""
    valid = mask & (rendered_depth > 1e-3)
    if valid.sum() < 100:
        return rendered_depth.sum() * 0.0
    a = 1.0 / rendered_depth[valid]
    b = prior_disparity[valid].float()
    a = (a - a.mean()) / (a.std() + 1e-6)
    b = (b - b.mean()) / (b.std() + 1e-6)
    return 1.0 - (a * b).mean()
