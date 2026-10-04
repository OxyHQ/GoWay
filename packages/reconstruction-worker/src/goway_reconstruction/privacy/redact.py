"""Turning detections into a privacy-safe derivative and a training mask.

Two outputs per frame, with different jobs:

- the DERIVATIVE is the only image any later stage reads. Every sensitive
  region is destroyed in it — downsampled to a coarse mosaic, then blurred —
  so nothing downstream can recover a face or a plate even by accident.
- the MASK marks the pixels reconstruction may use (255) and the ones it must
  ignore (0). People and vehicles are excluded from features and from the
  training loss, so they never become geometry or appearance in a scene.

Writing is fail-closed: the encoded JPEG is read back and refused if any
metadata block survived.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

from .detectors import FrameDetections

MOSAIC_FACTOR = 24
MAX_MASKED_FRACTION = 0.85
MIN_SHARPNESS = 12.0
JPEG_QUALITY = 92

# Byte signatures of metadata blocks a JPEG can carry.
_METADATA_SIGNATURES = (b"Exif\x00\x00", b"http://ns.adobe.com/xap/", b"ICC_PROFILE", b"Photoshop 3.0", b"MPF\x00")


class MetadataSurvivedError(RuntimeError):
    """A derivative still carries a metadata block after re-encoding."""


@dataclass
class RedactedFrame:
    jpeg: bytes
    mask_png: bytes
    width: int
    height: int
    masked_fraction: float


def _expand(box: tuple[int, int, int, int], factor: float, w: int, h: int) -> tuple[int, int, int, int]:
    x, y, bw, bh = box
    dx, dy = bw * factor, bh * factor
    x0, y0 = max(0, int(x - dx)), max(0, int(y - dy))
    x1, y1 = min(w, int(x + bw + dx)), min(h, int(y + bh + dy))
    return x0, y0, x1, y1


def sensitive_regions(det: FrameDetections, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Return (blur, exclude) boolean masks for a frame of ``shape`` (h, w)."""
    h, w = shape
    diag = (h * h + w * w) ** 0.5
    radius = max(3, int(diag * 0.006))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))

    dynamic = (det.people | det.vehicles).astype(np.uint8)
    dynamic = cv2.dilate(dynamic, kernel).astype(bool)

    boxes = np.zeros((h, w), dtype=bool)
    for box in det.faces:
        x0, y0, x1, y1 = _expand(box, 0.35, w, h)
        boxes[y0:y1, x0:x1] = True
    for box in det.plates:
        x0, y0, x1, y1 = _expand(box, 0.25, w, h)
        boxes[y0:y1, x0:x1] = True
    # A vehicle's whole box, not only its pixel mask: a plate sits on the
    # bumper, exactly where a mask edge is least reliable.
    for box in det.vehicle_boxes:
        x0, y0, x1, y1 = _expand(box, 0.05, w, h)
        boxes[y0:y1, x0:x1] = True

    blur = dynamic | boxes
    exclude = blur.copy()
    return blur, exclude


def destroy(rgb: np.ndarray, region: np.ndarray) -> np.ndarray:
    """Irreversibly obscure ``region``: coarse mosaic, then a wide blur."""
    if not region.any():
        return rgb
    h, w = rgb.shape[:2]
    small = cv2.resize(rgb, (max(1, w // MOSAIC_FACTOR), max(1, h // MOSAIC_FACTOR)), interpolation=cv2.INTER_AREA)
    mosaic = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    mosaic = cv2.GaussianBlur(mosaic, (0, 0), sigmaX=MOSAIC_FACTOR / 2)
    out = rgb.copy()
    out[region] = mosaic[region]
    return out


def encode_clean_jpeg(rgb: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    # A fresh Image from raw pixels has no info dict; nothing is passed through.
    Image.fromarray(rgb, mode="RGB").save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    data = buffer.getvalue()
    assert_no_metadata(data)
    return data


def assert_no_metadata(jpeg: bytes) -> None:
    for signature in _METADATA_SIGNATURES:
        if signature in jpeg:
            raise MetadataSurvivedError("derivative carries a metadata block")
    with Image.open(io.BytesIO(jpeg)) as image:
        if image.getexif() or any(k in image.info for k in ("exif", "xmp", "icc_profile", "photoshop")):
            raise MetadataSurvivedError("derivative carries metadata")


def redact(rgb: np.ndarray, det: FrameDetections) -> RedactedFrame:
    h, w = rgb.shape[:2]
    blur, exclude = sensitive_regions(det, (h, w))
    safe = destroy(rgb, blur)
    mask = np.where(exclude, 0, 255).astype(np.uint8)
    ok, png = cv2.imencode(".png", mask)
    if not ok:
        raise RuntimeError("mask encoding failed")
    return RedactedFrame(
        jpeg=encode_clean_jpeg(safe),
        mask_png=png.tobytes(),
        width=w,
        height=h,
        masked_fraction=float(exclude.mean()),
    )
