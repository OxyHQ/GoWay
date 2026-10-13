"""Pinned model weights.

Every model the worker runs is named here with the exact bytes it must be. A
download is verified against the SHA-256 before it is ever loaded, and a cached
file that no longer matches is refused rather than used: a privacy detector that
silently changed is a privacy gate nobody reviewed. LICENSES.md records the
licence of each one, separately from the licence of the code that runs it.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class PinnedModel:
    name: str
    version: str
    filename: str
    url: str
    sha256: str


FACE_DETECTOR = PinnedModel(
    name="face-yunet",
    version="2023mar",
    filename="face_detection_yunet_2023mar.onnx",
    url="https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    sha256="8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
)

PLATE_DETECTOR = PinnedModel(
    name="plate-lpd-yunet",
    version="2023mar",
    filename="license_plate_detection_lpd_yunet_2023mar.onnx",
    url="https://github.com/opencv/opencv_zoo/raw/main/models/license_plate_detection_yunet/license_plate_detection_lpd_yunet_2023mar.onnx",
    sha256="6d4978a7b6d25514d5e24811b82bfb511d166bdd8ca3b03aa63c1623d4d039c7",
)

INSTANCE_SEGMENTER = PinnedModel(
    name="people-vehicles-maskrcnn",
    version="torchvision-maskrcnn_resnet50_fpn_v2-coco",
    filename="maskrcnn_resnet50_fpn_v2_coco-73cbd019.pth",
    url="https://download.pytorch.org/models/maskrcnn_resnet50_fpn_v2_coco-73cbd019.pth",
    sha256="73cbd0190fcbe3ba339921fbce2c3a0b6bb9126c9a133c85e43a2a8e060a109e",
)

_DEPTH_REVISION = "5426e4f0f36572d16453bbda7a8389317b1bef99"
_DEPTH_BASE = f"https://huggingface.co/depth-anything/Depth-Anything-V2-Small-hf/resolve/{_DEPTH_REVISION}"

# Depth Anything V2 SMALL only: it is Apache-2.0. The Base and Large
# checkpoints are CC-BY-NC-4.0 and must not be used (see LICENSES.md).
DEPTH_MODEL_FILES = (
    PinnedModel(
        name="depth-anything-v2-small",
        version=_DEPTH_REVISION[:12],
        filename="depth-anything-v2-small/config.json",
        url=f"{_DEPTH_BASE}/config.json",
        sha256="c56698d3643dde1f83ea2212759e6b31a22b8f827246a36dd007ee8a22b3ff75",
    ),
    PinnedModel(
        name="depth-anything-v2-small",
        version=_DEPTH_REVISION[:12],
        filename="depth-anything-v2-small/preprocessor_config.json",
        url=f"{_DEPTH_BASE}/preprocessor_config.json",
        sha256="d41175c0d889477ca8fc67191e540faef14baf6275157b3fdecf78469e6bbf84",
    ),
    PinnedModel(
        name="depth-anything-v2-small",
        version=_DEPTH_REVISION[:12],
        filename="depth-anything-v2-small/model.safetensors",
        url=f"{_DEPTH_BASE}/model.safetensors",
        sha256="3152477ce0d8d6978d76b995120de97cb5b928701fd0f817769f59e249a16b70",
    ),
)

DENSE_DEPTH_REVISION = "f4a6c9b3c95e41c82048423d3493a81ec3fa810e"
_DENSE_DEPTH_BASE = f"https://huggingface.co/depth-anything/DA3-BASE/resolve/{DENSE_DEPTH_REVISION}"

# Depth Anything 3 BASE: pose-conditioned multi-view depth for the dense
# initial point cloud (recon/dense.py), run by the vendored model code. Only
# DA3-SMALL, DA3-BASE, DA3METRIC-LARGE and DA3MONO-LARGE are Apache-2.0; the
# LARGE, GIANT and NESTED checkpoints are CC-BY-NC-4.0 and must never be used
# (see LICENSES.md).
DENSE_DEPTH_MODEL_FILES = (
    PinnedModel(
        name="depth-anything-3-base",
        version=DENSE_DEPTH_REVISION[:12],
        filename="da3-base/config.json",
        url=f"{_DENSE_DEPTH_BASE}/config.json",
        sha256="5e34115ebc17bd2d8d43033c5f72e9446ac8833fd61d3fa160b7e67e0bb5b7b5",
    ),
    PinnedModel(
        name="depth-anything-3-base",
        version=DENSE_DEPTH_REVISION[:12],
        filename="da3-base/model.safetensors",
        url=f"{_DENSE_DEPTH_BASE}/model.safetensors",
        sha256="e01067dc1659613083d9145a9a2547ccdbe6ccbbf83c4fe7b3e8a4e2bdae78b5",
    ),
)

_ALIKED_COMMIT = "683d7c65197395c0b3f01ebe76e1084a27e73a65"
_LIGHTGLUE_RELEASE = "https://github.com/cvg/LightGlue/releases/download/v0.1_arxiv"

# Learned features for the camera solve (recon/features.py). ALIKED-n16 is the
# descriptor both LightGlue checkpoints were trained on; RaCo only detects.
ALIKED_MODEL = PinnedModel(
    name="aliked-n16",
    version=_ALIKED_COMMIT[:12],
    filename="features/aliked-n16.pth",
    url=f"https://github.com/Shiaoming/ALIKED/raw/{_ALIKED_COMMIT}/models/aliked-n16.pth",
    sha256="5be8704840ed662d9d8c561bf7279c222092674e7eb05fd0feab94899e9d82f2",
)

ALIKED_LIGHTGLUE_MODEL = PinnedModel(
    name="lightglue-aliked",
    version="v0.1_arxiv",
    filename="features/aliked_lightglue.pth",
    url=f"{_LIGHTGLUE_RELEASE}/aliked_lightglue.pth",
    sha256="d975e965b105311a6143194852297dff4f02aea5cc2e10cecfed966ca0e22503",
)

RACO_MODEL = PinnedModel(
    name="raco",
    version="v1.0.0",
    filename="features/raco.pth",
    url="https://github.com/cvg/RaCo/releases/download/v1.0.0/raco.pth",
    sha256="79f0d862bb41abedd8dda33a9b0120f4dcd619c43a90398175bad1a019192e3a",
)

# "LightGlue+": LightGlue retrained on RaCo keypoints with ALIKED descriptors.
RACO_LIGHTGLUE_MODEL = PinnedModel(
    name="lightglue-raco-aliked",
    version="v0.1_arxiv",
    filename="features/raco_aliked_lightglue.pth",
    url=f"{_LIGHTGLUE_RELEASE}/raco_aliked_lightglue.pth",
    sha256="a804c3fe2851cc3c765cda6a9f412845893c8d8e2a3048f848d7f6ba172e6312",
)

FEATURE_MODELS = (ALIKED_MODEL, ALIKED_LIGHTGLUE_MODEL, RACO_MODEL, RACO_LIGHTGLUE_MODEL)
PRIVACY_MODELS = (FACE_DETECTOR, PLATE_DETECTOR, INSTANCE_SEGMENTER)
ALL_MODELS = (*PRIVACY_MODELS, *DEPTH_MODEL_FILES, *DENSE_DEPTH_MODEL_FILES, *FEATURE_MODELS)


class ModelIntegrityError(RuntimeError):
    """A model file is missing or is not the reviewed bytes."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_model(model: PinnedModel, models_dir: Path, *, download: bool = True) -> Path:
    """Return the verified local path of ``model``, downloading it if allowed."""
    path = models_dir / model.filename
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if sha256_file(path) == model.sha256:
            return path
        path.unlink()
    if not download:
        raise ModelIntegrityError(f"{model.name} is not installed")
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".download-")
    os.close(fd)
    try:
        urllib.request.urlretrieve(model.url, tmp)  # noqa: S310 - pinned https URL
        if sha256_file(Path(tmp)) != model.sha256:
            raise ModelIntegrityError(f"{model.name} download does not match its pinned digest")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path
