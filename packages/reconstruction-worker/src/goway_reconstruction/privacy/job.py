"""The ``capture_privacy`` job: raw media in, privacy-safe derivatives out.

Fail closed, end to end. The raw object is verified against the digest the
backend recorded at finalize; any decoder, detector or encoder error fails the
job; a frame is reported only after its derivative and mask are uploaded with an
S3-verified checksum. The raw file is deleted from scratch with the job and is
never cached.

A capture declared as a 360° panorama is processed only once its own metadata
and its pixels confirm the declaration (``projection.py``). Each panorama — the
photo, or each video keyframe — is then cut into overlapping perspective views
(``panorama.py``), and every view goes through detection, redaction and masking
on its own, with the nadir always masked. A view is a derivative like any other
frame, plus the panorama it came from and where it looks (yaw and pitch).

Blur is judged per panorama, not per view: a view of plain sky or a bare wall
has almost no edges, and rejecting it as blurred would cut holes in the
sphere. A panorama is rejected whole when even its sharpest view is blurred.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .. import PRIVACY_PIPELINE_VERSION
from ..aws import Aws
from ..context import JobContext, JobFailure
from ..contract import CapturePrivacyJob, CapturePrivacyResult, Detections, ModelRef, PanoramaView, PrivacyFrame
from ..models import PRIVACY_MODELS
from .detectors import PrivacyDetectors
from .media import CorruptMediaError, decode_photo, decode_video_keyframes, plan_video_keyframes, sharpness
from .panorama import PANORAMA_MAX_LONG_EDGE, ViewCutter
from .projection import ProjectionMismatch, media_evidence, verify_declaration, verify_frame
from .redact import MAX_MASKED_FRACTION, MIN_SHARPNESS, MetadataSurvivedError, redact


class _Deriver:
    """Detect, redact, upload: one image in, at most one derivative out."""

    def __init__(self, job: CapturePrivacyJob, aws: Aws, detectors: PrivacyDetectors) -> None:
        self.job, self.aws, self.detectors = job, aws, detectors
        self.frames: list[PrivacyFrame] = []
        self.rejected = 0

    def add(
        self,
        rgb: np.ndarray,
        frame_sharpness: float,
        timestamp: float | None,
        *,
        always: np.ndarray | None = None,
        panorama: PanoramaView | None = None,
        sharpness_gated: bool = True,
    ) -> None:
        if sharpness_gated and frame_sharpness < MIN_SHARPNESS:
            self.rejected += 1
            return
        try:
            detections = self.detectors.detect(rgb)
            redacted = redact(rgb, detections, always=always)
        except MetadataSurvivedError as error:
            raise JobFailure("privacy_failed", "metadata survived re-encoding") from error
        except Exception as error:  # noqa: BLE001 - any detector failure closes the gate
            if "out of memory" in str(error).lower():
                raise JobFailure("out_of_memory", "detector ran out of GPU memory") from error
            raise JobFailure("privacy_failed", "a privacy detector failed") from error
        if redacted.masked_fraction > MAX_MASKED_FRACTION:
            self.rejected += 1
            return
        index = len(self.frames)
        stem = f"{self.job.outputPrefix}{index:06d}"
        image_sha, image_size = self.aws.put(f"{stem}.jpg", redacted.jpeg, "image/jpeg")
        mask_sha, mask_size = self.aws.put(f"{stem}.mask.png", redacted.mask_png, "image/png")
        self.frames.append(
            PrivacyFrame(
                frameIndex=index,
                imageKey=f"{stem}.jpg",
                imageSha256=image_sha,
                imageByteSize=image_size,
                maskKey=f"{stem}.mask.png",
                maskSha256=mask_sha,
                maskByteSize=mask_size,
                width=redacted.width,
                height=redacted.height,
                detections=Detections(
                    faces=len(detections.faces),
                    plates=len(detections.plates),
                    people=detections.people_count,
                    vehicles=detections.vehicle_count,
                ),
                maskedFraction=round(redacted.masked_fraction, 4),
                sharpness=round(frame_sharpness, 2),
                timestampSeconds=timestamp,
                panorama=panorama,
            )
        )


def run(job: CapturePrivacyJob, ctx: JobContext, aws: Aws, detectors: PrivacyDetectors, work: Path) -> CapturePrivacyResult:
    ctx.enter("preparing")
    raw = work / "raw"
    try:
        aws.download(job.input.key, raw, sha256=job.input.sha256, byte_size=job.input.byteSize)
    except Exception as error:  # noqa: BLE001
        raise JobFailure("corrupt_input", "raw object missing or not the finalized bytes") from error

    ctx.enter("privacy")
    deriver = _Deriver(job, aws, detectors)
    try:
        try:
            projection = verify_declaration(job.projection, media_evidence(raw, job.mediaKind))
        except ProjectionMismatch as error:
            raise JobFailure("privacy_failed", str(error)) from error
        except OSError as error:
            raise JobFailure("corrupt_input", "media metadata could not be read") from error
        if projection == "equirectangular":
            _panoramas(job, ctx, raw, deriver)
        else:
            _perspective(job, ctx, raw, deriver)
    except CorruptMediaError as error:
        raise JobFailure("corrupt_input", str(error)) from error
    finally:
        raw.unlink(missing_ok=True)
    ctx.report(1.0)

    if not deriver.frames:
        raise JobFailure("corrupt_input", "no usable frame after privacy processing")
    return CapturePrivacyResult(
        jobId=job.jobId,
        attempt=ctx.attempt,
        assetId=job.assetId,
        verdict="passed",
        privacyPipelineVersion=PRIVACY_PIPELINE_VERSION,
        projection=projection,
        models=[ModelRef(name=m.name, version=m.version, sha256=m.sha256) for m in PRIVACY_MODELS],
        metadataStripped=True,
        frames=deriver.frames,
        rejectedFrames=deriver.rejected,
    )


def _decoded(job: CapturePrivacyJob, raw: Path, long_edge: int):  # noqa: ANN202 - (count, iterator of DecodedFrame)
    if job.mediaKind == "photo":
        frames = decode_photo(raw, job.keyframes, long_edge=long_edge)
        raw.unlink(missing_ok=True)  # decoded: the raw bytes go now, not with the job
        return len(frames), iter(frames)
    # Streamed: the raw file stays on disk until the last keyframe is decoded.
    picks = plan_video_keyframes(raw, job.keyframes)
    return len(picks), decode_video_keyframes(raw, picks, long_edge=long_edge)


def _perspective(job: CapturePrivacyJob, ctx: JobContext, raw: Path, deriver: _Deriver) -> None:
    total, frames = _decoded(job, raw, job.keyframes.maxLongEdgePixels)
    for index, frame in enumerate(frames):
        ctx.report(min(index / total, 0.99))
        deriver.add(frame.rgb, frame.sharpness, frame.timestamp_seconds)


def _panoramas(job: CapturePrivacyJob, ctx: JobContext, raw: Path, deriver: _Deriver) -> None:
    cutter = ViewCutter()
    total, panoramas = _decoded(job, raw, PANORAMA_MAX_LONG_EDGE)
    for index, pano in enumerate(panoramas):
        ctx.report(min(index / total, 0.99))
        h, w = pano.rgb.shape[:2]
        try:
            verify_frame("equirectangular", w, h)
        except ProjectionMismatch as error:
            raise JobFailure("privacy_failed", str(error)) from error
        try:
            views = cutter.cut(pano.rgb)
        except Exception as error:  # noqa: BLE001 - a view that cannot be cut is not processed
            raise JobFailure("privacy_failed", "a panorama could not be cut into views") from error
        scores = [sharpness(view.rgb) for view in views]
        if max(scores) < MIN_SHARPNESS:
            deriver.rejected += len(views)
            continue
        for view, score in zip(views, scores):
            deriver.add(
                view.rgb,
                score,
                pano.timestamp_seconds,
                always=view.nadir,
                panorama=PanoramaView(
                    index=index,
                    yawDegrees=view.yaw_degrees,
                    pitchDegrees=view.pitch_degrees,
                    horizontalFovDegrees=cutter.fov_degrees,
                ),
                sharpness_gated=False,
            )
