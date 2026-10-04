"""Sensitive-content detectors behind one interface.

Three reviewed models, each with a narrow job:

- faces: YuNet (OpenCV Zoo, MIT).
- licence plates: LPD-YuNet (OpenCV Zoo, Apache-2.0). It was trained on Chinese
  plates and recalls others poorly, so it is a SECOND line: every detected
  vehicle is blurred and masked whole, which covers the plate it carries
  whether or not this model sees it.
- people and vehicles: torchvision Mask R-CNN v2 (COCO). Pixel masks rather
  than boxes, so the static street around a parked car or a pedestrian stays
  usable for reconstruction.

Thresholds are deliberately recall-biased. A false positive costs a few pixels
of facade in one frame, which other viewpoints fill in; a false negative is a
person in a published scene.

The decode in ``_PlateDetector`` follows OpenCV Zoo's ``lpd_yunet.py``
(Apache-2.0, copyright the OpenCV Zoo contributors).
"""

from __future__ import annotations

from dataclasses import dataclass
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


@dataclass
class FrameDetections:
    faces: list[tuple[int, int, int, int]]
    plates: list[tuple[int, int, int, int]]
    people: np.ndarray  # bool HxW union mask
    vehicles: np.ndarray  # bool HxW union mask
    people_count: int
    vehicle_count: int
    vehicle_boxes: list[tuple[int, int, int, int]]


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

    def detect(self, bgr: np.ndarray, regions: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
        """Plates in the whole frame and inside each vehicle region."""
        h, w = bgr.shape[:2]
        found: list[tuple[int, int, int, int]] = []
        for x0, y0, rw, rh in [(0, 0, w, h), *regions]:
            if rw < 24 or rh < 24:
                continue
            crop = bgr[y0:y0 + rh, x0:x0 + rw]
            resized = cv2.resize(crop, self._INPUT)
            sx, sy = rw / self._INPUT[0], rh / self._INPUT[1]
            for quad in self._detect_resized(resized):
                xs, ys = quad[:, 0] * sx + x0, quad[:, 1] * sy + y0
                found.append((int(xs.min()), int(ys.min()), int(xs.max() - xs.min()), int(ys.max() - ys.min())))
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
    def detect(self, rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, int, int, list[tuple[int, int, int, int]]]:
        h, w = rgb.shape[:2]
        tensor = torch.from_numpy(rgb).to(self._device).permute(2, 0, 1).float() / 255.0
        out = self._model([tensor])[0]
        people = np.zeros((h, w), dtype=bool)
        vehicles = np.zeros((h, w), dtype=bool)
        n_people = n_vehicles = 0
        vehicle_boxes: list[tuple[int, int, int, int]] = []
        labels = out["labels"].tolist()
        masks = (out["masks"][:, 0] > 0.35).cpu().numpy() if len(labels) else np.zeros((0, h, w), dtype=bool)
        boxes = out["boxes"].cpu().numpy() if len(labels) else np.zeros((0, 4))
        for label, mask, box in zip(labels, masks, boxes):
            if label in PERSON_LABELS:
                people |= mask
                n_people += 1
            elif label in VEHICLE_LABELS:
                vehicles |= mask
                n_vehicles += 1
                x0, y0, x1, y1 = (int(v) for v in box)
                vehicle_boxes.append((max(0, x0), max(0, y0), max(1, x1 - x0), max(1, y1 - y0)))
        return people, vehicles, n_people, n_vehicles, vehicle_boxes


class PrivacyDetectors:
    """All three detectors, loaded once per worker process from verified files."""

    def __init__(self, models_dir: Path, device: torch.device, *, download: bool = True) -> None:
        self._faces = _FaceDetector(ensure_model(FACE_DETECTOR, models_dir, download=download))
        self._plates = _PlateDetector(ensure_model(PLATE_DETECTOR, models_dir, download=download))
        self._instances = _InstanceSegmenter(ensure_model(INSTANCE_SEGMENTER, models_dir, download=download), device)

    def detect(self, rgb: np.ndarray) -> FrameDetections:
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        people, vehicles, n_people, n_vehicles, vehicle_boxes = self._instances.detect(rgb)
        return FrameDetections(
            faces=self._faces.detect(bgr),
            plates=self._plates.detect(bgr, vehicle_boxes),
            people=people,
            vehicles=vehicles,
            people_count=n_people,
            vehicle_count=n_vehicles,
            vehicle_boxes=vehicle_boxes,
        )
