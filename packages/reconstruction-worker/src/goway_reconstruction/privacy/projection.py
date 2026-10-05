"""Deciding whether contributed media is a full 360° equirectangular panorama.

The contributor's app DECLARES a projection; it does not decide one. A wrong
projection is a privacy problem, not only a quality one: an equirectangular
frame run through the perspective path is detected at a distortion the
detectors were never tuned for, and a perspective frame cut as a panorama
produces views of pixels that do not exist. So the projection the privacy job
uses is the one three independent things agree on:

1. the declaration in the job (the client's claim),
2. projection metadata GoWay reads out of the stored bytes itself — XMP
   ``GPano:ProjectionType`` for a photo, Spherical Video V1 (the ``uuid`` box)
   or V2 (``sv3d``/``proj``/``equi``) for a video, and
3. the decoded pixels: a full sphere stored equirectangularly is exactly 2:1.

Any disagreement fails the job closed (``privacy_failed``). A declared
panorama with no metadata, a partial (cropped) panorama, a stereo or cubemap
projection, a frame that is not 2:1, or media whose own metadata says it is a
360° capture while the declaration says it is not — none of them is guessed at.

Reading is bounded: XMP is searched for in a capped prefix of the file, and the
MP4 walk reads box headers with seeks, never the media data.
"""

from __future__ import annotations

import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Projection = Literal["perspective", "equirectangular"]

# How far into a photo XMP is searched for. JPEG keeps it in APP1 near the
# start; HEIC and PNG may put it later, so the whole of a policy-sized photo is
# read, but never more than this.
MAX_XMP_SCAN_BYTES = 96 * 1024 * 1024
# A 2:1 frame within this relative tolerance (an encoder may round one side).
ASPECT_TOLERANCE = 0.01

SPHERICAL_V1_UUID = bytes.fromhex("ffcc8263f8554a938814587a02521fdd")
_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"udta", b"sv3d", b"proj"}
# Visual sample entries carry 78 bytes of fields before their child boxes.
_VISUAL_SAMPLE_ENTRY_HEADER = 78
_MAX_BOXES = 10_000
_MAX_DEPTH = 12


class ProjectionMismatch(ValueError):
    """The declared projection, the media's metadata and its pixels do not agree."""


@dataclass(frozen=True)
class ProjectionEvidence:
    """What the stored bytes themselves say about their projection.

    ``projection`` is ``None`` when the media carries no 360° metadata at all.
    Otherwise it is the projection named there, lower-cased — which may be one
    GoWay does not accept (``cubemap``, ``mesh``, ``cylindrical``).
    """

    projection: str | None
    full_sphere: bool = True
    stereo: bool = False

    @property
    def spherical(self) -> bool:
        """Whether the media itself claims to be a 360° capture of any kind."""
        return self.projection in {"equirectangular", "cubemap", "mesh", "equi-angular cubemap"}


# ── Photos: XMP GPano ──────────────────────────────────────────────────────

_XMP_PACKET = re.compile(rb"<x:xmpmeta[\s>].*?</x:xmpmeta>", re.DOTALL)


def _gpano(xmp: str, name: str) -> str | None:
    """A GPano property in either RDF form: ``GPano:X="v"`` or ``<GPano:X>v</GPano:X>``."""
    match = re.search(rf'GPano:{name}\s*=\s*"([^"]*)"', xmp) or re.search(rf"<GPano:{name}>\s*([^<]*?)\s*</GPano:{name}>", xmp)
    return match.group(1).strip() if match else None


def _int(value: str | None) -> int | None:
    try:
        return int(float(value)) if value is not None else None
    except ValueError:
        return None


def photo_evidence(path: Path) -> ProjectionEvidence:
    with path.open("rb") as handle:
        data = handle.read(MAX_XMP_SCAN_BYTES)
    projection: str | None = None
    full_sphere = True
    for packet in _XMP_PACKET.finditer(data):
        xmp = packet.group(0).decode("utf-8", errors="replace")
        value = _gpano(xmp, "ProjectionType")
        if value is None:
            continue
        if projection is not None and value.lower() != projection:
            # Two packets naming two projections: nothing here can be believed.
            return ProjectionEvidence(projection="conflicting", full_sphere=False)
        projection = value.lower()
        full_w, full_h = _int(_gpano(xmp, "FullPanoWidthPixels")), _int(_gpano(xmp, "FullPanoHeightPixels"))
        crop_w, crop_h = _int(_gpano(xmp, "CroppedAreaImageWidthPixels")), _int(_gpano(xmp, "CroppedAreaImageHeightPixels"))
        left, top = _int(_gpano(xmp, "CroppedAreaLeftPixels")) or 0, _int(_gpano(xmp, "CroppedAreaTopPixels")) or 0
        if None not in (full_w, full_h, crop_w, crop_h) and (crop_w != full_w or crop_h != full_h or left or top):
            full_sphere = False
    return ProjectionEvidence(projection=projection, full_sphere=full_sphere)


# ── Videos: Spherical Video V1 and V2 ──────────────────────────────────────


@dataclass
class _VideoFindings:
    projection: str | None = None
    stereo: bool = False
    boxes: int = 0


def _boxes(handle, start: int, end: int):  # noqa: ANN001 - a binary file
    """Yield (type, payload_start, box_end) for the boxes in [start, end)."""
    offset = start
    while offset + 8 <= end:
        handle.seek(offset)
        header = handle.read(16)
        if len(header) < 8:
            return
        size, kind = struct.unpack(">I4s", header[:8])
        payload = offset + 8
        if size == 1:
            if len(header) < 16:
                return
            size = struct.unpack(">Q", header[8:16])[0]
            payload = offset + 16
        elif size == 0:
            size = end - offset
        if size < payload - offset or offset + size > end:
            return
        yield kind, payload, offset + size
        offset += size


def _walk(handle, start: int, end: int, depth: int, found: _VideoFindings) -> None:  # noqa: ANN001
    if depth > _MAX_DEPTH:
        return
    for kind, payload, box_end in _boxes(handle, start, end):
        found.boxes += 1
        if found.boxes > _MAX_BOXES:
            return
        if kind == b"uuid":
            handle.seek(payload)
            if handle.read(16) == SPHERICAL_V1_UUID:
                xml = handle.read(min(box_end - payload - 16, 64 * 1024)).decode("utf-8", errors="replace")
                spherical = re.search(r"<GSpherical:Spherical>\s*true\s*</GSpherical:Spherical>", xml, re.I)
                kind_match = re.search(r"<GSpherical:ProjectionType>\s*([^<]*?)\s*</GSpherical:ProjectionType>", xml)
                if spherical and kind_match:
                    found.projection = _merge(found.projection, kind_match.group(1).lower())
                stereo = re.search(r"<GSpherical:StereoMode>\s*([^<]*?)\s*</GSpherical:StereoMode>", xml)
                if stereo and stereo.group(1).strip().lower() not in {"", "mono"}:
                    found.stereo = True
        elif kind == b"st3d":
            handle.seek(payload + 4)  # full box: version and flags
            mode = handle.read(1)
            if mode and mode[0] != 0:
                found.stereo = True
        elif kind in {b"equi", b"cbmp", b"mshp"}:
            name = {b"equi": "equirectangular", b"cbmp": "cubemap", b"mshp": "mesh"}[kind]
            found.projection = _merge(found.projection, name)
        elif kind == b"stsd":
            # Full box (4) + entry count (4), then sample entries.
            _walk(handle, payload + 8, box_end, depth + 1, found)
        elif kind in {b"avc1", b"avc3", b"hvc1", b"hev1", b"av01", b"vp09", b"mp4v"}:
            _walk(handle, payload + _VISUAL_SAMPLE_ENTRY_HEADER, box_end, depth + 1, found)
        elif kind in _CONTAINERS:
            _walk(handle, payload, box_end, depth + 1, found)


def _merge(current: str | None, new: str) -> str:
    return new if current in (None, new) else "conflicting"


def video_evidence(path: Path) -> ProjectionEvidence:
    found = _VideoFindings()
    with path.open("rb") as handle:
        handle.seek(0, 2)
        size = handle.tell()
        _walk(handle, 0, size, 0, found)
    return ProjectionEvidence(projection=found.projection, stereo=found.stereo)


def media_evidence(path: Path, media_kind: Literal["photo", "video"]) -> ProjectionEvidence:
    return photo_evidence(path) if media_kind == "photo" else video_evidence(path)


# ── The decision ───────────────────────────────────────────────────────────


def is_two_to_one(width: int, height: int) -> bool:
    return height > 0 and abs(width - 2 * height) <= max(2, ASPECT_TOLERANCE * width)


def verify_declaration(declared: Projection, evidence: ProjectionEvidence) -> Projection:
    """Check the declaration against the media's own metadata, before decoding.

    Raises :class:`ProjectionMismatch` unless both agree.
    """
    if declared == "equirectangular":
        if evidence.projection != "equirectangular":
            raise ProjectionMismatch("declared 360° media carries no equirectangular projection metadata")
        if not evidence.full_sphere:
            raise ProjectionMismatch("the panorama is not a full sphere")
        if evidence.stereo:
            raise ProjectionMismatch("stereoscopic 360° media is not accepted")
        return "equirectangular"
    if evidence.spherical or evidence.projection == "conflicting":
        raise ProjectionMismatch("the media's own metadata marks it as 360° but it was declared perspective")
    return "perspective"


def verify_frame(projection: Projection, width: int, height: int) -> None:
    """Check decoded pixels against a verified projection. Raises :class:`ProjectionMismatch`."""
    if projection == "equirectangular" and not is_two_to_one(width, height):
        raise ProjectionMismatch("a 360° frame is not 2:1")
