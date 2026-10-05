"""360° captures: projection evidence, view cutting and the fail-closed privacy job.

Everything here runs on the CPU with stand-in detectors and storage: what is
tested is the decision logic and the geometry, not the models.
"""

import hashlib
import io
import json
import math
import struct
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from goway_reconstruction.context import JobContext, JobFailure
from goway_reconstruction.contract import CapturePrivacyJob
from goway_reconstruction.privacy import job as privacy_job
from goway_reconstruction.privacy.detectors import FrameDetections
from goway_reconstruction.privacy.panorama import NADIR_MASK_DEGREES, ViewCutter, cam_from_pano, focal_pixels
from goway_reconstruction.privacy.projection import (
    ProjectionEvidence,
    ProjectionMismatch,
    is_two_to_one,
    photo_evidence,
    verify_declaration,
    verify_frame,
    video_evidence,
)

FIXTURES = Path(__file__).resolve().parents[1] / "contract" / "fixtures"

GPANO_ATTRIBUTES = (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="equirectangular" '
    'GPano:FullPanoWidthPixels="{w}" GPano:FullPanoHeightPixels="{h}" GPano:CroppedAreaImageWidthPixels="{cw}" '
    'GPano:CroppedAreaImageHeightPixels="{ch}" GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"/>'
    "</rdf:RDF></x:xmpmeta>"
)
GPANO_ELEMENTS = (
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description>'
    "<GPano:UsePanoramaViewer>True</GPano:UsePanoramaViewer>"
    "<GPano:ProjectionType>equirectangular</GPano:ProjectionType>"
    "</rdf:Description></rdf:RDF></x:xmpmeta>"
)


def textured(h: int, w: int, seed: int = 0) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, 255, (h, w, 3), dtype=np.uint8)


def jpeg(rgb: np.ndarray, xmp: str | None = None) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format="JPEG", quality=90)
    data = buffer.getvalue()
    if xmp is None:
        return data
    payload = b"http://ns.adobe.com/xap/1.0/\x00" + xmp.encode()
    return data[:2] + b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload + data[2:]


# ── ISO BMFF builders ───────────────────────────────────────────────────────


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def full_box(kind: bytes, payload: bytes) -> bytes:
    return box(kind, b"\x00\x00\x00\x00" + payload)


def spherical_v2(projection: bytes = b"equi", stereo: int = 0) -> bytes:
    proj = box(b"proj", full_box(b"prhd", bytes(12)) + full_box(projection, bytes(16)))
    sv3d = box(b"sv3d", full_box(b"svhd", b"test\x00") + proj)
    avc1 = box(b"avc1", bytes(78) + full_box(b"st3d", bytes([stereo])) + sv3d)
    stbl = box(b"stbl", full_box(b"stsd", struct.pack(">I", 1) + avc1))
    moov = box(b"moov", box(b"trak", box(b"mdia", box(b"minf", stbl))))
    return box(b"ftyp", b"isom\x00\x00\x00\x00isom") + box(b"mdat", bytes(64)) + moov


def spherical_v1_xml(projection: str = "equirectangular", stereo: str = "mono") -> bytes:
    return (
        '<?xml version="1.0"?><rdf:SphericalVideo xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
        'xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">'
        "<GSpherical:Spherical>true</GSpherical:Spherical><GSpherical:Stitched>true</GSpherical:Stitched>"
        f"<GSpherical:ProjectionType>{projection}</GSpherical:ProjectionType>"
        f"<GSpherical:StereoMode>{stereo}</GSpherical:StereoMode></rdf:SphericalVideo>"
    ).encode()


def inject_into_first_trak(data: bytes, child: bytes) -> bytes:
    """Append ``child`` to the first ``trak`` of a real MP4 whose ``moov`` comes last."""
    offset = 0
    while offset < len(data):
        size, kind = struct.unpack(">I4s", data[offset : offset + 8])
        if kind == b"moov":
            assert offset + size == len(data), "moov must be the last box"
            inner = offset + 8
            while inner < offset + size:
                tsize, tkind = struct.unpack(">I4s", data[inner : inner + 8])
                if tkind == b"trak":
                    trak = data[inner : inner + tsize]
                    new_trak = struct.pack(">I", tsize + len(child)) + trak[4:] + child
                    moov = data[offset + 8 : inner] + new_trak + data[inner + tsize : offset + size]
                    return data[:offset] + struct.pack(">I4s", 8 + len(moov), b"moov") + moov
                inner += tsize
        offset += size
    raise AssertionError("no trak")


def mp4(path: Path, width: int, height: int, seconds: float = 2.0, fps: int = 8) -> None:
    import av

    with av.open(str(path), "w", format="mp4") as container:
        stream = container.add_stream("mpeg4", rate=fps)
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        stream.bit_rate = 4_000_000
        for i in range(int(seconds * fps)):
            frame = av.VideoFrame.from_ndarray(textured(height, width, seed=i), format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


# ── Evidence ────────────────────────────────────────────────────────────────


def test_gpano_in_either_rdf_form_is_evidence(tmp_path):
    rgb = textured(64, 128)
    attributes = tmp_path / "a.jpg"
    attributes.write_bytes(jpeg(rgb, GPANO_ATTRIBUTES.format(w=128, h=64, cw=128, ch=64)))
    elements = tmp_path / "e.jpg"
    elements.write_bytes(jpeg(rgb, GPANO_ELEMENTS))
    plain = tmp_path / "p.jpg"
    plain.write_bytes(jpeg(rgb))
    assert photo_evidence(attributes) == ProjectionEvidence("equirectangular", full_sphere=True)
    assert photo_evidence(elements).projection == "equirectangular"
    assert photo_evidence(plain).projection is None


def test_a_cropped_panorama_is_not_a_full_sphere(tmp_path):
    path = tmp_path / "crop.jpg"
    path.write_bytes(jpeg(textured(64, 128), GPANO_ATTRIBUTES.format(w=8000, h=4000, cw=8000, ch=2000)))
    evidence = photo_evidence(path)
    assert evidence.projection == "equirectangular" and not evidence.full_sphere
    with pytest.raises(ProjectionMismatch):
        verify_declaration("equirectangular", evidence)


def test_spherical_video_v2_boxes(tmp_path):
    path = tmp_path / "v2.mp4"
    path.write_bytes(spherical_v2())
    assert video_evidence(path) == ProjectionEvidence("equirectangular", stereo=False)
    path.write_bytes(spherical_v2(stereo=2))
    assert video_evidence(path).stereo
    path.write_bytes(spherical_v2(projection=b"cbmp"))
    assert video_evidence(path).projection == "cubemap"


def test_spherical_video_v1_in_a_real_file(tmp_path):
    path = tmp_path / "v1.mp4"
    mp4(path, 256, 128, seconds=0.5)
    assert video_evidence(path).projection is None
    data = path.read_bytes()
    path.write_bytes(inject_into_first_trak(data, box(b"uuid", bytes.fromhex("ffcc8263f8554a938814587a02521fdd") + spherical_v1_xml())))
    assert video_evidence(path).projection == "equirectangular"
    path.write_bytes(inject_into_first_trak(data, box(b"uuid", bytes.fromhex("ffcc8263f8554a938814587a02521fdd") + spherical_v1_xml(stereo="top-bottom"))))
    assert video_evidence(path).stereo


def test_truncated_or_hostile_boxes_do_not_crash(tmp_path):
    path = tmp_path / "bad.mp4"
    path.write_bytes(struct.pack(">I4s", 0xFFFFFFF0, b"moov") + b"\x00" * 32)
    assert video_evidence(path).projection is None
    path.write_bytes(b"\x00\x00\x00\x01moov" + struct.pack(">Q", 4))
    assert video_evidence(path).projection is None


def test_the_claim_alone_never_decides():
    none = ProjectionEvidence(None)
    equirect = ProjectionEvidence("equirectangular")
    assert verify_declaration("equirectangular", equirect) == "equirectangular"
    assert verify_declaration("perspective", none) == "perspective"
    # A phone panorama is not a 360° capture, and is still processed as before.
    assert verify_declaration("perspective", ProjectionEvidence("cylindrical")) == "perspective"
    for declared, evidence in (
        ("equirectangular", none),  # declared 360°, the bytes do not say so
        ("perspective", equirect),  # the bytes say 360°, the declaration does not
        ("perspective", ProjectionEvidence("cubemap")),
        ("equirectangular", ProjectionEvidence("cubemap")),
        ("equirectangular", ProjectionEvidence("equirectangular", stereo=True)),
        ("equirectangular", ProjectionEvidence("conflicting")),
    ):
        with pytest.raises(ProjectionMismatch):
            verify_declaration(declared, evidence)


def test_pixels_must_be_two_to_one():
    assert is_two_to_one(5760, 2880) and is_two_to_one(3840, 1921) and not is_two_to_one(3840, 2160)
    verify_frame("equirectangular", 4096, 2048)
    verify_frame("perspective", 4000, 3000)
    with pytest.raises(ProjectionMismatch):
        verify_frame("equirectangular", 4000, 3000)


# ── Views ───────────────────────────────────────────────────────────────────


def direction_panorama(h: int = 512, w: int = 1024) -> np.ndarray:
    """An equirectangular image whose pixels hold their own longitude and latitude."""
    v, u = np.meshgrid(np.arange(h) + 0.5, np.arange(w) + 0.5, indexing="ij")
    lon = (u / w - 0.5) * 360.0
    lat = (0.5 - v / h) * 180.0
    return np.stack([np.cos(np.radians(lon)), np.sin(np.radians(lon)), lat], -1).astype(np.float32)


def test_views_look_where_their_yaw_says():
    cutter = ViewCutter(width=320, height=240)
    views = cutter.cut(direction_panorama())
    assert [v.yaw_degrees for v in views] == [0, 45, 90, 135, 180, 225, 270, 315]
    for view in views:
        c = view.rgb[120, 160]
        assert abs((math.degrees(math.atan2(c[1], c[0])) - view.yaw_degrees + 180) % 360 - 180) < 1.0
        assert abs(c[2]) < 0.5
        # The right edge is half a field of view to the right, at the horizon.
        r = view.rgb[120, 319]
        assert abs((math.degrees(math.atan2(r[1], r[0])) - view.yaw_degrees - 45 + 180) % 360 - 180) < 1.0


def test_neighbouring_views_overlap_by_half():
    cutter = ViewCutter(width=320, height=240)
    seen = np.zeros(360, int)
    for view in cutter.cut(direction_panorama()):
        row = view.rgb[120]
        lons = np.degrees(np.arctan2(row[:, 1], row[:, 0])) % 360
        seen[np.unique(lons.astype(int) % 360)] += 1
    assert seen.min() >= 2  # every direction at the horizon is in at least two views


def test_cam_from_pano_matches_the_cut():
    cutter = ViewCutter(width=320, height=240)
    f = focal_pixels(320)
    view = cutter.cut(direction_panorama())[3]
    x, y = 300, 40
    ray = np.array([x + 0.5 - 160, y + 0.5 - 120, f])
    pano = cam_from_pano(view.yaw_degrees).T @ (ray / np.linalg.norm(ray))
    lon, lat = math.degrees(math.atan2(pano[0], pano[2])), math.degrees(math.asin(-pano[1]))
    c = view.rgb[y, x]
    assert abs(math.degrees(math.atan2(c[1], c[0])) - lon) < 1.0 and abs(c[2] - lat) < 1.0


def test_the_nadir_is_masked_and_nothing_above_it():
    cutter = ViewCutter(width=320, height=240)
    view = cutter.cut(direction_panorama())[0]
    lat = view.rgb[..., 2]
    assert view.nadir.any() and not view.nadir[:120].any()
    clear = np.abs(lat + NADIR_MASK_DEGREES) > 1.0
    assert (view.nadir[clear] == (lat[clear] < -NADIR_MASK_DEGREES)).all()


# ── The privacy job, fail-closed ────────────────────────────────────────────


class FakeAws:
    def __init__(self, source: Path) -> None:
        self.source = source
        self.objects: dict[str, bytes] = {}

    def download(self, key, dest, sha256=None, byte_size=None):  # noqa: ANN001
        dest.write_bytes(self.source.read_bytes())

    def put(self, key, data, content_type):  # noqa: ANN001
        self.objects[key] = data
        return hashlib.sha256(data).hexdigest(), len(data)


class FakeDetectors:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.calls = 0

    def detect(self, rgb):  # noqa: ANN001
        self.calls += 1
        if self.fail:
            raise RuntimeError("detector unavailable")
        h, w = rgb.shape[:2]
        empty = np.zeros((h, w), bool)
        return FrameDetections(faces=[(10, 10, 20, 20)], plates=[], people=empty, vehicles=empty.copy(), people_count=0, vehicle_count=0, vehicle_boxes=[])


@pytest.fixture
def small_views(monkeypatch):
    monkeypatch.setattr(privacy_job, "ViewCutter", lambda: ViewCutter(width=256, height=192))
    monkeypatch.setattr(privacy_job, "PANORAMA_LONG_EDGE", 1024)


def privacy_job_for(path: Path, *, kind: str, projection: str) -> CapturePrivacyJob:
    raw = json.loads((FIXTURES / "job.capture_privacy.json").read_text())
    data = path.read_bytes()
    raw["mediaKind"] = kind
    raw["projection"] = projection
    raw["input"] |= {"byteSize": len(data), "sha256": hashlib.sha256(data).hexdigest(), "contentType": "video/mp4" if kind == "video" else "image/jpeg"}
    return CapturePrivacyJob.model_validate(raw)


def run_job(tmp_path: Path, source: Path, *, kind: str = "photo", projection: str = "equirectangular", fail: bool = False):
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    aws = FakeAws(source)
    detectors = FakeDetectors(fail=fail)
    try:
        result = privacy_job.run(privacy_job_for(source, kind=kind, projection=projection), JobContext("j", 1), aws, detectors, work)
    finally:
        assert not (work / "raw").exists(), "the raw file outlived the job"
    return result, aws, detectors


def test_a_360_photo_becomes_eight_masked_views(tmp_path, small_views):
    source = tmp_path / "pano.jpg"
    source.write_bytes(jpeg(textured(512, 1024), GPANO_ELEMENTS))
    result, aws, detectors = run_job(tmp_path, source)
    assert result.verdict == "passed" and result.projection == "equirectangular"
    assert detectors.calls == 8 and len(result.frames) == 8
    assert [(f.panorama.index, f.panorama.yawDegrees, f.panorama.horizontalFovDegrees) for f in result.frames] == [
        (0, k * 45.0, 90.0) for k in range(8)
    ]
    for frame in result.frames:
        assert (frame.width, frame.height) == (256, 192)
        mask = np.asarray(Image.open(io.BytesIO(aws.objects[frame.maskKey])))
        assert (mask[-1, 128] == 0) and (mask[0, 128] == 255)  # nadir excluded, sky kept
        assert (mask[15:25, 15:25] == 0).all()  # the detected face too
        assert frame.maskedFraction > 0


def test_a_360_video_cuts_every_keyframe(tmp_path, small_views):
    source = tmp_path / "pano.mp4"
    mp4(source, 1024, 512, seconds=2.0)
    uuid = bytes.fromhex("ffcc8263f8554a938814587a02521fdd")
    source.write_bytes(inject_into_first_trak(source.read_bytes(), box(b"uuid", uuid + spherical_v1_xml())))
    result, _aws, _detectors = run_job(tmp_path, source, kind="video")
    indexes = sorted({f.panorama.index for f in result.frames})
    assert indexes == [0, 1, 2, 3]  # one panorama per 0.5 s window
    for index in indexes:
        views = [f for f in result.frames if f.panorama.index == index]
        assert len(views) == 8 and len({f.timestampSeconds for f in views}) == 1


@pytest.mark.parametrize(
    ("name", "projection", "content"),
    [
        ("declared 360 without metadata", "equirectangular", lambda: jpeg(textured(512, 1024))),
        ("metadata says 360, declared perspective", "perspective", lambda: jpeg(textured(512, 1024), GPANO_ELEMENTS)),
        ("metadata says 360 but the pixels are not 2:1", "equirectangular", lambda: jpeg(textured(600, 1000), GPANO_ELEMENTS)),
    ],
)
def test_projection_disagreement_fails_closed(tmp_path, small_views, name, projection, content):
    source = tmp_path / "x.jpg"
    source.write_bytes(content())
    with pytest.raises(JobFailure) as failure:
        run_job(tmp_path, source, projection=projection)
    assert failure.value.code == "privacy_failed", name


def test_declared_360_video_without_spherical_metadata_fails_closed(tmp_path, small_views):
    source = tmp_path / "flat.mp4"
    mp4(source, 1024, 512, seconds=0.5)
    with pytest.raises(JobFailure) as failure:
        run_job(tmp_path, source, kind="video")
    assert failure.value.code == "privacy_failed"


def test_a_detector_failure_on_any_view_fails_closed(tmp_path, small_views):
    source = tmp_path / "pano.jpg"
    source.write_bytes(jpeg(textured(512, 1024), GPANO_ELEMENTS))
    with pytest.raises(JobFailure) as failure:
        run_job(tmp_path, source, fail=True)
    assert failure.value.code == "privacy_failed"


def test_a_perspective_photo_is_unchanged(tmp_path):
    source = tmp_path / "street.jpg"
    source.write_bytes(jpeg(textured(480, 640)))
    result, _aws, detectors = run_job(tmp_path, source, projection="perspective")
    assert result.projection == "perspective" and detectors.calls == 1
    assert len(result.frames) == 1 and result.frames[0].panorama is None
