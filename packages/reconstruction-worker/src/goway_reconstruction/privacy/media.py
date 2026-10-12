"""Decoding contributed media into upright sRGB frames.

Nothing here keeps metadata. A photo is decoded (JPEG, PNG, HEIC/HEIF),
rotated by its EXIF orientation, converted from its embedded colour profile to
sRGB and handed on as pixels; a video is decoded into a bounded set of sharp
keyframes spread over its whole length, each converted to sRGB according to the
colour signalling of the stream (matrix, range, primaries, transfer), HDR
tone-mapped. Whatever GPS, device, software or colour tags the original carried
stay in the original, which the backend deletes on its own schedule — a
derivative is plain sRGB pixels, which is what every later stage assumes.
"""

from __future__ import annotations

import io
import logging
import math
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pillow_heif
from PIL import Image, ImageCms, ImageOps

from ..contract import KeyframePolicy

log = logging.getLogger("goway.worker")

Image.MAX_IMAGE_PIXELS = 80_000_000  # refuse decompression bombs, allow 8K photos
# HEIC/HEIF, which the backend accepts because it is what an iPhone produces.
# libheif applies the container's rotation and mirroring itself and resets the
# EXIF orientation, so ``exif_transpose`` below does not turn it twice.
pillow_heif.register_heif_opener()

_SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))

# A sharpness score is computed on a grey image no larger than this.
_SCORE_LONG_EDGE = 1024


class CorruptMediaError(ValueError):
    """The media cannot be decoded into usable frames."""


@dataclass
class DecodedFrame:
    rgb: np.ndarray
    timestamp_seconds: float | None
    sharpness: float


def _grey_sharpness(grey: np.ndarray) -> float:
    scale = _SCORE_LONG_EDGE / max(grey.shape)
    if scale < 1:
        grey = cv2.resize(grey, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def sharpness(rgb: np.ndarray) -> float:
    """Variance of the Laplacian on a bounded grey image — a blur score."""
    return _grey_sharpness(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY))


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


def _fitted_size(width: int, height: int, long_edge: int) -> tuple[int, int]:
    scale = long_edge / max(width, height)
    if scale >= 1:
        return width, height
    return round(width * scale), round(height * scale)


def _fit(rgb: np.ndarray, long_edge: int) -> np.ndarray:
    h, w = rgb.shape[:2]
    size = _fitted_size(w, h, long_edge)
    if size == (w, h):
        return rgb
    return cv2.resize(rgb, size, interpolation=cv2.INTER_AREA)


# ── Photos ─────────────────────────────────────────────────────────────────


def to_srgb(image: Image.Image) -> Image.Image:
    """``image`` as RGB pixels in sRGB, converted through its embedded ICC profile.

    A phone photo is usually Display P3; read as sRGB it looks dull. A profile
    that cannot be used is ignored (the pixels are taken as sRGB, as most
    viewers would) — colour is a quality matter, not a privacy one.
    """
    icc = image.info.get("icc_profile")
    if icc:
        try:
            source = image if image.mode in ("RGB", "CMYK", "L") else image.convert("L" if image.mode in ("LA", "I", "I;16") else "RGB")
            return ImageCms.profileToProfile(
                source,
                ImageCms.ImageCmsProfile(io.BytesIO(icc)),
                _SRGB,
                renderingIntent=ImageCms.Intent.PERCEPTUAL,
                outputMode="RGB",
            )
        except (ImageCms.PyCMSError, OSError, ValueError, TypeError) as error:
            log.warning("embedded colour profile not applied (%s); pixels taken as sRGB", type(error).__name__)
    return image.convert("RGB")


def decode_photo(path: Path, policy: KeyframePolicy, *, long_edge: int | None = None) -> list[DecodedFrame]:
    """``long_edge`` overrides the policy's bound (a panorama is cut into views afterwards)."""
    try:
        with Image.open(path) as image:
            rgb = np.asarray(to_srgb(ImageOps.exif_transpose(image)))
    except Exception as error:  # noqa: BLE001 - any decoder failure is corrupt media
        raise CorruptMediaError("photo could not be decoded") from error
    rgb = _fit(rgb, long_edge or policy.maxLongEdgePixels)
    if min(rgb.shape[:2]) < 256:
        raise CorruptMediaError("photo is too small")
    return [DecodedFrame(rgb=np.ascontiguousarray(rgb), timestamp_seconds=None, sharpness=sharpness(rgb))]


# ── Video colour ───────────────────────────────────────────────────────────

# FFmpeg's AVColorSpace (what a decoded frame reports) → libswscale's SWS_CS_*
# (what the converter takes). They differ for SMPTE 170M.
_SWS_MATRIX = {1: 1, 4: 4, 5: 5, 6: 5, 7: 7, 9: 9, 10: 9}
_UNSPECIFIED = (0, 2, 3)
_RANGE_MPEG, _RANGE_JPEG = 1, 2
_TRC_PQ, _TRC_HLG = 16, 18
_PRIMARIES_BT2020, _PRIMARIES_P3_D65 = 9, 12

# Linear RGB → linear BT.709/sRGB primaries (D65 throughout).
_TO_BT709 = {
    _PRIMARIES_BT2020: np.array(
        [[1.660491, -0.587641, -0.072850], [-0.124550, 1.132900, -0.008349], [-0.018151, -0.100579, 1.118730]], dtype=np.float32
    ),
    _PRIMARIES_P3_D65: np.array(
        [[1.224940, -0.224940, 0.0], [-0.042057, 1.042057, 0.0], [-0.019638, -0.078636, 1.098274]], dtype=np.float32
    ),
}

# HDR → SDR. Reference (diffuse) white is 203 cd/m² (ITU-R BT.2408), which
# becomes SDR white. Below ``_KNEE`` of it light passes unchanged; above, it
# rolls off smoothly (C1 at the knee) towards 1.0, applied to the brightest
# channel so hue and saturation survive.
_HDR_REFERENCE_WHITE_NITS = 203.0
_HLG_PEAK_NITS = 1000.0
_KNEE = 0.75
_FLOAT_ROWS = 256


def pq_to_nits(signal: np.ndarray) -> np.ndarray:
    """SMPTE ST 2084 EOTF: PQ signal in [0, 1] → display light, cd/m²."""
    m1, m2 = 2610 / 16384, 2523 / 4096 * 128
    c1, c2, c3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
    p = np.power(np.clip(signal, 0, 1), 1 / m2)
    return 10000.0 * np.power(np.maximum(p - c1, 0) / (c2 - c3 * p), 1 / m1)


def hlg_to_nits(signal: np.ndarray, peak: float = _HLG_PEAK_NITS) -> np.ndarray:
    """ITU-R BT.2100 HLG: inverse OETF, then the OOTF for a ``peak`` display. ``signal`` is BT.2020 RGB, HxWx3."""
    a, b, c = 0.17883277, 0.28466892, 0.55991073
    e = np.clip(signal, 0, 1)
    scene = np.where(e <= 0.5, e * e / 3, (np.exp((e - c) / a) + b) / 12)
    gamma = 1.2 + 0.42 * math.log10(peak / 1000.0)
    luminance = scene @ np.array([0.2627, 0.6780, 0.0593], dtype=np.float32)
    return peak * np.power(np.maximum(luminance, 1e-6), gamma - 1)[..., None] * scene


def tone_map(relative: np.ndarray) -> np.ndarray:
    """Linear light relative to reference white (1.0) → [0, 1], rolling highlights off."""
    peak = relative.max(axis=-1, keepdims=True)
    over = np.maximum(peak - _KNEE, 0)
    mapped = np.where(peak > _KNEE, _KNEE + (1 - _KNEE) * (1 - np.exp(-over / (1 - _KNEE))), peak)
    return relative * (mapped / np.maximum(peak, 1e-6))


def srgb_encode(linear: np.ndarray) -> np.ndarray:
    """Linear [0, 1] → 8-bit sRGB (IEC 61966-2-1)."""
    x = np.clip(linear, 0, 1)
    encoded = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    return (encoded * 255 + 0.5).astype(np.uint8)


def hdr_to_srgb(signal: np.ndarray, transfer: int, primaries: int) -> np.ndarray:
    """HDR RGB signal (HxWx3 in [0, 1]) → 8-bit sRGB."""
    nits = pq_to_nits(signal) if transfer == _TRC_PQ else hlg_to_nits(signal)
    linear = (nits / _HDR_REFERENCE_WHITE_NITS).astype(np.float32)
    matrix = _TO_BT709.get(primaries, _TO_BT709[_PRIMARIES_BT2020])  # HDR without primaries is BT.2020
    linear = np.maximum(linear @ matrix.T, 0)
    return srgb_encode(tone_map(linear))


def frame_rgb(frame, long_edge: int) -> np.ndarray:  # noqa: ANN001 - av.VideoFrame
    """A decoded video frame as 8-bit sRGB, at most ``long_edge`` on its long side.

    Scaling and colour conversion are one libswscale pass. The YUV matrix and
    range come from the stream; an unsignalled matrix is BT.709 for HD and
    larger, BT.601 below (FFmpeg's own default is BT.601 everywhere, which
    shifts the colours of every HD phone video). HDR (PQ, HLG) is decoded at
    16 bits and tone-mapped; wide-gamut SDR is brought into sRGB primaries.
    """
    from av.video.reformatter import Interpolation

    width, height = _fitted_size(frame.width, frame.height, long_edge)
    matrix = _SWS_MATRIX.get(frame.colorspace) if frame.colorspace not in _UNSPECIFIED else None
    if matrix is None:
        matrix = 1 if max(frame.width, frame.height) >= 1280 else 5
    source_range = frame.color_range if frame.color_range in (_RANGE_MPEG, _RANGE_JPEG) else _RANGE_MPEG
    # Full-resolution chroma interpolation and accurate rounding: without them
    # libswscale is several levels off on flat colour.
    scaler = Interpolation.AREA if (width, height) != (frame.width, frame.height) else Interpolation.BILINEAR
    interpolation = scaler | Interpolation.ACCURATE_RND | Interpolation.FULL_CHR_H_INT
    transfer, primaries = frame.color_trc, frame.color_primaries
    wide = transfer in (_TRC_PQ, _TRC_HLG) or primaries in _TO_BT709
    converted = frame.reformat(
        width=width,
        height=height,
        format="rgb48le" if wide else "rgb24",
        src_colorspace=matrix,
        dst_colorspace=matrix,
        src_color_range=source_range,
        dst_color_range=_RANGE_JPEG,
        interpolation=interpolation,
    ).to_ndarray()
    if not wide:
        return converted
    out = np.empty(converted.shape, dtype=np.uint8)
    # In bands of rows: float copies of a whole 8K frame would cost gigabytes.
    for top in range(0, converted.shape[0], _FLOAT_ROWS):
        signal = converted[top : top + _FLOAT_ROWS].astype(np.float32) / 65535.0
        if transfer in (_TRC_PQ, _TRC_HLG):
            out[top : top + _FLOAT_ROWS] = hdr_to_srgb(signal, transfer, primaries)
        else:
            # Wide-gamut SDR: BT.1886 display light, into BT.709 primaries, back to signal.
            linear = np.maximum(np.power(signal, 2.4) @ _TO_BT709[primaries].T, 0)
            out[top : top + _FLOAT_ROWS] = (np.power(np.clip(linear, 0, 1), 1 / 2.4) * 255 + 0.5).astype(np.uint8)
    return out


# ── Video keyframes ────────────────────────────────────────────────────────


def choose_keyframes(scored: list[tuple[float, float]], policy: KeyframePolicy) -> list[tuple[float, float]]:
    """The sharpest frame of each window, the windows tiling the WHOLE recording.

    ``scored`` is every decoded frame's (time, sharpness). The budget grows with
    the length — one keyframe per ``minIntervalSeconds`` — up to
    ``maxFrames``; a longer recording gets proportionally wider windows rather
    than losing its end. Returned in time order.
    """
    if not scored:
        return []
    start, end = min(t for t, _ in scored), max(t for t, _ in scored)
    span = end - start
    budget = max(1, min(policy.maxFrames, int(span / policy.minIntervalSeconds) + 1))
    window = span / budget
    best: dict[int, tuple[float, float]] = {}
    for t, score in scored:
        k = min(budget - 1, int((t - start) / window)) if window > 0 else 0
        if k not in best or score > best[k][1]:
            best[k] = (t, score)
    return [best[k] for k in sorted(best)]


def plan_video_keyframes(path: Path, policy: KeyframePolicy) -> list[tuple[float, float]]:
    """First pass: score every frame on a small grey image, then choose. Returns (time, sharpness)."""
    import av

    scored: list[tuple[float, float]] = []
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            for frame in container.decode(stream):
                if frame.time is None:
                    continue
                scored.append((round(float(frame.time), 6), _grey_sharpness(frame.to_ndarray(format="gray"))))
    except Exception as error:  # noqa: BLE001
        raise CorruptMediaError("video could not be decoded") from error
    if not scored:
        raise CorruptMediaError("video has no decodable frames")
    return choose_keyframes(scored, policy)


def decode_video_keyframes(path: Path, picks: list[tuple[float, float]], *, long_edge: int) -> Iterator[DecodedFrame]:
    """Second pass: decode the chosen frames again and yield them one at a time.

    Streamed, so a long recording's keyframes (or an 8K panorama's) are never
    held all at once.
    """
    import av

    wanted = dict(picks)
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
                rgb = upright(frame_rgb(frame, long_edge), getattr(frame, "rotation", 0) or 0)
                yield DecodedFrame(rgb=np.ascontiguousarray(rgb), timestamp_seconds=key, sharpness=wanted.pop(key))
                if not wanted:
                    break
    except CorruptMediaError:
        raise
    except Exception as error:  # noqa: BLE001
        raise CorruptMediaError("video could not be decoded") from error
    if wanted:
        # A second decode that does not reproduce the first is not a file to trust.
        raise CorruptMediaError("video keyframes could not be decoded again")
