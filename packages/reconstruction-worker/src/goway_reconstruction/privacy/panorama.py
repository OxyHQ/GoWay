"""Cutting an equirectangular panorama into overlapping perspective views.

The privacy detectors and the camera solve both expect ordinary pinhole
images, so a 360° frame is never processed as one image. It is resampled into
two rings of views, each ``VIEW_FOV_DEGREES`` wide:

- ``HORIZON_VIEWS`` views at pitch 0 around the horizon, neighbours
  overlapping by half their width — a face on a view's edge is whole in the
  next view;
- ``UPPER_VIEWS`` views pitched ``UPPER_PITCH_DEGREES`` up, which see the
  upper storeys, roofs and eaves a horizon view cuts off (a 4:3 view at pitch
  0 reaches only ~37° up). They overlap the horizon ring by ~29° and each
  other by more than a third, so the solve can tie them in.

There is no downward ring: below the horizon ring's lower edge (~37° down)
lies almost only the nadir cap, which is destroyed anyway.

Every view is a separate privacy-safe derivative, detected, redacted and masked
on its own, and records which panorama it came from and where it looks, so the
solve can treat the views of one panorama as a rig.

A view is sized from the panorama's own resolution — one view pixel per
source pixel at the view's centre — so it neither invents detail nor throws it
away, and the views are resampled straight from the decoded panorama in one
remap. Only a panorama larger than ``PANORAMA_MAX_LONG_EDGE`` is first reduced
(area-averaged, so nothing aliases).

Conventions (shared with the solve through :func:`cam_from_pano`):

- camera axes are COLMAP's: x right, y down, z forward;
- the panorama's yaw 0 is the centre column of the equirectangular image, and
  yaw grows to the right (clockwise seen from above, like a compass heading);
- pitch grows upward; views are never rolled, so every view is upright.

The nadir — straight down, where the operator and the pole or helmet mount
appear — is never usable: every pixel more than ``NADIR_MASK_DEGREES`` below the
horizon is destroyed in the derivative and excluded from reconstruction,
whether or not a detector saw anybody there.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

HORIZON_VIEWS = 8
UPPER_VIEWS = 6
UPPER_PITCH_DEGREES = 45.0
VIEW_FOV_DEGREES = 90.0
VIEW_ASPECT = 3 / 4  # height / width
# A view's width follows its panorama (one source pixel per view pixel at the
# centre), within these bounds.
VIEW_MIN_WIDTH = 256
VIEW_MAX_WIDTH = 2048
PANORAMA_MAX_LONG_EDGE = round(VIEW_MAX_WIDTH * 360 / VIEW_FOV_DEGREES)
NADIR_MASK_DEGREES = 30.0

# Privacy pipelines that cut panoramas into the horizon ring only. A view they
# produced looks at the horizon whether or not its manifest entry says so;
# any later view's pitch must be stated (see recon/job.py).
HORIZON_ONLY_PIPELINES = frozenset({"goway-privacy/1", "goway-privacy/2"})


@dataclass(frozen=True)
class ViewDirection:
    yaw: float  # degrees clockwise from the panorama's centre, [0, 360)
    pitch: float  # degrees above the horizon


def view_directions(
    horizon: int = HORIZON_VIEWS, upper: int = UPPER_VIEWS, upper_pitch: float = UPPER_PITCH_DEGREES
) -> list[ViewDirection]:
    return [ViewDirection(i * 360.0 / horizon, 0.0) for i in range(horizon)] + [
        ViewDirection(i * 360.0 / upper, upper_pitch) for i in range(upper)
    ]


def view_size(panorama_width: int, fov_degrees: float = VIEW_FOV_DEGREES) -> tuple[int, int]:
    """(width, height) of a view of a panorama ``panorama_width`` pixels wide."""
    width = min(VIEW_MAX_WIDTH, max(VIEW_MIN_WIDTH, round(panorama_width * fov_degrees / 360.0)))
    width += width % 2
    return width, round(width * VIEW_ASPECT)


def focal_pixels(width: int, fov_degrees: float = VIEW_FOV_DEGREES) -> float:
    return width / 2 / math.tan(math.radians(fov_degrees) / 2)


def cam_from_pano(yaw_degrees: float, pitch_degrees: float = 0.0) -> np.ndarray:
    """Rotation taking panorama-frame directions into a view's camera frame.

    The view is turned by ``yaw`` about the vertical, then tilted up by
    ``pitch`` about its own x axis (no roll).
    """
    yaw, pitch = math.radians(yaw_degrees), math.radians(pitch_degrees)
    cy, sy, cp, sp = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch)
    turn = np.array([[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]])
    tilt = np.array([[1.0, 0.0, 0.0], [0.0, cp, -sp], [0.0, sp, cp]])
    pano_from_cam = turn @ tilt
    return pano_from_cam.T


@dataclass
class PanoramaView:
    yaw_degrees: float
    pitch_degrees: float
    rgb: np.ndarray
    nadir: np.ndarray  # bool HxW: pixels inside the masked nadir cap


@dataclass
class _ViewGeometry:
    direction: ViewDirection
    map1: np.ndarray
    map2: np.ndarray
    nadir: np.ndarray


class ViewCutter:
    """Resampling maps per panorama size, computed once and reused per frame.

    ``width``/``height`` fix the view size; left out, each panorama's views are
    sized from its own resolution (:func:`view_size`).
    """

    def __init__(
        self,
        *,
        directions: list[ViewDirection] | None = None,
        fov_degrees: float = VIEW_FOV_DEGREES,
        width: int | None = None,
        height: int | None = None,
        nadir_degrees: float = NADIR_MASK_DEGREES,
    ) -> None:
        self.directions = directions if directions is not None else view_directions()
        self.fov_degrees = fov_degrees
        self._fixed = (width, height) if width else None
        self._nadir_degrees = nadir_degrees
        self._geometry: dict[tuple[int, int], list[_ViewGeometry]] = {}

    def size_for(self, panorama_width: int) -> tuple[int, int]:
        if self._fixed:
            width, height = self._fixed
            return width, height or round(width * VIEW_ASPECT)
        return view_size(panorama_width, self.fov_degrees)

    def _geometry_for(self, height: int, width: int) -> list[_ViewGeometry]:
        key = (height, width)
        if key not in self._geometry:
            vw, vh = self.size_for(width)
            f = focal_pixels(vw, self.fov_degrees)
            xs, ys = np.meshgrid(np.arange(vw) - vw / 2 + 0.5, np.arange(vh) - vh / 2 + 0.5)
            rays = np.stack([xs, ys, np.full_like(xs, f)], -1)
            rays /= np.linalg.norm(rays, axis=-1, keepdims=True)
            views = []
            for direction in self.directions:
                d = rays @ cam_from_pano(direction.yaw, direction.pitch)  # rows: pano_from_cam @ ray
                lon = np.arctan2(d[..., 0], d[..., 2])
                lat = np.arcsin(np.clip(-d[..., 1], -1, 1))
                u = ((lon / (2 * math.pi) + 0.5) * width - 0.5).astype(np.float32)
                v = ((0.5 - lat / math.pi) * height - 0.5).astype(np.float32)
                # Fixed-point maps: a third of the memory and a faster remap, at 1/32 px.
                map1, map2 = cv2.convertMaps(u, v, cv2.CV_16SC2)
                views.append(_ViewGeometry(direction, map1, map2, np.degrees(lat) < -self._nadir_degrees))
            self._geometry[key] = views
        return self._geometry[key]

    def cut(self, equirect: np.ndarray) -> list[PanoramaView]:
        h, w = equirect.shape[:2]
        views = []
        for g in self._geometry_for(h, w):
            rgb = cv2.remap(equirect, g.map1, g.map2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
            views.append(PanoramaView(g.direction.yaw, g.direction.pitch, np.ascontiguousarray(rgb), g.nadir))
        return views
