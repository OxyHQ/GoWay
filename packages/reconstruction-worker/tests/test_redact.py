import io

import numpy as np
import pytest
from PIL import Image

from goway_reconstruction.privacy.detectors import FrameDetections
from goway_reconstruction.privacy.media import decode_photo
from goway_reconstruction.privacy.redact import MetadataSurvivedError, assert_no_metadata, redact
from goway_reconstruction.contract import KeyframePolicy


def detections(h, w, face=None, vehicle=None):
    people = np.zeros((h, w), bool)
    vehicles = np.zeros((h, w), bool)
    boxes = []
    if vehicle:
        x, y, bw, bh = vehicle
        vehicles[y : y + bh, x : x + bw] = True
        boxes.append(vehicle)
    return FrameDetections(faces=[face] if face else [], plates=[], people=people, vehicles=vehicles, people_count=0, vehicle_count=len(boxes), vehicle_boxes=boxes)


def textured(h=480, w=640, seed=0):
    return np.random.default_rng(seed).integers(0, 255, (h, w, 3), dtype=np.uint8)


def test_sensitive_regions_are_destroyed_and_masked():
    rgb = textured()
    out = redact(rgb, detections(480, 640, face=(100, 100, 60, 60), vehicle=(300, 200, 200, 120)))
    img = np.asarray(Image.open(io.BytesIO(out.jpeg)))
    mask = np.asarray(Image.open(io.BytesIO(out.mask_png)))
    face = img[110:150, 110:150].astype(float)
    assert face.std() < rgb[110:150, 110:150].std() / 4  # detail is gone
    assert (mask[110:150, 110:150] == 0).all() and (mask[220:300, 320:480] == 0).all()
    assert (mask[0:50, 0:50] == 255).all()
    assert 0 < out.masked_fraction < 0.3


def test_derivative_carries_no_metadata(tmp_path):
    exif = Image.Exif()
    exif[0x010F] = "SomeMake"  # Make
    exif[0x8825] = {2: (48.0, 52.0, 0.0)}  # GPSInfo
    src = tmp_path / "in.jpg"
    Image.fromarray(textured()).save(src, exif=exif)
    frame = decode_photo(src, KeyframePolicy(maxFrames=1, minIntervalSeconds=1, maxLongEdgePixels=2048))[0]
    out = redact(frame.rgb, detections(480, 640))
    assert_no_metadata(out.jpeg)
    assert b"SomeMake" not in out.jpeg


def test_metadata_check_fails_closed(tmp_path):
    exif = Image.Exif()
    exif[0x010F] = "SomeMake"
    buf = io.BytesIO()
    Image.fromarray(textured()).save(buf, format="JPEG", exif=exif)
    with pytest.raises(MetadataSurvivedError):
        assert_no_metadata(buf.getvalue())


def test_orientation_is_applied(tmp_path):
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW on display
    src = tmp_path / "rot.jpg"
    Image.fromarray(textured(400, 800)).save(src, exif=exif)
    frame = decode_photo(src, KeyframePolicy(maxFrames=1, minIntervalSeconds=1, maxLongEdgePixels=2048))[0]
    assert frame.rgb.shape[:2] == (800, 400)
