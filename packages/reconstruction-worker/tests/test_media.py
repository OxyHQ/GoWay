"""Decoding: colour into sRGB, HEIC, and keyframes over a video's whole length.

Every derivative must stay free of metadata — colour is converted INTO the
pixels, never carried as a profile.
"""

import io
import struct
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from goway_reconstruction.contract import KeyframePolicy
from goway_reconstruction.privacy.detectors import FrameDetections
from goway_reconstruction.privacy.media import (
    choose_keyframes,
    decode_photo,
    decode_video_keyframes,
    frame_rgb,
    hdr_to_srgb,
    hlg_to_nits,
    plan_video_keyframes,
    pq_to_nits,
)
from goway_reconstruction.privacy.redact import assert_no_metadata, redact

POLICY = KeyframePolicy(maxFrames=1, minIntervalSeconds=1, maxLongEdgePixels=4096)


def s15(value: float) -> bytes:
    return struct.pack(">i", round(value * 65536))


def matrix_trc_profile(red, green, blue, description: str = "Test P3") -> bytes:
    """A minimal ICC v2 RGB display profile: D50-adapted colorants and the sRGB tone curve."""
    def xyz(v):
        return b"XYZ " + bytes(4) + b"".join(s15(c) for c in v)

    curve = b"para" + bytes(4) + struct.pack(">HH", 3, 0) + b"".join(s15(c) for c in (2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045))
    text = description.encode() + b"\x00"
    desc = b"desc" + bytes(4) + struct.pack(">I", len(text)) + text + bytes(4) + bytes(4) + bytes(2) + bytes(1) + bytes(67)
    tags = [(b"desc", desc), (b"wtpt", xyz((0.9642, 1.0, 0.8249))), (b"rXYZ", xyz(red)), (b"gXYZ", xyz(green)), (b"bXYZ", xyz(blue))]
    tags += [(b"rTRC", curve), (b"gTRC", curve), (b"bTRC", curve)]
    offset = 128 + 4 + 12 * len(tags)
    table, data = b"", b""
    for signature, body in tags:
        body += bytes(-len(body) % 4)
        table += signature + struct.pack(">II", offset + len(data), len(body))
        data += body
    size = offset + len(data)
    header = struct.pack(">I", size) + bytes(4) + struct.pack(">I", 0x02100000) + b"mntrRGB XYZ " + bytes(12) + b"acsp"
    header += bytes(24) + struct.pack(">I", 0) + s15(0.9642) + s15(1.0) + s15(0.8249)
    header += bytes(128 - len(header))
    return header + struct.pack(">I", len(tags)) + table + data


DISPLAY_P3 = matrix_trc_profile((0.515102, 0.241196, -0.001053), (0.291965, 0.692245, 0.041885), (0.157153, 0.066561, 0.784060))


def p3_photo(tmp_path: Path, rgb, suffix: str = ".jpg", fmt: str = "JPEG") -> Path:
    exif = Image.Exif()
    exif[0x010F] = "SomeMake"
    exif[0x8825] = {2: (48.0, 52.0, 0.0), 4: (2.0, 17.0, 0.0)}  # GPS latitude, longitude
    path = tmp_path / f"p3{suffix}"
    Image.fromarray(rgb).save(path, format=fmt, icc_profile=DISPLAY_P3, exif=exif, quality=95)
    return path


def patches() -> np.ndarray:
    rgb = np.zeros((320, 480, 3), np.uint8)
    rgb[:, :160] = (200, 60, 40)  # a red the P3 gamut holds and sRGB barely does
    rgb[:, 160:320] = (128, 128, 128)
    rgb[:, 320:] = (60, 170, 90)
    return rgb


def empty_detections(h: int, w: int) -> FrameDetections:
    nothing = np.zeros((h, w), bool)
    return FrameDetections(faces=[], plates=[], people=nothing, vehicles=nothing.copy(), people_count=0, vehicle_count=0, vehicle_boxes=[])


def test_a_display_p3_photo_is_converted_to_srgb(tmp_path):
    rgb = decode_photo(p3_photo(tmp_path, patches()), POLICY)[0].rgb
    red, grey, green = rgb[160, 80].astype(int), rgb[160, 240].astype(int), rgb[160, 400].astype(int)
    # Read as sRGB, a P3 colour is dull; converted (P3 → sRGB matrix on linear
    # light, worked by hand), it is as saturated as it was shot.
    assert np.abs(red - (218, 42, 23)).max() <= 3
    assert np.abs(green - (0, 173, 79)).max() <= 3
    assert np.abs(grey - 128).max() <= 2  # neutrals are untouched


def test_derivatives_carry_no_exif_gps_or_icc(tmp_path):
    frame = decode_photo(p3_photo(tmp_path, patches()), POLICY)[0]
    out = redact(frame.rgb, empty_detections(*frame.rgb.shape[:2]))
    assert_no_metadata(out.jpeg)
    for marker in (b"ICC_PROFILE", b"Exif", b"SomeMake", b"GPS", b"Test P3"):
        assert marker not in out.jpeg
    with Image.open(io.BytesIO(out.jpeg)) as image:
        assert "icc_profile" not in image.info and not image.getexif()


def test_an_unusable_profile_is_ignored_not_fatal(tmp_path):
    path = tmp_path / "broken.jpg"
    Image.fromarray(patches()).save(path, icc_profile=b"not a profile at all" * 10)
    rgb = decode_photo(path, POLICY)[0].rgb
    assert np.abs(rgb[160, 240].astype(int) - 128).max() <= 2


def test_heic_decodes_with_its_profile_and_leaves_no_metadata(tmp_path):
    path = p3_photo(tmp_path, patches(), suffix=".heic", fmt="HEIF")
    assert path.read_bytes()[4:12] in (b"ftypheic", b"ftypmif1")
    frame = decode_photo(path, POLICY)[0]
    assert frame.rgb.shape == (320, 480, 3)
    assert frame.rgb[160, 80, 0] >= 210  # the P3 profile was applied
    out = redact(frame.rgb, empty_detections(320, 480))
    assert_no_metadata(out.jpeg)
    assert b"SomeMake" not in out.jpeg


# ── Keyframes ───────────────────────────────────────────────────────────────


def video(path: Path, seconds: float, fps: int = 4, size=(160, 96), sharp_at=()) -> Path:
    import av

    rng = np.random.default_rng(0)
    with av.open(str(path), "w", format="mp4") as container:
        stream = container.add_stream("mpeg4", rate=fps)
        stream.width, stream.height, stream.pix_fmt = size[0], size[1], "yuv420p"
        stream.bit_rate = 2_000_000
        for i in range(int(seconds * fps)):
            noise = rng.integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
            if i not in sharp_at:
                noise = (noise // 8 + 112).astype(np.uint8)  # low contrast: a "blurred" frame
            for packet in stream.encode(av.VideoFrame.from_ndarray(noise, format="rgb24")):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return path


def test_keyframes_tile_the_whole_recording(tmp_path):
    # A 60 s walk with a budget of 6 keyframes: one per 10 s window, the last
    # minute included — not the first 3 s at the minimum spacing.
    path = video(tmp_path / "walk.mp4", 60.0, fps=2)
    picks = plan_video_keyframes(path, KeyframePolicy(maxFrames=6, minIntervalSeconds=0.5, maxLongEdgePixels=4096))
    times = [t for t, _ in picks]
    window = 59.5 / 6  # frames at 0 … 59.5 s
    assert [int(t // window) for t in times] == [0, 1, 2, 3, 4, 5]


def test_the_budget_grows_with_length_and_picks_the_sharpest():
    policy = KeyframePolicy(maxFrames=240, minIntervalSeconds=0.5, maxLongEdgePixels=4096)
    short = [(i / 8, 1.0) for i in range(16)]  # 2 s at 8 fps
    assert len(choose_keyframes(short, policy)) == 4
    long = [(i / 8, float(i % 5)) for i in range(8 * 600)]  # 10 minutes
    picks = choose_keyframes(long, policy)
    assert len(picks) == 240 and picks[-1][0] > 597
    assert all(score == 4.0 for _, score in picks)  # the sharpest of each window


def test_streamed_keyframes_are_the_chosen_frames(tmp_path):
    path = video(tmp_path / "v.mp4", 4.0, sharp_at={3, 9})
    picks = plan_video_keyframes(path, KeyframePolicy(maxFrames=2, minIntervalSeconds=0.5, maxLongEdgePixels=4096))
    assert [t for t, _ in picks] == [0.75, 2.25]  # frames 3 and 9: the sharp ones
    frames = list(decode_video_keyframes(path, picks, long_edge=80))
    assert [f.timestamp_seconds for f in frames] == [0.75, 2.25]
    assert frames[0].rgb.shape == (48, 80, 3)  # scaled in the same pass as the colour conversion


# ── Video colour ────────────────────────────────────────────────────────────


def tagged_video(path: Path, rgb_value, *, size, codec="libx264", pix="yuv420p", matrix=1, trc=1, primaries=1, tag=True, options=None) -> Path:
    import av
    from av.video.reformatter import ColorRange, Interpolation

    w, h = size
    with av.open(str(path), "w", format="mp4") as container:
        stream = container.add_stream(codec, rate=4, options=options or {})
        stream.width, stream.height, stream.pix_fmt = w, h, pix
        if tag:
            ctx = stream.codec_context
            ctx.colorspace, ctx.color_range, ctx.color_primaries, ctx.color_trc = matrix, 1, primaries, trc
        rgb = np.zeros((h, w, 3), np.uint8)
        rgb[:] = rgb_value
        for i in range(2):
            frame = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(
                format=pix, src_colorspace=matrix, dst_colorspace=matrix, src_color_range=ColorRange.JPEG,
                dst_color_range=ColorRange.MPEG, interpolation=Interpolation.BILINEAR | Interpolation.ACCURATE_RND,
            )
            frame.pts = i
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return path


def first_frame(path: Path):
    import av

    container = av.open(str(path))
    return container, next(container.decode(video=0))


@pytest.mark.parametrize("tag", [True, False])
def test_hd_video_colour_follows_its_signalling(tmp_path, tag):
    # BT.709, limited range — tagged, or untagged at HD size (FFmpeg alone would
    # decode it as BT.601 and full range: greens 25 levels too bright).
    path = tagged_video(tmp_path / "hd.mp4", (40, 200, 60), size=(1280, 720), options={"crf": "0"}, tag=tag)
    container, frame = first_frame(path)
    with container:
        assert np.abs(frame_rgb(frame, 4096)[360, 640].astype(int) - (40, 200, 60)).max() <= 2


@pytest.mark.parametrize(("trc", "signal"), [(18, 0.75), (16, None)])
def test_hdr_video_is_tone_mapped_to_srgb(tmp_path, trc, signal):
    # Reference white (HLG 75 %, PQ 203 cd/m²) becomes near-white sRGB, not the
    # grey a naive 8-bit read gives.
    if signal is None:
        m1, m2, c1, c2, c3 = 2610 / 16384, 2523 / 4096 * 128, 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
        y = (203 / 10000) ** m1
        signal = ((c1 + c2 * y) / (1 + c3 * y)) ** m2
    level = round(signal * 255)
    path = tagged_video(
        tmp_path / "hdr.mp4", (level, level, level), size=(320, 256), codec="libx265", pix="yuv420p10le",
        matrix=9, trc=trc, primaries=9, options={"x265-params": "log-level=error:lossless=1:bframes=0:frame-threads=1"},
    )
    container, frame = first_frame(path)
    with container:
        assert frame.color_trc == trc
        out = frame_rgb(frame, 4096)[128, 160].astype(int)
        naive = frame.to_ndarray(format="rgb24")[128, 160].astype(int)
    assert out.min() >= 235 and out.max() - out.min() <= 2  # near white, still neutral
    assert naive.max() < 200


def test_hdr_tone_mapping_curve():
    assert pq_to_nits(np.array([0.0, 1.0])) == pytest.approx([0.0, 10000.0])
    white = hlg_to_nits(np.full((1, 1, 3), 0.75, np.float32))
    assert 195 < float(white[0, 0, 0]) < 225  # BT.2408: HLG 75 % is ~203 cd/m² on a 1000 cd/m² display
    ramp = np.linspace(0, 1, 64, dtype=np.float32)
    grey = np.repeat(ramp[None, :, None], 3, axis=2)
    for transfer in (16, 18):
        out = hdr_to_srgb(grey, transfer, 9)[0, :, 0].astype(int)
        assert out[0] == 0 and out[-1] == 255
        assert (np.diff(out) >= 0).all()  # monotonic: no banding inversions
    red = hdr_to_srgb(np.array([[[0.6, 0.2, 0.2]]], np.float32), 18, 9)[0, 0]
    assert red[0] > red[1] and red[0] > red[2]  # hue survives the gamut and tone mapping
