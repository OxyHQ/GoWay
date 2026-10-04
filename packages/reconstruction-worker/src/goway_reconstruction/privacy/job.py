"""The ``capture_privacy`` job: raw media in, privacy-safe derivatives out.

Fail closed, end to end. The raw object is verified against the digest the
backend recorded at finalize; any decoder, detector or encoder error fails the
job; a frame is reported only after its derivative and mask are uploaded with an
S3-verified checksum. The raw file is deleted from scratch with the job and is
never cached.
"""

from __future__ import annotations

from pathlib import Path

from .. import PRIVACY_PIPELINE_VERSION
from ..aws import Aws
from ..context import JobContext, JobFailure
from ..contract import CapturePrivacyJob, CapturePrivacyResult, Detections, ModelRef, PrivacyFrame
from ..models import ALL_MODELS
from .detectors import PrivacyDetectors
from .media import CorruptMediaError, decode_photo, decode_video
from .redact import MAX_MASKED_FRACTION, MIN_SHARPNESS, MetadataSurvivedError, redact


def run(job: CapturePrivacyJob, ctx: JobContext, aws: Aws, detectors: PrivacyDetectors, work: Path) -> CapturePrivacyResult:
    ctx.enter("preparing")
    raw = work / "raw"
    try:
        aws.download(job.input.key, raw, sha256=job.input.sha256, byte_size=job.input.byteSize)
    except Exception as error:  # noqa: BLE001
        raise JobFailure("corrupt_input", "raw object missing or not the finalized bytes") from error

    ctx.enter("privacy")
    try:
        decoded = decode_photo(raw, job.keyframes) if job.mediaKind == "photo" else decode_video(raw, job.keyframes)
    except CorruptMediaError as error:
        raise JobFailure("corrupt_input", str(error)) from error
    finally:
        raw.unlink(missing_ok=True)

    frames: list[PrivacyFrame] = []
    rejected = 0
    for index, frame in enumerate(decoded):
        ctx.report(index / max(1, len(decoded)))
        if frame.sharpness < MIN_SHARPNESS:
            rejected += 1
            continue
        try:
            detections = detectors.detect(frame.rgb)
            redacted = redact(frame.rgb, detections)
        except MetadataSurvivedError as error:
            raise JobFailure("privacy_failed", "metadata survived re-encoding") from error
        except Exception as error:  # noqa: BLE001 - any detector failure closes the gate
            if "out of memory" in str(error).lower():
                raise JobFailure("out_of_memory", "detector ran out of GPU memory") from error
            raise JobFailure("privacy_failed", "a privacy detector failed") from error
        if redacted.masked_fraction > MAX_MASKED_FRACTION:
            rejected += 1
            continue
        stem = f"{job.outputPrefix}{len(frames):06d}"
        image_sha, image_size = aws.put(f"{stem}.jpg", redacted.jpeg, "image/jpeg")
        mask_sha, mask_size = aws.put(f"{stem}.mask.png", redacted.mask_png, "image/png")
        frames.append(
            PrivacyFrame(
                frameIndex=len(frames),
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
                sharpness=round(frame.sharpness, 2),
                timestampSeconds=frame.timestamp_seconds,
            )
        )
    ctx.report(1.0)

    if not frames:
        raise JobFailure("corrupt_input", "no usable frame after privacy processing")
    return CapturePrivacyResult(
        jobId=job.jobId,
        attempt=ctx.attempt,
        assetId=job.assetId,
        verdict="passed",
        privacyPipelineVersion=PRIVACY_PIPELINE_VERSION,
        models=[ModelRef(name=m.name, version=m.version, sha256=m.sha256) for m in ALL_MODELS],
        metadataStripped=True,
        frames=frames,
        rejectedFrames=rejected,
    )
