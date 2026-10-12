import io

import numpy as np
import pytest
from PIL import Image

from goway_reconstruction.privacy.detectors import FrameDetections
from goway_reconstruction.privacy.media import decode_photo
from goway_reconstruction.privacy.redact import (
    EXCLUSION_MARGIN_PIXELS,
    MetadataSurvivedError,
    assert_no_metadata,
    outline_margin,
    redact,
    sensitive_regions,
)
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


def test_video_display_rotation_convention():
    from goway_reconstruction.privacy.media import upright

    # A landscape-stored frame whose top row is marked; a portrait phone video
    # stores it this way with rotation -90 ("turn clockwise to display").
    frame = np.zeros((2, 3, 3), np.uint8)
    frame[0, :, 0] = 255  # top row red
    turned = upright(frame, -90)
    assert turned.shape[:2] == (3, 2)
    assert (turned[:, -1, 0] == 255).all()  # clockwise: the old top is now the right edge
    assert (upright(frame, 180)[-1, :, 0] == 255).all()
    assert upright(frame, 0) is frame


# ── Blur and exclusion are different regions ────────────────────────────────


def car(h, w, box, outline, label=3, plates=()):
    """A vehicle whose instance mask is ``outline`` (x0, y0, x1, y1), inside its detector ``box``."""
    vehicles = np.zeros((h, w), bool)
    x0, y0, x1, y1 = outline
    vehicles[y0:y1, x0:x1] = True
    return FrameDetections(
        faces=[], plates=list(plates), people=np.zeros((h, w), bool), vehicles=vehicles, people_count=0, vehicle_count=1,
        vehicle_boxes=[box], vehicle_labels=[label],
    )


def decoded(out):
    return np.asarray(Image.open(io.BytesIO(out.jpeg))).astype(float), np.asarray(Image.open(io.BytesIO(out.mask_png)))


def plate_pattern(rgb, x0, y0, x1, y1):
    """High-contrast characters: 4 px black and white bars, readable if left alone."""
    rgb[y0:y1, x0:x1] = 255
    for x in range(x0, x1, 8):
        rgb[y0 + 3 : y1 - 3, x : x + 4] = 0


def test_a_plate_the_detector_missed_is_still_destroyed():
    # The instance mask stops above the bumper (where mask edges are least
    # reliable) and the plate detector saw nothing: the band of the box must
    # still destroy the plate.
    rgb = textured()
    plate_pattern(rgb, 290, 320, 350, 342)
    out = redact(rgb, car(480, 640, box=(200, 200, 240, 160), outline=(205, 200, 435, 290)))
    img, mask = decoded(out)
    plate = img[322:340, 292:348]
    assert plate.std() < 12  # the bars are gone, not merely softened
    assert np.abs(plate - rgb[322:340, 292:348]).mean() > 60
    assert (mask[315:347, 285:355] == 0).all()  # and never trained on


def test_a_two_wheeler_plate_high_on_its_tail_is_destroyed():
    rgb = textured()
    plate_pattern(rgb, 330, 215, 370, 233)  # near the top of a motorcycle's box
    out = redact(rgb, car(480, 640, box=(300, 200, 100, 140), outline=(320, 260, 380, 340), label=4))
    img, _mask = decoded(out)
    assert img[217:231, 332:368].std() < 12


def test_the_street_around_a_car_stays_usable():
    # A box much larger than the car (a detector box, or a car seen at an
    # angle): the facade above the car and outside its outline is neither
    # blurred nor excluded, as it was when the whole box was.
    rgb = textured()
    out = redact(rgb, car(480, 640, box=(100, 100, 400, 300), outline=(150, 250, 450, 400)))
    img, mask = decoded(out)
    street = (slice(105, 185), slice(105, 495))
    assert (mask[street] == 255).all()
    assert np.abs(img[street] - rgb[street]).mean() < 8  # JPEG error only
    assert (mask[250:400, 150:450] == 0).all()  # the car itself is excluded
    assert np.abs(img[300:380, 200:400] - rgb[300:380, 200:400]).mean() > 40  # and destroyed


def test_a_head_is_destroyed_without_any_face_detection():
    rgb = textured()
    h, w = rgb.shape[:2]
    det = FrameDetections(
        faces=[], plates=[], people=np.zeros((h, w), bool), vehicles=np.zeros((h, w), bool), people_count=1, vehicle_count=0,
        vehicle_boxes=[], person_boxes=[(300, 100, 60, 180)],
    )
    img, mask = decoded(redact(rgb, det))
    head = (slice(100, 145), slice(300, 360))
    assert np.abs(img[head] - rgb[head]).mean() > 40 and (mask[head] == 0).all()


def test_everything_destroyed_is_excluded_with_a_margin():
    det = detections(480, 640, face=(100, 100, 60, 60), vehicle=(300, 200, 200, 120))
    blur, exclude = sensitive_regions(det, (480, 640))
    assert blur.any() and not (blur & ~exclude).any()
    assert EXCLUSION_MARGIN_PIXELS == 16
    assert outline_margin((480, 640)) == 8 and outline_margin((3072, 4096)) == 30  # never below a JPEG block
    # The face's destroyed box ends at column 180; 16 px further is still excluded, 19 px is not.
    row = 130
    assert blur[row, 180] and not blur[row, 181]
    assert exclude[row, 196] and not exclude[row, 199]
    # An outline is destroyed as it is and excluded with its own margin.
    people = np.zeros((480, 640), bool)
    people[300:400, 500:540] = True
    det = FrameDetections(faces=[], plates=[], people=people, vehicles=np.zeros((480, 640), bool), people_count=1, vehicle_count=0, vehicle_boxes=[])
    blur, exclude = sensitive_regions(det, (480, 640))
    assert (blur == people).all()
    assert exclude[350, 547] and not exclude[350, 549]


def test_derivatives_are_full_chroma_high_quality_jpeg():
    from PIL import JpegImagePlugin

    out = redact(textured(), detections(480, 640))
    with Image.open(io.BytesIO(out.jpeg)) as image:
        assert JpegImagePlugin.get_sampling(image) == 0  # 4:4:4
        assert max(image.quantization[0]) <= 13  # q95; q92 would reach 19


# ── The plate detector's input geometry ─────────────────────────────────────


def bare_plate_detector(quads_in_input):
    from goway_reconstruction.privacy.detectors import _PlateDetector

    detector = object.__new__(_PlateDetector)  # no network: geometry only
    seen = []

    def fake(canvas):
        seen.append(canvas)
        return [np.array(q, dtype=np.float32) for q in quads_in_input]

    detector._detect_resized = fake
    return detector, seen


def test_plate_crops_are_letterboxed_not_stretched():
    detector, seen = bare_plate_detector([])
    canvas, scale, size = detector.letterbox(np.full((100, 400, 3), 200, np.uint8))  # a wide vehicle crop
    assert canvas.shape == (480, 640, 3) and scale == pytest.approx(1.6) and size == (640, 160)
    assert (canvas[:160, :640] == 200).all() and (canvas[161:] == 0).all()  # aspect kept, padded below


def test_plates_map_back_to_the_frame_through_the_letterbox():
    # One quad found at the same place of every network input; its frame box
    # depends only on each region's offset and scale.
    detector, seen = bare_plate_detector([[(320, 80), (352, 80), (352, 96), (320, 96)]])
    frame = np.zeros((480, 640, 3), np.uint8)
    boxes = detector.detect(frame, [(100, 300, 400, 100)])
    assert (320, 80, 32, 16) in boxes  # the whole frame: scale 1
    assert (300, 350, 20, 10) in boxes  # the vehicle region at scale 1.6: x = 320/1.6 + 100


def test_a_large_frame_is_also_searched_in_tiles():
    from goway_reconstruction.privacy.detectors import _PlateDetector

    assert _PlateDetector.tiles(1280, 960) == []
    tiles = _PlateDetector.tiles(4096, 3072)
    covered = np.zeros((3072, 4096), bool)
    for x, y, w, h in tiles:
        assert (w, h) == (1280, 960)
        covered[y : y + h, x : x + w] = True
    assert covered.all()
    # Neighbours overlap by at least a quarter of a tile, so no plate is only ever cut in half.
    xs = sorted({x for x, *_ in tiles})
    assert min(b - a for a, b in zip(xs, xs[1:])) <= 1280 * 0.75


def test_decoder_boxes_larger_than_their_crop_are_dropped():
    # Seen on real frames: "plates" several vehicle-widths wide, lying on the
    # letterbox padding. A real plate partly cut by the crop's edge is kept.
    detector, _seen = bare_plate_detector([
        [(-900, 10), (1500, 10), (1500, 300), (-900, 300)],  # wider than the whole crop
        [(600, 140), (700, 140), (700, 170), (600, 170)],  # 40 % on the picture, cut by its right edge
        [(100, 300), (200, 300), (200, 330), (100, 330)],  # entirely on the padding below the picture
    ])
    boxes = detector.detect(np.zeros((480, 640, 3), np.uint8), [(100, 300, 400, 100)])
    assert sorted(boxes) == sorted([
        (600, 140, 40, 30),  # whole frame (no padding): the cut plate, clipped; the giant box dropped
        (100, 300, 100, 30),  # whole frame: the third box is on the picture there
        (475, 387, 25, 13),  # vehicle crop: only the cut plate, clipped to the picture (x = 600 / 1.6 + 100)
    ])


def test_a_higher_resolution_never_makes_a_face_less_destroyed():
    from goway_reconstruction.privacy.redact import mosaic_cell

    # Cells across a face that fills a tenth of the frame's width.
    def cells(width: int, height: int) -> float:
        return width * 0.1 / mosaic_cell(height, width)

    old_worst = 1280 * 0.1 / 24  # a 1280 px panorama view, the finest the pipeline ever made
    for width, height in ((1280, 960), (1416, 1062), (2048, 1536), (3840, 2160), (4096, 3072)):
        assert cells(width, height) <= old_worst + 1e-9
    # And on the pixels: a large face at 4096 px is as featureless as at 1280 px.
    big = textured(3072, 4096)
    out = redact(big, detections(3072, 4096, face=(1500, 1000, 400, 400)))
    face = np.asarray(Image.open(io.BytesIO(out.jpeg)))[1050:1350, 1550:1850].astype(float)
    assert face.std() < big[1050:1350, 1550:1850].std() / 6
