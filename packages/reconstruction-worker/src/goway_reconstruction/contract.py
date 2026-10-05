"""The worker's half of the GoWay job contract.

The canonical examples are the JSON files in ``contract/fixtures``; the backend
parses the same files with zod, and ``tests/test_contract.py`` parses them here,
so a field renamed on one side fails a test on the other instead of failing a job
in production.

Inputs the backend writes are parsed leniently about EXTRA fields (a newer
backend may add one) and strictly about the fields the worker relies on. Outputs
the worker writes are built from these models, so they are always complete.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = 1

Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
JobKey = Annotated[str, Field(min_length=1, max_length=1024, pattern=r"^(captures|derived|jobs)/[^\s]+$")]
Profile = Literal["draft", "standard"]
# How the pixels of a capture map to directions. A job DECLARES it (the
# contributor's claim); the privacy job verifies it against the media.
Projection = Literal["perspective", "equirectangular"]

FAILURE_CODES = (
    "insufficient_overlap",
    "camera_solve_failed",
    "georeference_failed",
    "privacy_failed",
    "out_of_memory",
    "corrupt_input",
    "quality_failed",
    "worker_interrupted",
    "cancelled",
    "internal",
)
FailureCode = Literal[
    "insufficient_overlap",
    "camera_solve_failed",
    "georeference_failed",
    "privacy_failed",
    "out_of_memory",
    "corrupt_input",
    "quality_failed",
    "worker_interrupted",
    "cancelled",
    "internal",
]
RETRYABLE_FAILURES = frozenset({"out_of_memory", "worker_interrupted", "internal"})

Stage = Literal[
    "preparing",
    "privacy",
    "matching",
    "solving",
    "georeferencing",
    "training",
    "optimizing",
    "uploading",
]


class _Input(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class _Output(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── Job envelopes (SQS jobs queue) ──────────────────────────────────────────


class ObjectRef(_Input):
    key: JobKey
    contentType: str
    byteSize: int = Field(gt=0)
    sha256: Sha256


class KeyframePolicy(_Input):
    maxFrames: int = Field(ge=1, le=600)
    minIntervalSeconds: float = Field(gt=0, le=60)
    maxLongEdgePixels: int = Field(ge=256, le=8192)


class CapturePrivacyJob(_Input):
    schemaVersion: Literal[1]
    jobId: str = Field(min_length=1, max_length=64)
    jobType: Literal["capture_privacy"]
    issuedAt: str
    assetId: str = Field(min_length=1, max_length=64)
    mediaKind: Literal["photo", "video"]
    input: ObjectRef
    outputPrefix: JobKey
    keyframes: KeyframePolicy
    # Absent from a backend that predates 360° captures: everything was perspective.
    projection: Projection = "perspective"


class SceneReconstructJob(_Input):
    schemaVersion: Literal[1]
    jobId: str = Field(min_length=1, max_length=64)
    jobType: Literal["scene_reconstruct"]
    issuedAt: str
    sceneId: str = Field(min_length=1, max_length=64)
    sceneVersion: int = Field(ge=1)
    profile: Profile
    inputManifestKey: JobKey
    inputManifestSha256: Sha256
    outputPrefix: JobKey


Job = CapturePrivacyJob | SceneReconstructJob


def parse_job(raw: dict) -> Job:
    kind = raw.get("jobType")
    if kind == "capture_privacy":
        return CapturePrivacyJob.model_validate(raw)
    if kind == "scene_reconstruct":
        return SceneReconstructJob.model_validate(raw)
    raise ValueError("unknown jobType")


# ── Scene input manifest (written by the backend to S3) ─────────────────────


class Coordinate(_Input):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class Prior(Coordinate):
    altitudeMeters: float | None = None
    accuracyMeters: float | None = Field(default=None, ge=0)
    headingDegrees: float | None = Field(default=None, ge=0, lt=360)


class FrameCamera(_Input):
    focalLength35mm: float | None = Field(default=None, gt=0)


class FramePanorama(_Input):
    """A perspective view cut from a 360° panorama: which panorama, and where it looks."""

    index: int = Field(ge=0)
    yawDegrees: float = Field(ge=0, lt=360)
    horizontalFovDegrees: float = Field(gt=0, lt=180)


class InputFrame(_Input):
    frameId: str = Field(min_length=1, max_length=128)
    captureAssetId: str
    imageKey: JobKey
    imageSha256: Sha256
    maskKey: JobKey
    maskSha256: Sha256
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    privacyPipelineVersion: str
    sequenceGroup: str
    sequenceIndex: int = Field(ge=0)
    capturedAt: str | None = None
    prior: Prior
    camera: FrameCamera | None = None
    panorama: FramePanorama | None = None


class Budgets(_Input):
    maxTrainingIterations: int = Field(ge=100, le=200_000)
    maxGaussians: int = Field(ge=10_000, le=20_000_000)
    maxAssetBytes: int = Field(ge=1_000_000)
    maxTrainingLongEdgePixels: int = Field(ge=256, le=8192)


class Gates(_Input):
    minRegisteredFrames: int = Field(ge=2)
    minRegistrationRatio: float = Field(ge=0, le=1)
    maxMeanReprojectionErrorPx: float = Field(gt=0)
    minGeoreferenceInliers: int = Field(ge=2)
    maxMedianGeoreferenceResidualMeters: float = Field(gt=0)
    minHeldOutPsnr: float


class SceneInputManifest(_Input):
    schemaVersion: Literal[1]
    jobId: str
    sceneId: str
    sceneVersion: int
    profile: Profile
    anchor: Coordinate
    radiusMeters: float = Field(gt=0)
    frames: list[InputFrame] = Field(min_length=1)
    budgets: Budgets
    gates: Gates


# ── Results (written by the worker to S3) ───────────────────────────────────


class ModelRef(_Output):
    name: str
    version: str
    sha256: Sha256


class Detections(_Output):
    faces: int
    plates: int
    people: int
    vehicles: int


class PanoramaView(_Output):
    """Where a derivative came from when its capture is a 360° panorama.

    ``index`` is the panorama within the capture (0 for a photo, the keyframe
    for a video); ``yawDegrees`` is the view's direction from the panorama's
    centre, clockwise. Views of one panorama share a centre, which the solve
    uses to treat them as a rig.
    """

    index: int = Field(ge=0)
    yawDegrees: float = Field(ge=0, lt=360)
    horizontalFovDegrees: float = Field(gt=0, lt=180)


class PrivacyFrame(_Output):
    frameIndex: int
    imageKey: str
    imageSha256: Sha256
    imageByteSize: int
    maskKey: str
    maskSha256: Sha256
    maskByteSize: int
    width: int
    height: int
    detections: Detections
    maskedFraction: float
    sharpness: float
    timestampSeconds: float | None = None
    panorama: PanoramaView | None = None


class CapturePrivacyResult(_Output):
    schemaVersion: Literal[1] = 1
    jobId: str
    jobType: Literal["capture_privacy"] = "capture_privacy"
    attempt: int
    assetId: str
    verdict: Literal["passed", "failed"]
    privacyPipelineVersion: str
    # The VERIFIED projection; a backend refuses a result that disagrees with the declaration.
    projection: Projection = "perspective"
    models: list[ModelRef]
    metadataStripped: bool
    frames: list[PrivacyFrame]
    rejectedFrames: int
    failure: "Failure | None" = None

    @model_validator(mode="after")
    def _views_match_projection(self) -> "CapturePrivacyResult":
        # A panorama is only ever reported as views, and a view only for a panorama.
        if any((f.panorama is not None) != (self.projection == "equirectangular") for f in self.frames):
            raise ValueError("panorama views must match the verified projection")
        return self


class WorldTransform(_Output):
    anchor: dict
    frame: Literal["enu"] = "enu"
    enuFromScene: list[float] = Field(min_length=16, max_length=16)


class Bounds(_Output):
    west: float
    south: float
    east: float
    north: float


class Footprint(_Output):
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[list[float]]]


class FrameCounts(_Output):
    input: int
    registered: int
    registeredFrameIds: list[str]


class Edge(_Output):
    a: str
    b: str
    inliers: int


class SceneMetrics(_Output):
    registrationRatio: float
    meanReprojectionErrorPx: float
    sparsePoints: int
    georeferenceInliers: int
    medianGeoreferenceResidualMeters: float
    heldOutPsnr: float
    heldOutSsim: float
    gaussians: int
    trainingIterations: int
    trainingSeconds: float
    gpuSeconds: float
    peakVramMb: int
    wallSeconds: float
    inputBytesDownloaded: int
    cacheHitRatio: float
    outputBytes: int


class GateResult(_Output):
    passed: bool
    failures: list[str]


class OutputAsset(_Output):
    role: Literal["splat", "splat_preview", "poster"]
    format: Literal["spz", "jpeg"]
    key: str
    sha256: Sha256
    byteSize: int
    contentType: str
    gaussians: int | None = None


class InitialView(_Output):
    position: list[float] = Field(min_length=3, max_length=3)
    target: list[float] = Field(min_length=3, max_length=3)


class Viewpoint(_Output):
    """A solved camera position and facing, in scene coordinates (metric ENU, z up)."""

    position: list[float] = Field(min_length=3, max_length=3)
    forward: list[float] = Field(min_length=3, max_length=3)


class CaptureFieldOfView(_Output):
    horizontalDegrees: float = Field(ge=1, le=179)
    verticalDegrees: float = Field(ge=1, le=179)


class Provenance(_Output):
    pipelineVersion: str
    privacyPipelineVersions: list[str]
    components: dict[str, str]
    inputs: list[dict]


class SceneReconstructResult(_Output):
    schemaVersion: Literal[1] = 1
    jobId: str
    jobType: Literal["scene_reconstruct"] = "scene_reconstruct"
    attempt: int
    sceneId: str
    sceneVersion: int
    profile: Profile
    inputManifestSha256: Sha256
    worldTransform: WorldTransform
    bounds: Bounds
    footprint: Footprint
    frames: FrameCounts
    edges: list[Edge]
    metrics: SceneMetrics
    gates: GateResult
    assets: list[OutputAsset]
    initialView: InitialView
    # Optional guided-navigation inputs; the backend decimates and reorders them.
    viewpoints: list[Viewpoint] | None = Field(default=None, max_length=2000)
    captureFieldOfView: CaptureFieldOfView | None = None
    observedFrom: str
    observedTo: str
    provenance: Provenance


# ── Events (SQS events queue) ───────────────────────────────────────────────


class Failure(_Output):
    code: FailureCode
    retryable: bool
    # Short, sanitized: no coordinates, keys, URLs, paths or hostnames.
    detail: str = Field(default="", max_length=300)


class ResultRef(_Output):
    key: str
    sha256: Sha256
    byteSize: int


class Event(_Output):
    schemaVersion: Literal[1] = 1
    eventId: str
    jobId: str
    attempt: int
    workerId: str
    type: Literal["leased", "heartbeat", "stage", "completed", "failed", "cancelled"]
    at: str
    stage: Stage | None = None
    progress: float | None = Field(default=None, ge=0, le=1)
    leaseExpiresAt: str | None = None
    failure: Failure | None = None
    result: ResultRef | None = None
    metrics: dict | None = None


CapturePrivacyResult.model_rebuild()
