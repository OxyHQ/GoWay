"""Turning detections into a privacy-safe derivative and a training mask.

Two outputs per frame, with different jobs, and so two different regions:

- the DERIVATIVE is the only image any later stage reads. Every sensitive
  region is destroyed in it — downsampled to a coarse mosaic, then blurred —
  so nothing downstream can recover a face or a plate even by accident. The
  destroyed (BLUR) region is every face, every person's head, every detected
  plate, every person and vehicle within its instance outline (occupants
  behind glass included), and the plate band of every vehicle box: the lower
  part of the box where its plates sit, destroyed whether or not the plate
  detector saw one, because a plate the detector missed must still be
  unreadable.
- the MASK marks the pixels reconstruction may use (255) and the ones it must
  ignore (0). The EXCLUDE region is everything destroyed plus a margin — blur
  is meaningless texture, and a JPEG block carries it up to 7 px past its
  edge — so no person or vehicle becomes geometry or appearance in a scene and
  no smudge does either. The outlines get the margin they always had (their
  soft edges); detected boxes (faces, heads, plates, plate bands) get
  ``EXCLUSION_MARGIN_PIXELS``; a fixed region (a panorama's nadir) only the
  JPEG bleed. The rest of a vehicle's box — the road, the kerb, the shopfront
  behind it — stays usable.

Writing is fail-closed: the encoded JPEG is read back and refused if any
metadata block survived.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

from .detectors import FrameDetections

MOSAIC_FACTOR = 24
# The mosaic cell grows with the frame, so a face that fills a given share of
# the picture never gets more cells than in the coarsest mosaic the pipeline
# ever made (24 px cells on a 1280 px panorama view; photos were finer, 24 px
# at 2048): raising the resolution must not make a destroyed face any less
# destroyed.
MOSAIC_REFERENCE_LONG_EDGE = 1280
MAX_MASKED_FRACTION = 0.85
MIN_SHARPNESS = 12.0
# Full-resolution chroma, near-lossless: the derivative is resampled again by
# the solve and the trainer, and 4:2:0 at q92 smeared every edge it had.
JPEG_QUALITY = 95
JPEG_SUBSAMPLING = 0  # 4:4:4
# How far past a destroyed box the mask still excludes pixels: a JPEG block
# (8 px) of bleed, and room for a feature descriptor not to straddle the edge.
# Bleed is in derivative pixels, so it does not grow with the frame; the
# trainer's own downscaling is handled by its mask (recon/train.py).
EXCLUSION_MARGIN_PIXELS = 16
# The farthest a destroyed pixel's influence reaches in the encoded derivative.
JPEG_BLEED_PIXELS = 8
# Around person and vehicle outlines: their soft edges, never less than the bleed.
OUTLINE_MARGIN_FRACTION = 0.006  # of the frame diagonal
# The plate band: the lower part of a vehicle's box. Cars, vans, buses and
# lorries carry plates on their bumpers and tailgates, at most ~60% of the way
# up the box; a motorcycle's sits high on its tail, so a two-wheeler's band —
# and that of any vehicle whose kind is unknown — is its whole box. Widened so
# a box that clips the bumper still covers it.
PLATE_BAND_FRACTION = {3: 0.6, 6: 0.6, 7: 0.6, 8: 0.6}  # COCO car, bus, train, truck
PLATE_BAND_WIDEN = 0.05
# A person's head: the top of their box, as tall as the larger of a quarter of
# the box and most of its width (a seated, bent or partly hidden person's head
# is a larger share of a squarer box; a lying one's box is all head-height).
HEAD_HEIGHT_FRACTION = 0.25
HEAD_WIDTH_FRACTION = 0.6
HEAD_WIDEN = 0.15

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


def grow(region: np.ndarray, radius: int) -> np.ndarray:
    """``region`` widened by ``radius`` pixels in every direction (a disc, by distance transform)."""
    if not region.any():
        return region.copy()
    return cv2.distanceTransform((~region).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE) <= radius


def plate_band(box: tuple[int, int, int, int], label: int | None, w: int, h: int) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) of the part of a vehicle's box that may carry a plate."""
    x, y, bw, bh = box
    fraction = PLATE_BAND_FRACTION.get(label, 1.0) if label is not None else 1.0
    dx, dy = bw * PLATE_BAND_WIDEN, bh * PLATE_BAND_WIDEN
    top = y + bh * (1 - fraction) - (dy if fraction >= 1 else 0)
    return max(0, int(x - dx)), max(0, int(top)), min(w, int(np.ceil(x + bw + dx))), min(h, int(np.ceil(y + bh + dy)))


def head_region(box: tuple[int, int, int, int], w: int, h: int) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) of the top of a person's box, where the head is."""
    x, y, bw, bh = box
    head = min(bh, max(HEAD_HEIGHT_FRACTION * bh, HEAD_WIDTH_FRACTION * bw))
    dx = bw * HEAD_WIDEN
    return max(0, int(x - dx)), max(0, int(y - head * HEAD_WIDEN)), min(w, int(np.ceil(x + bw + dx))), min(h, int(np.ceil(y + head)))


def outline_margin(shape: tuple[int, int]) -> int:
    h, w = shape
    return max(JPEG_BLEED_PIXELS, int((h * h + w * w) ** 0.5 * OUTLINE_MARGIN_FRACTION))


def sensitive_regions(det: FrameDetections, shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Return (blur, exclude) boolean masks for a frame of ``shape`` (h, w). ``blur`` is inside ``exclude``."""
    h, w = shape
    outlines = det.people | det.vehicles

    boxes = np.zeros((h, w), dtype=bool)
    for box in det.faces:
        x0, y0, x1, y1 = _expand(box, 0.35, w, h)
        boxes[y0:y1, x0:x1] = True
    for box in det.plates:
        x0, y0, x1, y1 = _expand(box, 0.25, w, h)
        boxes[y0:y1, x0:x1] = True
    for box in det.person_boxes:
        x0, y0, x1, y1 = head_region(box, w, h)
        boxes[y0:y1, x0:x1] = True
    labels = det.vehicle_labels
    for i, box in enumerate(det.vehicle_boxes):
        x0, y0, x1, y1 = plate_band(box, labels[i] if i < len(labels) else None, w, h)
        boxes[y0:y1, x0:x1] = True

    blur = outlines | boxes
    exclude = grow(outlines, outline_margin(shape)) | grow(boxes, EXCLUSION_MARGIN_PIXELS)
    return blur, exclude


def mosaic_cell(h: int, w: int) -> int:
    return max(MOSAIC_FACTOR, math.ceil(MOSAIC_FACTOR * max(h, w) / MOSAIC_REFERENCE_LONG_EDGE))


def destroy(rgb: np.ndarray, region: np.ndarray) -> np.ndarray:
    """Irreversibly obscure ``region``: coarse mosaic, then a wide blur."""
    if not region.any():
        return rgb
    h, w = rgb.shape[:2]
    cell = mosaic_cell(h, w)
    small = cv2.resize(rgb, (max(1, w // cell), max(1, h // cell)), interpolation=cv2.INTER_AREA)
    mosaic = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
    mosaic = cv2.GaussianBlur(mosaic, (0, 0), sigmaX=cell / 2)
    out = rgb.copy()
    out[region] = mosaic[region]
    return out


def encode_clean_jpeg(rgb: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    # A fresh Image from raw pixels has no info dict; nothing is passed through.
    # Not ``optimize``: Pillow then holds the whole output in a 2·w·h buffer,
    # which a high-entropy frame at 4:4:4 q95 can overflow.
    Image.fromarray(rgb, mode="RGB").save(buffer, format="JPEG", quality=JPEG_QUALITY, subsampling=JPEG_SUBSAMPLING)
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


def redact(rgb: np.ndarray, det: FrameDetections, *, always: np.ndarray | None = None) -> RedactedFrame:
    """``always`` marks pixels destroyed and excluded whatever was detected (a panorama's nadir)."""
    h, w = rgb.shape[:2]
    blur, exclude = sensitive_regions(det, (h, w))
    if always is not None:
        if always.shape != (h, w):
            raise ValueError("the fixed mask does not match the frame")
        blur |= always
        exclude |= grow(always, JPEG_BLEED_PIXELS)
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
