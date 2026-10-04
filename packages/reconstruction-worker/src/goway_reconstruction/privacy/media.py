"""Decoding contributed media into upright RGB frames.

Nothing here keeps metadata. A photo is decoded, rotated by its EXIF
orientation and handed on as pixels; a video is decoded into a bounded set of
sharp keyframes. Whatever GPS, device or software tags the original carried stay
in the original, which the backend deletes on its own schedule.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

from ..contract import KeyframePolicy

Image.MAX_IMAGE_PIXELS = 80_000_000  # refuse decompression bombs, allow 8K photos


class CorruptMediaError(ValueError):
    """The media cannot be decoded into usable frames."""


@dataclass
class DecodedFrame:
    rgb: np.ndarray
    timestamp_seconds: float | None
    sharpness: float


def sharpness(rgb: np.ndarray) -> float:
    """Variance of the Laplacian on a bounded grey image — a blur score."""
    grey = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    scale = 1024 / max(grey.shape)
    if scale < 1:
        grey = cv2.resize(grey, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def _fit(rgb: np.ndarray, long_edge: int) -> np.ndarray:
    h, w = rgb.shape[:2]
    scale = long_edge / max(h, w)
    if scale >= 1:
        return rgb
    return cv2.resize(rgb, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


def decode_photo(path: Path, policy: KeyframePolicy) -> list[DecodedFrame]:
    try:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            rgb = np.asarray(image)
    except Exception as error:  # noqa: BLE001 - any decoder failure is corrupt media
        raise CorruptMediaError("photo could not be decoded") from error
    rgb = _fit(rgb, policy.maxLongEdgePixels)
    if min(rgb.shape[:2]) < 256:
        raise CorruptMediaError("photo is too small")
    return [DecodedFrame(rgb=np.ascontiguousarray(rgb), timestamp_seconds=None, sharpness=sharpness(rgb))]


def decode_video(path: Path, policy: KeyframePolicy) -> list[DecodedFrame]:
    """Pick the sharpest frame in each ``minIntervalSeconds`` window, bounded."""
    import av

    best: dict[int, DecodedFrame] = {}
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            for frame in container.decode(stream):
                if frame.time is None:
                    continue
                window = int(frame.time / policy.minIntervalSeconds)
                if len(best) >= policy.maxFrames and window not in best:
                    break
                rgb = frame.to_ndarray(format="rgb24")
                rotation = getattr(frame, "rotation", 0) or 0
                if rotation % 360:
                    rgb = np.ascontiguousarray(np.rot90(rgb, k=(-rotation // 90) % 4))
                rgb = _fit(rgb, policy.maxLongEdgePixels)
                score = sharpness(rgb)
                current = best.get(window)
                if current is None or score > current.sharpness:
                    best[window] = DecodedFrame(rgb=rgb, timestamp_seconds=float(frame.time), sharpness=score)
    except Exception as error:  # noqa: BLE001
        raise CorruptMediaError("video could not be decoded") from error
    if not best:
        raise CorruptMediaError("video has no decodable frames")
    return [best[k] for k in sorted(best)][: policy.maxFrames]
