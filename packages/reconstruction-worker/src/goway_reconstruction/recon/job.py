"""The ``scene_reconstruct`` job: privacy-safe frames in, a gated scene version out.

Stages, each a cancellation point and each with its own failure class:

    preparing      manifest (digest-checked) and frames (cache, then S3)
    matching       features on unmasked pixels, bounded pairs
    solving        incremental SfM                 -> insufficient_overlap
    georeferencing robust up + 2D similarity       -> georeference_failed
    training       gsplat, budgeted, checkpointed  -> out_of_memory
    optimizing     SPZ + preview LOD, decode-and-render smoke test, poster
    uploading      assets, then result.json        (assets only if gates pass)

Only frames whose manifest entry names a privacy pipeline version are accepted,
and only their privacy-safe derivative and mask are ever downloaded; the raw
capture is not reachable from here.

A redelivered attempt of the same job, on the same worker, with the same input
manifest resumes from ``resume/``: the aligned solve and the last training
checkpoint.
"""

from __future__ import annotations

import io
import json
import math
import shutil
import time
from pathlib import Path

import cv2
import numpy as np
import pycolmap
import torch
from PIL import Image

from .. import RECONSTRUCTION_PIPELINE_VERSION
from ..aws import Aws
from ..context import JobContext, JobFailure
from ..contract import (
    Bounds,
    Edge,
    CaptureFieldOfView,
    Footprint,
    FrameCounts,
    GateResult,
    InitialView,
    OutputAsset,
    Provenance,
    SceneInputManifest,
    SceneMetrics,
    SceneReconstructJob,
    SceneReconstructResult,
    Viewpoint,
    WorldTransform,
)
from ..storage import ContentCache
from . import spz
from .sfm import SfmError, SfmFrame, enu_to_geodetic, geodetic_to_enu, georeference, solve
from .train import Trainer, View, load_views, train_scene

PROFILE_SH_DEGREE = {"draft": 1, "standard": 3}
PREVIEW_MIN, PREVIEW_MAX = 100_000, 400_000
SMOKE_MIN_PSNR = 28.0
FOOTPRINT_BUFFER_M = 15.0


def _fetch(aws: Aws, cache: ContentCache, key: str, sha256: str, dest: Path) -> None:
    hit = cache.get(sha256)
    if hit is None:
        tmp = dest.with_suffix(dest.suffix + ".dl")
        aws.download(key, tmp, sha256=sha256)
        hit = cache.put(sha256, tmp)
        tmp.unlink(missing_ok=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(hit, dest)


def _footprint(xy: np.ndarray, anchor: tuple[float, float], radius: float) -> tuple[Footprint, Bounds]:
    pts = xy.astype(np.float32)
    if len(pts) >= 3:
        hull = cv2.convexHull(pts).reshape(-1, 2)
    else:
        hull = pts
    centre = hull.mean(0)
    buffered = []
    for p in hull:
        d = p - centre
        n = np.linalg.norm(d) or 1.0
        q = p + d / n * FOOTPRINT_BUFFER_M
        if np.linalg.norm(q) > radius + FOOTPRINT_BUFFER_M:
            q = q / np.linalg.norm(q) * (radius + FOOTPRINT_BUFFER_M)
        buffered.append(q)
    if len(buffered) < 3:
        c = centre
        r = FOOTPRINT_BUFFER_M
        buffered = [c + [r, r], c + [-r, r], c + [-r, -r], c + [r, -r]]
    ring = []
    for e, n in buffered:
        lat, lon = enu_to_geodetic(float(e), float(n), *anchor)
        ring.append([round(lon, 7), round(lat, 7)])
    ring.append(ring[0])
    lons, lats = [p[0] for p in ring], [p[1] for p in ring]
    return Footprint(coordinates=[ring]), Bounds(west=min(lons), south=min(lats), east=max(lons), north=max(lats))


def _preview(cloud: spz.GaussianCloud) -> spz.GaussianCloud:
    n = cloud.count
    k = int(min(n, max(PREVIEW_MIN, min(PREVIEW_MAX, n // 4))))
    alpha = 1 / (1 + np.exp(-cloud.opacities))
    size = np.exp(cloud.scales).prod(1) ** (1 / 3)
    keep = np.argsort(-(alpha * size))[:k]
    return spz.GaussianCloud(
        means=cloud.means[keep],
        quats=cloud.quats[keep],
        scales=cloud.scales[keep],
        opacities=cloud.opacities[keep],
        sh0=cloud.sh0[keep],
        shN=cloud.shN[keep][:, :0] if cloud.shN.shape[1] else cloud.shN[keep],
    )


def _smoke_test(original: np.ndarray, data: bytes, view: View, sh_degree: int, device: torch.device) -> float:
    """Decode the published bytes, render them, compare with the trainer's own render."""
    from gsplat import rasterization

    cloud = spz.decode(data)
    t = lambda a: torch.tensor(a, dtype=torch.float32, device=device)  # noqa: E731
    colors = torch.cat([t(cloud.sh0)[:, None], t(cloud.shN)], 1)
    h, w = view.image.shape[:2]
    render = rasterization(
        means=t(cloud.means),
        quats=t(cloud.quats),
        scales=torch.exp(t(cloud.scales)),
        opacities=torch.sigmoid(t(cloud.opacities)),
        colors=colors,
        viewmats=view.viewmat[None],
        Ks=view.K[None],
        width=w,
        height=h,
        sh_degree=min(sh_degree, cloud.sh_degree),
        rasterize_mode="antialiased",
    )[0][0].clamp(0, 1)
    ref = torch.tensor(original, dtype=torch.float32, device=device) / 255.0
    mse = float(((render - ref) ** 2).mean())
    return -10 * math.log10(max(mse, 1e-10))


def run(
    job: SceneReconstructJob,
    ctx: JobContext,
    aws: Aws,
    cache: ContentCache,
    work: Path,
    device: torch.device,
    depth_prior=None,  # noqa: ANN001 - depth.DepthPrior
) -> SceneReconstructResult:
    started = time.monotonic()
    ctx.enter("preparing")
    try:
        manifest = SceneInputManifest.model_validate(aws.get_json(job.inputManifestKey, sha256=job.inputManifestSha256))
    except Exception as error:  # noqa: BLE001
        raise JobFailure("corrupt_input", "input manifest missing, altered or invalid") from error
    if (manifest.jobId, manifest.sceneId, manifest.sceneVersion) != (job.jobId, job.sceneId, job.sceneVersion):
        raise JobFailure("corrupt_input", "input manifest belongs to another job")
    if any(not f.privacyPipelineVersion for f in manifest.frames):
        raise JobFailure("privacy_failed", "a frame has no privacy clearance")

    images, masks = work / "images", work / "masks"
    anchor = (manifest.anchor.latitude, manifest.anchor.longitude)
    frames: list[SfmFrame] = []
    by_id = {}
    for i, f in enumerate(manifest.frames):
        ctx.report(i / len(manifest.frames))
        name = f"{f.sequenceGroup}/{f.frameId}.jpg"
        try:
            _fetch(aws, cache, f.imageKey, f.imageSha256, images / name)
            _fetch(aws, cache, f.maskKey, f.maskSha256, masks / f"{name}.png")
        except Exception as error:  # noqa: BLE001
            raise JobFailure("corrupt_input", "a derivative is missing or altered") from error
        east, north, _ = geodetic_to_enu(f.prior.latitude, f.prior.longitude, 0.0, *anchor, 0.0)
        focal = f.camera.focalLength35mm if f.camera else None
        frames.append(SfmFrame(f.frameId, f.sequenceGroup, f.sequenceIndex, name, f.width, f.height, east, north, 0.0, focal))
        by_id[f.frameId] = f

    resume = work / "resume"
    marker = resume / "manifest.sha256"
    aligned_dir = resume / "aligned"
    gates = manifest.gates
    failures: list[str] = []
    if marker.exists() and marker.read_text() == job.inputManifestSha256 and (aligned_dir / "meta.json").exists():
        model = pycolmap.Reconstruction(str(aligned_dir))
        meta = json.loads((aligned_dir / "meta.json").read_text())
    else:
        shutil.rmtree(resume, ignore_errors=True)
        ctx.enter("matching")
        try:
            ctx.enter("solving")
            solved = solve(frames, images, masks, work / "sfm")
        except SfmError as error:
            raise JobFailure(error.code, error.detail) from error
        registered = len(solved.registered)
        if registered < gates.minRegisteredFrames:
            raise JobFailure("insufficient_overlap", f"{registered} of {len(frames)} frames registered")
        ctx.enter("georeferencing")
        try:
            geo = georeference(solved, frames, max_error_m=gates.maxMedianGeoreferenceResidualMeters * 2)
        except SfmError as error:
            raise JobFailure(error.code, error.detail) from error
        model = solved.reconstruction
        meta = {
            "registered": solved.registered,
            "edges": solved.edges,
            "reprojection": solved.mean_reprojection_error,
            "points": solved.sparse_points,
            "georef": [geo.inliers, geo.median_residual_m, geo.p90_residual_m],
        }
        aligned_dir.mkdir(parents=True, exist_ok=True)
        model.write(str(aligned_dir))
        (aligned_dir / "meta.json").write_text(json.dumps(meta))
        marker.write_text(job.inputManifestSha256)

    registered_ids = meta["registered"]
    ratio = len(registered_ids) / len(frames)
    if ratio < gates.minRegistrationRatio:
        failures.append("registration_ratio")
    if meta["reprojection"] > gates.maxMeanReprojectionErrorPx:
        failures.append("reprojection_error")
    inliers, median_residual, _p90 = meta["georef"]
    if inliers < gates.minGeoreferenceInliers:
        raise JobFailure("georeference_failed", "too few cameras agree with their position priors")
    if failures:
        raise JobFailure("quality_failed", ", ".join(failures))

    ctx.enter("training")
    sh_degree = PROFILE_SH_DEGREE[job.profile]
    gpu_started = time.monotonic()
    try:
        trained = train_scene(
            model,
            images,
            masks,
            resume,
            iterations=manifest.budgets.maxTrainingIterations,
            max_gaussians=manifest.budgets.maxGaussians,
            long_edge=manifest.budgets.maxTrainingLongEdgePixels,
            sh_degree=sh_degree,
            on_progress=ctx.report,
            device=device,
            depth_prior=depth_prior,
        )
    except torch.cuda.OutOfMemoryError as error:
        raise JobFailure("out_of_memory", "training exceeded GPU memory") from error

    ctx.enter("optimizing")
    full = spz.encode(trained.cloud)
    preview = spz.encode(_preview(trained.cloud))
    views = load_views(model, images, masks, manifest.budgets.maxTrainingLongEdgePixels, device)
    smoke_view = min(views, key=lambda v: np.linalg.norm(v.center - np.array(trained.initial_position)))
    smoke_psnr = _smoke_test(trained.poster, full, smoke_view, sh_degree, device)
    gpu_seconds = time.monotonic() - gpu_started
    if smoke_psnr < SMOKE_MIN_PSNR:
        failures.append("viewer_smoke_test")
    if trained.psnr < gates.minHeldOutPsnr:
        failures.append("held_out_psnr")
    if median_residual > gates.maxMedianGeoreferenceResidualMeters:
        failures.append("georeference_residual")
    if len(full) > manifest.budgets.maxAssetBytes:
        failures.append("asset_bytes")
    if trained.cloud.count > manifest.budgets.maxGaussians:
        failures.append("gaussians")
    if failures:
        raise JobFailure("quality_failed", ", ".join(failures))

    ctx.enter("uploading")
    prefix = f"{job.outputPrefix}attempt-{ctx.attempt}/"
    poster = io.BytesIO()
    Image.fromarray(trained.poster).save(poster, format="JPEG", quality=85)
    assets: list[OutputAsset] = []
    for role, name, data, fmt, ctype, count in (
        ("splat", "scene.spz", full, "spz", "application/octet-stream", trained.cloud.count),
        ("splat_preview", "preview.spz", preview, "spz", "application/octet-stream", min(trained.cloud.count, spz.decode(preview).count)),
        ("poster", "poster.jpg", poster.getvalue(), "jpeg", "image/jpeg", None),
    ):
        sha, size = aws.put(prefix + name, data, ctype)
        assets.append(OutputAsset(role=role, format=fmt, key=prefix + name, sha256=sha, byteSize=size, contentType=ctype, gaussians=count))

    posed = [img for img in model.images.values() if img.has_pose]
    centers = np.array([img.projection_center() for img in posed])
    viewpoints = []
    for img in posed[:: max(1, len(posed) // 2000 + 1)]:
        forward = img.cam_from_world().rotation.matrix().T @ np.array([0.0, 0.0, 1.0])
        viewpoints.append(Viewpoint(position=[round(float(x), 3) for x in img.projection_center()], forward=[round(float(x), 4) for x in forward]))
    fovs = []
    for img in posed:
        cam = model.cameras[img.camera_id]
        f = float(cam.params[0])
        fovs.append((np.degrees(2 * np.arctan(cam.width / (2 * f))), np.degrees(2 * np.arctan(cam.height / (2 * f)))))
    fov_h, fov_v = (float(np.median([a for a, _ in fovs])), float(np.median([b for _, b in fovs])))
    footprint, bounds = _footprint(centers[:, :2], anchor, manifest.radiusMeters)
    times = sorted(by_id[i].capturedAt for i in registered_ids if by_id[i].capturedAt)
    edges = [Edge(a=a, b=b, inliers=n) for a, b, n in meta["edges"]]
    return SceneReconstructResult(
        jobId=job.jobId,
        attempt=ctx.attempt,
        sceneId=job.sceneId,
        sceneVersion=job.sceneVersion,
        profile=job.profile,
        inputManifestSha256=job.inputManifestSha256,
        worldTransform=WorldTransform(
            anchor={"latitude": anchor[0], "longitude": anchor[1], "altitudeMeters": 0.0},
            enuFromScene=[1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0],
        ),
        bounds=bounds,
        footprint=footprint,
        frames=FrameCounts(input=len(frames), registered=len(registered_ids), registeredFrameIds=sorted(registered_ids)),
        edges=edges,
        metrics=SceneMetrics(
            registrationRatio=round(ratio, 4),
            meanReprojectionErrorPx=round(meta["reprojection"], 4),
            sparsePoints=meta["points"],
            georeferenceInliers=inliers,
            medianGeoreferenceResidualMeters=round(median_residual, 3),
            heldOutPsnr=round(trained.psnr, 3),
            heldOutSsim=round(trained.ssim, 4),
            gaussians=trained.cloud.count,
            trainingIterations=trained.iterations,
            trainingSeconds=round(trained.seconds, 1),
            gpuSeconds=round(gpu_seconds, 1),
            peakVramMb=trained.peak_vram_mb,
            wallSeconds=round(time.monotonic() - started, 1),
            inputBytesDownloaded=aws.bytes_downloaded,
            cacheHitRatio=round(cache.hit_ratio, 4),
            outputBytes=sum(a.byteSize for a in assets),
        ),
        gates=GateResult(passed=True, failures=[]),
        assets=assets,
        initialView=InitialView(position=trained.initial_position, target=trained.initial_target),
        observedFrom=times[0] if times else job.issuedAt,
        observedTo=times[-1] if times else job.issuedAt,
        provenance=Provenance(
            pipelineVersion=RECONSTRUCTION_PIPELINE_VERSION,
            privacyPipelineVersions=sorted({f.privacyPipelineVersion for f in manifest.frames}),
            components=_components(),
            inputs=[{"frameId": f.frameId, "imageSha256": f.imageSha256} for f in manifest.frames],
        ),
        viewpoints=viewpoints,
        captureFieldOfView=CaptureFieldOfView(horizontalDegrees=round(fov_h, 2), verticalDegrees=round(fov_v, 2)),
    )


def _components() -> dict[str, str]:
    import gsplat

    return {"sfm": f"pycolmap {pycolmap.__version__}", "trainer": f"gsplat {gsplat.__version__}", "torch": torch.__version__}


__all__ = ["run", "Trainer"]
