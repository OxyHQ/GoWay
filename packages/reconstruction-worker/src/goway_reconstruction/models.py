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

PRIVACY_MODELS = (FACE_DETECTOR, PLATE_DETECTOR, INSTANCE_SEGMENTER)
ALL_MODELS = (*PRIVACY_MODELS, *DEPTH_MODEL_FILES)


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
