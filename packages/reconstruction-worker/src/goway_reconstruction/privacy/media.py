"""Decoding contributed media into upright RGB frames.

Nothing here keeps metadata. A photo is decoded, rotated by its EXIF
orientation and handed on as pixels; a video is decoded into a bounded set of
sharp keyframes. Whatever GPS, device or software tags the original carried stay
in the original, which the backend deletes on its own schedule.
"""

from __future__ import annotations

from collections.abc import Iterator
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


def upright(rgb: np.ndarray, rotation: int) -> np.ndarray:
    """Apply a video's display-matrix rotation.

    FFmpeg/PyAV report the angle counter-clockwise, and a NEGATIVE angle is the
    usual portrait phone video: ``-90`` means "turn 90° clockwise to display".
    ``np.rot90`` turns counter-clockwise for positive ``k``, so ``k`` is the
    angle over 90, taken modulo 4. Getting the sign wrong turns every frame
    upside down, which SfM happily reconstructs as an upside-down street.
    """
    k = (int(rotation) // 90) % 4
    return np.ascontiguousarray(np.rot90(rgb, k=k)) if k else rgb


def _fit(rgb: np.ndarray, long_edge: int) -> np.ndarray:
    h, w = rgb.shape[:2]
    scale = long_edge / max(h, w)
    if scale >= 1:
        return rgb
    return cv2.resize(rgb, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)


def decode_photo(path: Path, policy: KeyframePolicy, *, long_edge: int | None = None) -> list[DecodedFrame]:
    """``long_edge`` overrides the policy's bound (a panorama is cut into views afterwards)."""
    try:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            rgb = np.asarray(image)
    except Exception as error:  # noqa: BLE001 - any decoder failure is corrupt media
        raise CorruptMediaError("photo could not be decoded") from error
    rgb = _fit(rgb, long_edge or policy.maxLongEdgePixels)
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
                rgb = upright(rgb, getattr(frame, "rotation", 0) or 0)
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


def iter_video_keyframes(path: Path, policy: KeyframePolicy, *, long_edge: int) -> Iterator[DecodedFrame]:
    """The same keyframe choice as :func:`decode_video`, streamed.

    For large frames (a 360° video): holding the sharpest frame of every window
    at full size would hold gigabytes, so the first pass only scores frames and
    the second decodes again and yields the chosen ones one at a time.
    """
    import av

    chosen: dict[int, tuple[float, float]] = {}  # window -> (time, sharpness)
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            for frame in container.decode(stream):
                if frame.time is None:
                    continue
                window = int(frame.time / policy.minIntervalSeconds)
                if len(chosen) >= policy.maxFrames and window not in chosen:
                    break
                rgb = upright(frame.to_ndarray(format="rgb24"), getattr(frame, "rotation", 0) or 0)
                score = sharpness(_fit(rgb, policy.maxLongEdgePixels))
                if window not in chosen or score > chosen[window][1]:
                    chosen[window] = (float(frame.time), score)
    except Exception as error:  # noqa: BLE001
        raise CorruptMediaError("video could not be decoded") from error
    if not chosen:
        raise CorruptMediaError("video has no decodable frames")

    wanted = {round(t, 6): score for t, score in chosen.values()}
    produced = 0
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            for frame in container.decode(stream):
                if frame.time is None:
                    continue
                key = round(float(frame.time), 6)
                if key not in wanted:
                    continue
                rgb = upright(frame.to_ndarray(format="rgb24"), getattr(frame, "rotation", 0) or 0)
                produced += 1
                yield DecodedFrame(rgb=np.ascontiguousarray(_fit(rgb, long_edge)), timestamp_seconds=key, sharpness=wanted.pop(key))
                if not wanted:
                    break
    except CorruptMediaError:
        raise
    except Exception as error:  # noqa: BLE001
        raise CorruptMediaError("video could not be decoded") from error
    if wanted:
        # A second decode that does not reproduce the first is not a file to trust.
        raise CorruptMediaError("video keyframes could not be decoded again")
