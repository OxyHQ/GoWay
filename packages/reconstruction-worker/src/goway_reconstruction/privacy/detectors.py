"""Sensitive-content detectors behind one interface.

Three reviewed models, each with a narrow job:

- faces: YuNet (OpenCV Zoo, MIT).
- licence plates: LPD-YuNet (OpenCV Zoo, Apache-2.0). It was trained on Chinese
  plates and recalls others poorly, so it is a SECOND line: the lower band of
  every detected vehicle, where a plate sits, is blurred whether or not this
  model sees one (``redact.py``). It runs on the whole frame, on overlapping
  tiles of a large frame (so a distant plate is not shrunk away) and on every
  vehicle, each crop letterboxed into the network's input, never stretched.
- people and vehicles: torchvision Mask R-CNN v2 (COCO). Pixel masks rather
  than boxes, so the static street around a parked car or a pedestrian stays
  usable for reconstruction; the boxes locate heads and plate bands.

Thresholds are deliberately recall-biased. A false positive costs a few pixels
of facade in one frame, which other viewpoints fill in; a false negative is a
person in a published scene.

The decode in ``_PlateDetector`` follows OpenCV Zoo's ``lpd_yunet.py``
(Apache-2.0, copyright the OpenCV Zoo contributors).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import product
from pathlib import Path

import cv2
import numpy as np
import torch

from ..models import FACE_DETECTOR, INSTANCE_SEGMENTER, PLATE_DETECTOR, ensure_model

# COCO category ids in torchvision's Mask R-CNN label space.
PERSON_LABELS = frozenset({1})
VEHICLE_LABELS = frozenset({2, 3, 4, 6, 7, 8})  # bicycle, car, motorcycle, bus, train, truck

FACE_SCORE = 0.6
PLATE_SCORE = 0.6
INSTANCE_SCORE = 0.3
# Share of a plate detection's box that must lie on the image (not the
# letterbox padding); see ``_PlateDetector.in_content``. Lenient on purpose: a
# plate cut by the crop's edge is still kept.
MIN_PLATE_INSIDE = 0.25


@dataclass
class FrameDetections:
    faces: list[tuple[int, int, int, int]]
    plates: list[tuple[int, int, int, int]]
    people: np.ndarray  # bool HxW union mask
    vehicles: np.ndarray  # bool HxW union mask
    people_count: int
    vehicle_count: int
    vehicle_boxes: list[tuple[int, int, int, int]]
    # COCO label of each vehicle box, in order; absent (or shorter), a box is
    # treated as the most cautious kind (see redact.py).
    vehicle_labels: list[int] = field(default_factory=list)
    person_boxes: list[tuple[int, int, int, int]] = field(default_factory=list)


class _FaceDetector:
    def __init__(self, path: Path) -> None:
        self._net = cv2.FaceDetectorYN.create(str(path), "", (320, 320), FACE_SCORE, 0.3, 5000)

    def detect(self, bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
        h, w = bgr.shape[:2]
        self._net.setInputSize((w, h))
        _, faces = self._net.detect(bgr)
        boxes: list[tuple[int, int, int, int]] = []
        if faces is not None:
            for row in faces:
                x, y, bw, bh = (int(round(v)) for v in row[:4])
                boxes.append((x, y, bw, bh))
        return boxes


class _PlateDetector:
    _MIN_SIZES = [[10, 16, 24], [32, 48], [64, 96], [128, 192, 256]]
    _STEPS = [8, 16, 32, 64]
    _VARIANCE = (0.1, 0.2)
    _INPUT = (640, 480)
    # A frame larger than this is also searched in overlapping tiles of this
    # size, so the network never sees a plate shrunk by more than half.
    _TILE = (1280, 960)
    _TILE_OVERLAP = 0.25

    def __init__(self, path: Path) -> None:
        self._net = cv2.dnn.readNet(str(path))
        self._priors = self._prior_boxes(*self._INPUT)

    @classmethod
    def _prior_boxes(cls, w: int, h: int) -> np.ndarray:
        fm2 = [int(int((h + 1) / 2) / 2), int(int((w + 1) / 2) / 2)]
        fm3 = [int(fm2[0] / 2), int(fm2[1] / 2)]
        fm4 = [int(fm3[0] / 2), int(fm3[1] / 2)]
        fm5 = [int(fm4[0] / 2), int(fm4[1] / 2)]
        fm6 = [int(fm5[0] / 2), int(fm5[1] / 2)]
        priors = []
        for k, f in enumerate([fm3, fm4, fm5, fm6]):
            for i, j in product(range(f[0]), range(f[1])):
                for min_size in cls._MIN_SIZES[k]:
                    priors.append([(j + 0.5) * cls._STEPS[k] / w, (i + 0.5) * cls._STEPS[k] / h, min_size / w, min_size / h])
        return np.array(priors, dtype=np.float32)

    def _detect_resized(self, bgr: np.ndarray) -> list[np.ndarray]:
        w, h = self._INPUT
        self._net.setInput(cv2.dnn.blobFromImage(bgr))
        loc, conf, iou = self._net.forward(["loc", "conf", "iou"])
        scores = np.sqrt(conf[:, 1] * np.clip(iou[:, 0], 0, 1))
        p, v = self._priors, self._VARIANCE[0]
        scale = np.array([w, h], dtype=np.float32)
        corners = [(p[:, 0:2] + loc[:, a:a + 2] * v * p[:, 2:4]) * scale for a in (4, 6, 10, 12)]
        keep = cv2.dnn.NMSBoxes(
            bboxes=[_corners_to_xywh(c) for c in zip(*corners)],
            scores=scores.tolist(),
            score_threshold=PLATE_SCORE,
            nms_threshold=0.3,
        )
        return [np.array([corners[n][i] for n in range(4)]) for i in np.array(keep).reshape(-1)]

    @classmethod
    def tiles(cls, w: int, h: int) -> list[tuple[int, int, int, int]]:
        """Overlapping tiles covering a frame larger than one tile; none for a smaller frame."""
        tw, th = cls._TILE
        if w <= tw and h <= th:
            return []

        def starts(length: int, size: int) -> list[int]:
            if length <= size:
                return [0]
            n = math.ceil((length - size) / (size * (1 - cls._TILE_OVERLAP))) + 1
            return [round(i * (length - size) / (n - 1)) for i in range(n)]

        return [(x, y, min(tw, w), min(th, h)) for y in starts(h, th) for x in starts(w, tw)]

    def letterbox(self, crop: np.ndarray) -> tuple[np.ndarray, float, tuple[int, int]]:
        """``crop`` scaled to fit the network input with its aspect kept, padded black.

        Returns (input, scale, (width, height) of the image within the input).
        """
        iw, ih = self._INPUT
        rh, rw = crop.shape[:2]
        scale = min(iw / rw, ih / rh)
        size = (max(1, round(rw * scale)), max(1, round(rh * scale)))
        canvas = np.zeros((ih, iw, 3), dtype=np.uint8)
        canvas[: size[1], : size[0]] = cv2.resize(crop, size, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        return canvas, scale, size

    @staticmethod
    def in_content(quad: np.ndarray, width: int, height: int) -> tuple[float, float, float, float] | None:
        """A detection's box clipped to the image content of the input, or None if it cannot be a plate there.

        The decoder can return boxes several times larger than the crop, lying
        mostly on the padding (seen on real street frames: boxes three to nine
        vehicle-widths wide). A plate is never larger than the crop it was
        found in, and some of it is always in the picture; anything else is
        decoder noise that would only blur — and exclude — the street.
        """
        x0, x1, y0, y1 = float(quad[:, 0].min()), float(quad[:, 0].max()), float(quad[:, 1].min()), float(quad[:, 1].max())
        if x1 - x0 > width or y1 - y0 > height:
            return None
        inside = max(0.0, min(x1, width) - max(x0, 0.0)) * max(0.0, min(y1, height) - max(y0, 0.0))
        if inside < MIN_PLATE_INSIDE * max((x1 - x0) * (y1 - y0), 1e-6):
            return None
        return max(x0, 0.0), max(y0, 0.0), min(x1, width), min(y1, height)

    def detect(self, bgr: np.ndarray, regions: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
        """Plates in the whole frame, in its tiles and inside each vehicle region."""
        h, w = bgr.shape[:2]
        found: list[tuple[int, int, int, int]] = []
        for x0, y0, rw, rh in [(0, 0, w, h), *self.tiles(w, h), *regions]:
            x0, y0 = max(0, x0), max(0, y0)
            rw, rh = min(rw, w - x0), min(rh, h - y0)
            if rw < 24 or rh < 24:
                continue
            canvas, scale, (cw, ch) = self.letterbox(bgr[y0:y0 + rh, x0:x0 + rw])
            for quad in self._detect_resized(canvas):
                box = self.in_content(quad, cw, ch)
                if box is None:
                    continue
                bx0, by0 = max(0, int(box[0] / scale + x0)), max(0, int(box[1] / scale + y0))
                bx1, by1 = min(w, int(math.ceil(box[2] / scale + x0))), min(h, int(math.ceil(box[3] / scale + y0)))
                if bx1 > bx0 and by1 > by0:
                    found.append((bx0, by0, bx1 - bx0, by1 - by0))
        return found


def _corners_to_xywh(quad: tuple[np.ndarray, ...]) -> list[float]:
    xs = [c[0] for c in quad]
    ys = [c[1] for c in quad]
    return [float(min(xs)), float(min(ys)), float(max(xs) - min(xs)), float(max(ys) - min(ys))]


class _InstanceSegmenter:
    def __init__(self, path: Path, device: torch.device) -> None:
        from torchvision.models.detection import maskrcnn_resnet50_fpn_v2

        model = maskrcnn_resnet50_fpn_v2(weights=None, weights_backbone=None, box_score_thresh=INSTANCE_SCORE)
        model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
        self._model = model.eval().to(device)
        self._device = device

    @torch.inference_mode()
    def detect(self, rgb: np.ndarray) -> FrameDetections:
        """People and vehicles; faces and plates are left empty for the other detectors."""
        h, w = rgb.shape[:2]
        tensor = torch.from_numpy(rgb).to(self._device).permute(2, 0, 1).float() / 255.0
        out = self._model([tensor])[0]
        det = FrameDetections(
            faces=[], plates=[], people=np.zeros((h, w), dtype=bool), vehicles=np.zeros((h, w), dtype=bool),
            people_count=0, vehicle_count=0, vehicle_boxes=[],
        )
        labels = out["labels"].tolist()
        masks = (out["masks"][:, 0] > 0.35).cpu().numpy() if len(labels) else np.zeros((0, h, w), dtype=bool)
        boxes = out["boxes"].cpu().numpy() if len(labels) else np.zeros((0, 4))
        for label, mask, box in zip(labels, masks, boxes):
            x0, y0 = max(0, int(math.floor(box[0]))), max(0, int(math.floor(box[1])))
            x1, y1 = min(w, int(math.ceil(box[2]))), min(h, int(math.ceil(box[3])))
            xywh = (x0, y0, max(1, x1 - x0), max(1, y1 - y0))
            if label in PERSON_LABELS:
                det.people |= mask
                det.people_count += 1
                det.person_boxes.append(xywh)
            elif label in VEHICLE_LABELS:
                det.vehicles |= mask
                det.vehicle_count += 1
                det.vehicle_boxes.append(xywh)
                det.vehicle_labels.append(int(label))
        return det


class PrivacyDetectors:
    """All three detectors, loaded once per worker process from verified files."""

    def __init__(self, models_dir: Path, device: torch.device, *, download: bool = True) -> None:
        self._faces = _FaceDetector(ensure_model(FACE_DETECTOR, models_dir, download=download))
        self._plates = _PlateDetector(ensure_model(PLATE_DETECTOR, models_dir, download=download))
        self._instances = _InstanceSegmenter(ensure_model(INSTANCE_SEGMENTER, models_dir, download=download), device)

    def detect(self, rgb: np.ndarray) -> FrameDetections:
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        det = self._instances.detect(rgb)
        det.faces = self._faces.detect(bgr)
        det.plates = self._plates.detect(bgr, det.vehicle_boxes)
        return det
