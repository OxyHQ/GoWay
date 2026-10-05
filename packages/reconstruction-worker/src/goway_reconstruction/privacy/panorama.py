"""Cutting an equirectangular panorama into overlapping perspective views.

The privacy detectors and the camera solve both expect ordinary pinhole
images, so a 360° frame is never processed as one image. It is resampled into
``VIEW_COUNT`` views around the horizon, each ``VIEW_FOV_DEGREES`` wide, with
neighbouring views overlapping by half their width — a face on a view's edge
is whole in the next view. Every view is a separate privacy-safe derivative,
detected, redacted and masked on its own, and records which panorama it came
from and its yaw, so the solve can treat the views of one panorama as a rig.

Conventions (shared with the solve through :func:`cam_from_pano`):

- camera axes are COLMAP's: x right, y down, z forward;
- the panorama's yaw 0 is the centre column of the equirectangular image, and
  yaw grows to the right (clockwise seen from above, like a compass heading);
- pitch is 0: views look at the horizon and are upright.

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

VIEW_COUNT = 8
VIEW_FOV_DEGREES = 90.0
VIEW_WIDTH = 1280
VIEW_HEIGHT = 960
# The equirectangular frame is first resized so that one view's field of view
# spans about one view width of source pixels: resampling then neither throws
# detail away nor aliases.
PANORAMA_LONG_EDGE = round(VIEW_WIDTH * 360 / VIEW_FOV_DEGREES)
NADIR_MASK_DEGREES = 30.0


def view_yaws(count: int = VIEW_COUNT) -> list[float]:
    return [i * 360.0 / count for i in range(count)]


def focal_pixels(width: int = VIEW_WIDTH, fov_degrees: float = VIEW_FOV_DEGREES) -> float:
    return width / 2 / math.tan(math.radians(fov_degrees) / 2)


def cam_from_pano(yaw_degrees: float) -> np.ndarray:
    """Rotation taking panorama-frame directions into a view's camera frame."""
    yaw = math.radians(yaw_degrees)
    c, s = math.cos(yaw), math.sin(yaw)
    pano_from_cam = np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])
    return pano_from_cam.T


@dataclass
class PanoramaView:
    yaw_degrees: float
    rgb: np.ndarray
    nadir: np.ndarray  # bool HxW: pixels inside the masked nadir cap


class ViewCutter:
    """Resampling maps per (panorama size), computed once and reused per frame."""

    def __init__(
        self,
        *,
        count: int = VIEW_COUNT,
        fov_degrees: float = VIEW_FOV_DEGREES,
        width: int = VIEW_WIDTH,
        height: int = VIEW_HEIGHT,
        nadir_degrees: float = NADIR_MASK_DEGREES,
    ) -> None:
        self.yaws = view_yaws(count)
        self.fov_degrees = fov_degrees
        self.width, self.height = width, height
        f = focal_pixels(width, fov_degrees)
        xs, ys = np.meshgrid(np.arange(width) - width / 2 + 0.5, np.arange(height) - height / 2 + 0.5)
        rays = np.stack([xs, ys, np.full_like(xs, f)], -1)
        self._rays = rays / np.linalg.norm(rays, axis=-1, keepdims=True)
        # Pitch is 0, so the elevation of a pixel does not depend on yaw.
        elevation = np.degrees(np.arcsin(np.clip(-self._rays[..., 1], -1, 1)))
        self.nadir = elevation < -nadir_degrees
        self._maps: dict[tuple[int, int], list[tuple[np.ndarray, np.ndarray]]] = {}

    def _maps_for(self, height: int, width: int) -> list[tuple[np.ndarray, np.ndarray]]:
        key = (height, width)
        if key not in self._maps:
            maps = []
            for yaw in self.yaws:
                d = self._rays @ cam_from_pano(yaw)  # rows: pano_from_cam @ ray
                lon = np.arctan2(d[..., 0], d[..., 2])
                lat = np.arcsin(np.clip(-d[..., 1], -1, 1))
                u = (lon / (2 * math.pi) + 0.5) * width - 0.5
                v = (0.5 - lat / math.pi) * height - 0.5
                maps.append((u.astype(np.float32), v.astype(np.float32)))
            self._maps[key] = maps
        return self._maps[key]

    def cut(self, equirect: np.ndarray) -> list[PanoramaView]:
        h, w = equirect.shape[:2]
        views = []
        for yaw, (u, v) in zip(self.yaws, self._maps_for(h, w)):
            rgb = cv2.remap(equirect, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
            views.append(PanoramaView(yaw_degrees=yaw, rgb=np.ascontiguousarray(rgb), nadir=self.nadir))
        return views
