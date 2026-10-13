"""Learned local features for the camera solve: detection, description, matching.

Two learned sets stand beside COLMAP's SIFT (``sfm.FEATURE_SETS``):

- ``aliked``: ALIKED-n16 detects and describes, LightGlue matches;
- ``raco``: RaCo detects, its ranker keeps the most reliable points, ALIKED-n16
  describes them and LightGlue+ (LightGlue retrained on RaCo keypoints) matches.

Both run on the worker's PyTorch: the pycolmap wheel's own ALIKED needs an ONNX
build it does not have. This module never sees a COLMAP type; ``sfm.py`` writes
what it returns into the solver's database and verifies it geometrically.

Privacy masks are honoured as COLMAP honours them for SIFT, but strictly: a
keypoint survives only on a pixel the mask fully trusts (255), and masked
points are dropped BEFORE the keypoint budget is spent, so a frame full of
people still gets its budget on the street.

Keypoints are returned in COLMAP's pixel convention at the frame's own
resolution: (0, 0) is the top-left corner of the image, so the centre of the
first pixel is (0.5, 0.5).
"""

from __future__ import annotations

import contextlib
import io
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import torch

from ..models import ALIKED_LIGHTGLUE_MODEL, ALIKED_MODEL, RACO_LIGHTGLUE_MODEL, RACO_MODEL, PinnedModel, ensure_model

LEARNED_SETS = ("aliked", "raco")
# Frames are detected and described at this long edge (never upscaled).
LONG_EDGE = 1600
# Keypoints kept per frame, and candidates detected before masking and ranking.
KEYPOINTS = 4096
CANDIDATES = 2 * KEYPOINTS


@dataclass
class FrameFeatures:
    keypoints: np.ndarray  # (N, 2) float32, COLMAP convention, full resolution
    descriptors: torch.Tensor  # (N, 128) float16 on the CPU: a large scene holds every frame's
    size: tuple[int, int]  # (width, height) of the frame


def trusted(keypoints: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Which keypoints (COLMAP convention, mask resolution) lie on a fully trusted pixel."""
    h, w = mask.shape
    px = np.floor(keypoints[:, 0]).astype(np.int64)
    py = np.floor(keypoints[:, 1]).astype(np.int64)
    inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
    keep = np.zeros(len(keypoints), dtype=bool)
    keep[inside] = mask[py[inside], px[inside]] >= 255
    return keep


def _state_dict(model: PinnedModel, models_dir: Path) -> dict:
    return torch.load(ensure_model(model, models_dir, download=False), map_location="cpu", weights_only=True)


def _load(module: torch.nn.Module, state: dict, derived: tuple[str, ...] = ()) -> None:
    """Load every weight exactly; only ``derived`` buffers (computed, never saved) may be absent."""
    missing, unexpected = module.load_state_dict(state, strict=False)
    if unexpected or set(missing) - set(derived):
        raise RuntimeError(f"weights do not fit {type(module).__name__}: missing {missing}, unexpected {unexpected}")


def _lightglue(model: PinnedModel, models_dir: Path, device: torch.device) -> torch.nn.Module:
    from kornia.feature import LightGlue

    with contextlib.redirect_stdout(io.StringIO()):  # it prints on construction
        matcher = LightGlue(features=None, input_dim=128)
    state = _state_dict(model, models_dir)
    # The released checkpoints predate the per-layer module names.
    for i in range(matcher.conf.n_layers):
        state = {k.replace(f"self_attn.{i}", f"transformers.{i}.self_attn"): v for k, v in state.items()}
        state = {k.replace(f"cross_attn.{i}", f"transformers.{i}.cross_attn"): v for k, v in state.items()}
    _load(matcher, state, derived=("confidence_thresholds",))
    return matcher.eval().to(device)


class LearnedFeatures:
    """One learned feature set, loaded from the pinned weights in ``models_dir``."""

    def __init__(self, name: str, models_dir: Path, device: torch.device) -> None:
        from kornia.feature import ALIKED

        if name not in LEARNED_SETS:
            raise ValueError(f"unknown learned feature set {name!r}")
        self.name = name
        self.device = device
        self.aliked = ALIKED("aliked-n16", max_num_keypoints=CANDIDATES, detection_threshold=-1)
        _load(self.aliked, _state_dict(ALIKED_MODEL, models_dir), derived=("dkd.hw_grid",))
        self.aliked.eval().to(device)
        self.raco = None
        if name == "raco":
            from ..vendor.raco import RaCo

            self.raco = RaCo(max_num_keypoints=CANDIDATES)
            _load(self.raco, _state_dict(RACO_MODEL, models_dir))
            self.raco.eval().to(device)
        self.matcher = _lightglue(RACO_LIGHTGLUE_MODEL if name == "raco" else ALIKED_LIGHTGLUE_MODEL, models_dir, device)

    @torch.inference_mode()
    def extract(self, image_path: Path, mask_path: Path) -> FrameFeatures:
        bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if bgr is None or mask is None:
            raise FileNotFoundError("frame or mask missing from scratch")
        h, w = bgr.shape[:2]
        if mask.shape != (h, w):
            raise ValueError("the mask does not match the frame")
        scale = min(1.0, LONG_EDGE / max(w, h))
        small = bgr if scale == 1.0 else cv2.resize(bgr, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        sh, sw = small.shape[:2]
        image = torch.from_numpy(cv2.cvtColor(small, cv2.COLOR_BGR2RGB)).to(self.device).permute(2, 0, 1)[None].float() / 255.0
        to_full = np.array([w / sw, h / sh], dtype=np.float32)

        if self.raco is None:
            found = self.aliked(image)[0]
            # ALIKED places pixel centres on integers; COLMAP puts them at +0.5.
            points = found.keypoints.cpu().numpy() + 0.5
            score = found.keypoint_scores.cpu().numpy()
            descriptors = found.descriptors
        else:
            found = self.raco({"image": image})
            points = found["keypoints"][0].cpu().numpy()  # already corner-based
            score = found["ranker_scores"][0].cpu().numpy()
            descriptors = None

        full = points * to_full
        keep = np.flatnonzero(trusted(full, mask))
        keep = keep[np.argsort(-score[keep], kind="stable")[:KEYPOINTS]]
        if descriptors is None:
            # Described as upstream's ALIKED.describe does for RaCo's keypoints.
            feature_map, _ = self.aliked.extract_dense_map(image)
            wh = torch.tensor([sw - 1, sh - 1], device=self.device, dtype=torch.float32)
            normalised = 2.0 * torch.from_numpy(points[keep]).to(self.device) / wh - 1.0
            descriptors = self.aliked.desc_head(feature_map, [normalised])[0][0]
        else:
            descriptors = descriptors[torch.from_numpy(keep).to(descriptors.device)]
        return FrameFeatures(keypoints=full[keep].astype(np.float32), descriptors=descriptors.half().cpu(), size=(w, h))

    @torch.inference_mode()
    def match(self, a: FrameFeatures, b: FrameFeatures) -> np.ndarray:
        """Index pairs (K, 2) into ``a.keypoints`` and ``b.keypoints``."""
        if not len(a.keypoints) or not len(b.keypoints):
            return np.zeros((0, 2), dtype=np.uint32)

        def side(f: FrameFeatures) -> dict:
            return {
                "keypoints": torch.from_numpy(f.keypoints).to(self.device)[None],
                "descriptors": f.descriptors.to(self.device).float()[None],
                "image_size": torch.tensor([f.size], device=self.device, dtype=torch.float32),
            }

        out = self.matcher({"image0": side(a), "image1": side(b)})
        return out["matches"][0].cpu().numpy().astype(np.uint32)
