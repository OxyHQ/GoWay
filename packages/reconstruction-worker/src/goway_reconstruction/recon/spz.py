"""SPZ encoding and decoding for Gaussian scenes.

SPZ (Niantic Labs, MIT) is a compact, gzip-wrapped quantized layout that web
renderers load directly — roughly a tenth of a PLY. This is an independent
implementation of the documented legacy (gzip, 16-byte header) layout, written
from the reference ``load-spz.cc`` so the worker does not carry a C++ build.

Values are stored as they are in GoWay scene space (metric ENU, z up); no axis
conversion happens here. The public manifest's ``worldTransform`` says what the
frame is, and the viewer does the conversion for its own renderer.

``decode`` exists for the publication gate: a scene is only published after its
own compressed bytes have been decoded and rendered back.
"""

from __future__ import annotations

import gzip
import struct
from dataclasses import dataclass

import numpy as np

MAGIC = 0x5053474E
VERSION = 3
FRACTIONAL_BITS = 12
COLOR_SCALE = 0.15
SH1_BITS = 5
SH_REST_BITS = 4
_SQRT1_2 = np.float32(np.sqrt(0.5))


@dataclass
class GaussianCloud:
    """Gaussians in GoWay scene space, as the trainer represents them.

    ``quats`` are (w, x, y, z); ``scales`` are log-scales; ``opacities`` are
    logits; ``sh0`` is the DC coefficient (N, 3); ``shN`` the higher bands
    (N, K, 3) coefficient-major.
    """

    means: np.ndarray
    quats: np.ndarray
    scales: np.ndarray
    opacities: np.ndarray
    sh0: np.ndarray
    shN: np.ndarray

    @property
    def count(self) -> int:
        return int(self.means.shape[0])

    @property
    def sh_degree(self) -> int:
        k = self.shN.shape[1] if self.shN.ndim == 3 else 0
        return {0: 0, 3: 1, 8: 2, 15: 3}[k]


def _u8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x), 0, 255).astype(np.uint8)


def _quantize_sh(x: np.ndarray, bucket: int) -> np.ndarray:
    q = np.round(x * 128.0) + 128.0
    q = np.floor((q + bucket // 2) / bucket) * bucket
    return np.clip(q, 0, 255).astype(np.uint8)


def _pack_quats_smallest_three(quats_wxyz: np.ndarray) -> np.ndarray:
    q = quats_wxyz[:, [1, 2, 3, 0]].astype(np.float32)  # xyzw, as the reference stores it
    q /= np.linalg.norm(q, axis=1, keepdims=True).clip(min=1e-12)
    largest = np.argmax(np.abs(q), axis=1)
    negate = q[np.arange(len(q)), largest] < 0
    comp = largest.astype(np.uint32)
    for i in range(4):
        use = largest != i
        negbit = ((q[:, i] < 0) ^ negate).astype(np.uint32)
        mag = (np.float32(511) * (np.abs(q[:, i]) / _SQRT1_2) + 0.5).astype(np.uint32)
        comp = np.where(use, (comp << 10) | (negbit << 9) | mag, comp)
    return comp.astype("<u4").view(np.uint8).reshape(-1, 4)


def _unpack_quats_smallest_three(packed: np.ndarray) -> np.ndarray:
    comp = packed.reshape(-1, 4).copy().view("<u4").reshape(-1).astype(np.uint32)
    largest = comp >> 30
    out = np.zeros((len(comp), 4), dtype=np.float32)
    sum_sq = np.zeros(len(comp), dtype=np.float32)
    for i in (3, 2, 1, 0):
        use = largest != i
        mag = (comp & 511).astype(np.float32)
        neg = (comp >> 9) & 1
        val = _SQRT1_2 * mag / 511.0
        val = np.where(neg == 1, -val, val)
        out[:, i] = np.where(use, val, out[:, i])
        sum_sq += np.where(use, val * val, 0)
        comp = np.where(use, comp >> 10, comp)
    idx = np.arange(len(out))
    out[idx, largest] = np.sqrt(np.clip(1.0 - sum_sq, 0, 1))
    return out[:, [3, 0, 1, 2]]  # back to wxyz


def encode(cloud: GaussianCloud, *, antialiased: bool = True) -> bytes:
    n = cloud.count
    degree = cloud.sh_degree
    scale = float(1 << FRACTIONAL_BITS)
    fixed = np.round(cloud.means.astype(np.float64) * scale).astype(np.int64)
    if np.abs(fixed).max(initial=0) >= (1 << 23):
        raise ValueError("scene extends beyond the 24-bit fixed-point range")
    fixed32 = fixed.astype(np.int32).reshape(-1)
    positions = np.stack([(fixed32 >> s) & 0xFF for s in (0, 8, 16)], axis=1).astype(np.uint8).reshape(-1)

    alphas = _u8(1.0 / (1.0 + np.exp(-cloud.opacities.astype(np.float64))) * 255.0)
    colors = _u8(cloud.sh0.reshape(-1).astype(np.float64) * (COLOR_SCALE * 255.0) + 0.5 * 255.0)
    scales = _u8((cloud.scales.reshape(-1).astype(np.float64) + 10.0) * 16.0)
    rotations = _pack_quats_smallest_three(cloud.quats).reshape(-1)

    parts = [
        struct.pack("<IIIBBBB", MAGIC, VERSION, n, degree, FRACTIONAL_BITS, 1 if antialiased else 0, 0),
        positions.tobytes(),
        alphas.tobytes(),
        colors.tobytes(),
        scales.tobytes(),
        rotations.tobytes(),
    ]
    if degree > 0:
        sh = cloud.shN.reshape(n, -1).astype(np.float64)  # (N, K*3), coefficient-major
        out = np.empty(sh.shape, dtype=np.uint8)
        out[:, :9] = _quantize_sh(sh[:, :9], 1 << (8 - SH1_BITS))
        out[:, 9:] = _quantize_sh(sh[:, 9:], 1 << (8 - SH_REST_BITS))
        parts.append(out.tobytes())
    return gzip.compress(b"".join(parts), compresslevel=9, mtime=0)


def decode(data: bytes) -> GaussianCloud:
    raw = gzip.decompress(data)
    magic, version, n, degree, frac, _flags, _ = struct.unpack_from("<IIIBBBB", raw, 0)
    if magic != MAGIC or version not in (2, 3):
        raise ValueError("not a supported SPZ payload")
    off = 16

    def take(count: int) -> np.ndarray:
        nonlocal off
        chunk = np.frombuffer(raw, dtype=np.uint8, count=count, offset=off)
        off += count
        return chunk

    pos = take(n * 9).reshape(-1, 3).astype(np.int32)
    fixed = pos[:, 0] | (pos[:, 1] << 8) | (pos[:, 2] << 16)
    fixed = np.where(fixed & 0x800000, fixed | ~0xFFFFFF, fixed)
    means = fixed.reshape(n, 3).astype(np.float32) / float(1 << frac)
    alphas = take(n).astype(np.float32) / 255.0
    opacities = np.log(np.clip(alphas, 1e-6, 1 - 1e-6) / (1 - np.clip(alphas, 1e-6, 1 - 1e-6)))
    sh0 = ((take(n * 3).astype(np.float32) / 255.0) - 0.5).reshape(n, 3) / COLOR_SCALE
    scales = (take(n * 3).astype(np.float32) / 16.0 - 10.0).reshape(n, 3)
    if version >= 3:
        quats = _unpack_quats_smallest_three(take(n * 4))
    else:
        xyz = take(n * 3).reshape(n, 3).astype(np.float32) / 127.5 - 1.0
        w = np.sqrt(np.clip(1.0 - (xyz * xyz).sum(1), 0, 1))
        quats = np.concatenate([w[:, None], xyz], axis=1)
    k = {0: 0, 1: 3, 2: 8, 3: 15}[degree]
    shN = ((take(n * k * 3).astype(np.float32) - 128.0) / 128.0).reshape(n, k, 3) if k else np.zeros((n, 0, 3), np.float32)
    return GaussianCloud(means=means, quats=quats, scales=scales, opacities=opacities, sh0=sh0, shN=shN)
