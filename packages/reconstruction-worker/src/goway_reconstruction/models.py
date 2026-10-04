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

ALL_MODELS = (FACE_DETECTOR, PLATE_DETECTOR, INSTANCE_SEGMENTER)


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
    models_dir.mkdir(parents=True, exist_ok=True)
    path = models_dir / model.filename
    if path.exists():
        if sha256_file(path) == model.sha256:
            return path
        path.unlink()
    if not download:
        raise ModelIntegrityError(f"{model.name} is not installed")
    fd, tmp = tempfile.mkstemp(dir=models_dir, prefix=".download-")
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
