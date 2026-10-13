"""Feature sets of the camera solve: masks hold for every set, and a scene's frames round-trip."""

from pathlib import Path

import cv2
import numpy as np
import pycolmap
import pytest
import torch

from goway_reconstruction.config import DEFAULT_DATA
from goway_reconstruction.models import FEATURE_MODELS, ModelIntegrityError, ensure_model
from goway_reconstruction.recon.features import LEARNED_SETS, LearnedFeatures, trusted
from goway_reconstruction.recon.sfm import FEATURE_SETS, RigView, SfmFrame, extract, read_frames, write_frames

MODELS_DIR = DEFAULT_DATA / "models"


def _weights_installed() -> bool:
    try:
        for model in FEATURE_MODELS:
            ensure_model(model, MODELS_DIR, download=False)
    except ModelIntegrityError:
        return False
    return True


def test_a_keypoint_survives_only_on_a_fully_trusted_pixel():
    mask = np.full((4, 6), 255, np.uint8)
    mask[1, 2] = 0
    mask[2, 3] = 254  # blur bled into it: not trusted either
    points = np.array(
        [
            [0.5, 0.5],  # centre of the first pixel
            [2.5, 1.5],  # masked
            [2.99, 1.99],  # still inside the masked pixel
            [3.0, 1.0],  # the next pixel, trusted
            [3.5, 2.5],  # partly masked
            [5.99, 3.99],  # last pixel
            [6.0, 2.0],  # outside
            [-0.01, 2.0],  # outside
        ],
        dtype=np.float32,
    )
    assert trusted(points, mask).tolist() == [True, False, False, True, False, True, False, False]


def test_frames_round_trip_with_rig_and_gravity(tmp_path: Path):
    frames = [
        SfmFrame("f1", "a", 0, "a/f1.jpg", 1920, 1080, 1.0, 2.0, 0.5, 26.0, gravity=(0.0, 1.0, 0.0)),
        SfmFrame("f2", "p", 3, "rig-x/y00000/pano.jpg", 1024, 1024, 0.0, 0.0, 0.0, None, rig=RigView("pano", 0.0, 90.0, None), heading=12.5),
    ]
    write_frames(frames, tmp_path / "frames.json")
    assert read_frames(tmp_path / "frames.json") == frames


def _scene(root: Path) -> tuple[list[SfmFrame], np.ndarray]:
    """One textured frame whose left half is masked."""
    rng = np.random.default_rng(7)
    texture = cv2.GaussianBlur((rng.random((480, 640)) * 255).astype(np.uint8), (0, 0), 2)
    image = cv2.cvtColor(cv2.normalize(texture, None, 0, 255, cv2.NORM_MINMAX), cv2.COLOR_GRAY2BGR)
    mask = np.full((480, 640), 255, np.uint8)
    mask[:, :320] = 0
    (root / "images" / "a").mkdir(parents=True)
    (root / "masks" / "a").mkdir(parents=True)
    cv2.imwrite(str(root / "images" / "a" / "f1.jpg"), image, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(root / "masks" / "a" / "f1.jpg.png"), mask)
    return [SfmFrame("f1", "a", 0, "a/f1.jpg", 640, 480, 0.0, 0.0, 0.0, None)], mask


@pytest.mark.parametrize("features", FEATURE_SETS)
def test_no_keypoint_is_detected_on_a_masked_pixel(tmp_path: Path, features: str):
    learned = None
    if features in LEARNED_SETS:
        if not _weights_installed():
            pytest.skip("feature weights not installed (bun run worker:setup)")
        learned = LearnedFeatures(features, MODELS_DIR, torch.device("cuda" if torch.cuda.is_available() else "cpu"))
    frames, mask = _scene(tmp_path)
    database = tmp_path / "database.db"
    extract(database, frames, tmp_path / "images", tmp_path / "masks", learned)
    with pycolmap.Database.open(database) as db:
        (image,) = db.read_all_images()
        keypoints = db.read_keypoints(image.image_id)[:, :2]
    assert len(keypoints) > 100  # the unmasked half is found
    assert trusted(keypoints, mask).all()
