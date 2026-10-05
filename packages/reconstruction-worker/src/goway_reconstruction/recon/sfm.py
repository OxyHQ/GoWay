"""Camera solve: features, bounded matching and incremental SfM.

COLMAP (through pycolmap) is the baseline solver behind this module, and
nothing outside it sees a COLMAP type. Matching is bounded by construction:

- within one contribution sequence, each frame is matched to its next
  ``SEQUENTIAL_OVERLAP`` neighbours (video keyframes and walking photo series);
- across sequences, a frame is matched only to frames whose GPS prior lies
  within ``SPATIAL_RADIUS_M``, nearest first, at most ``SPATIAL_NEIGHBOURS``.

There is no all-vs-all pass. Two unrelated contributions connect only when
their priors are close AND their pixels verify geometrically, which is how a
second contributor's photos join the first one's scene.

Views cut from a 360° panorama are not independent cameras. They share a
centre and differ by a known yaw, so they are paired and solved as a rig:

- views of the same panorama are matched with their neighbouring yaws;
- each yaw is matched along the sequence, like a forward-facing video, and
  with the neighbouring yaws of the next few panoramas (turning views);
- across sequences, views pair spatially as any frame does, preferring views
  that face the same way when both carry a heading;
- the solver is told the rig (``pycolmap.apply_rig_config``): every panorama
  is one frame of a rig whose sensors are its yaws, with the relative
  rotations fixed, so a panorama is solved as one pose instead of eight.

Feature extraction honours the privacy masks: no keypoint is detected on a
masked person or vehicle.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pycolmap

from ..privacy.panorama import cam_from_pano

log = logging.getLogger("goway.worker")

SEQUENTIAL_OVERLAP = 20
SPATIAL_RADIUS_M = 60.0
SPATIAL_NEIGHBOURS = 25
# Priors that spread less than this cannot rank neighbours (a video carries a
# single position), so cross-sequence pairs fall back to a regular subsample.
DEGENERATE_PRIOR_SPREAD_M = 5.0
CROSS_SEQUENCE_STRIDE = 3
# Rig pairing: same yaw along the sequence, and neighbouring yaws within a few panoramas.
RIG_SEQUENTIAL_OVERLAP = 20
RIG_TURN_WINDOW = 4
# Cross-sequence pairs a rig view may take from one other sequence when priors are degenerate.
RIG_CROSS_SEQUENCE_CAP = SPATIAL_NEIGHBOURS


@dataclass(frozen=True)
class RigView:
    """A view cut from a 360° panorama."""

    panorama: str  # unique per panorama: every view of it shares this
    yaw: float  # degrees clockwise from the panorama's centre
    fov: float  # horizontal field of view, degrees


@dataclass
class SfmFrame:
    frame_id: str
    group: str
    index: int
    image_name: str  # relative to the images dir; see ``frame_image_name``
    width: int
    height: int
    east: float
    north: float
    up: float
    focal35: float | None
    rig: RigView | None = None
    heading: float | None = None  # prior compass heading of the view, when known


def frame_image_name(group: str, frame_id: str, width: int, height: int, rig: RigView | None) -> str:
    """Where a frame's image lives under the images dir.

    A rig view is named ``<sensor prefix><panorama>.jpg``: COLMAP groups the
    images of one rig frame by the name left after the sensor's prefix, so
    every view of a panorama must end in the same name.
    """
    if rig is None:
        return f"{group}/{frame_id}.jpg"
    return f"{_rig_prefix(width, height, rig)}{rig.panorama}.jpg"


def _rig_bucket(width: int, height: int, fov: float) -> str:
    return f"rig-{width}x{height}-f{round(fov * 100):05d}/"


def _rig_prefix(width: int, height: int, rig: RigView) -> str:
    return f"{_rig_bucket(width, height, rig.fov)}y{round(rig.yaw * 100):05d}/"


def _yaw_gap(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


@dataclass
class SfmResult:
    reconstruction: pycolmap.Reconstruction
    registered: list[str]  # frame ids
    edges: list[tuple[str, str, int]]
    mean_reprojection_error: float
    sparse_points: int


class SfmError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _rig_positions(frames: list[SfmFrame]) -> dict[str, int]:
    """Each panorama's position along its sequence: its rank by first sequence index."""
    first: dict[tuple[str, str], int] = {}
    for f in frames:
        if f.rig is not None:
            key = (f.group, f.rig.panorama)
            first[key] = min(first.get(key, f.index), f.index)
    positions: dict[str, int] = {}
    by_group: dict[str, list[tuple[int, str]]] = {}
    for (group, panorama), index in first.items():
        by_group.setdefault(group, []).append((index, panorama))
    for members in by_group.values():
        for rank, (_index, panorama) in enumerate(sorted(members)):
            positions[panorama] = rank
    return positions


def _rig_pairs(frames: list[SfmFrame], positions: dict[str, int], pairs: set[tuple[str, str]]) -> None:
    """Pairs between views of panoramas in the same sequence. See this module's header."""
    slots: dict[tuple[str, int], list[SfmFrame]] = {}
    lengths: dict[str, int] = {}
    for f in frames:
        if f.rig is not None:
            position = positions[f.rig.panorama]
            slots.setdefault((f.group, position), []).append(f)
            lengths[f.group] = max(lengths.get(f.group, 0), position + 1)

    def add(a: SfmFrame, b: SfmFrame) -> None:
        if a is not b:
            pairs.add(tuple(sorted((a.image_name, b.image_name))))

    for (group, position), views in slots.items():
        steps = list(range(1, RIG_SEQUENTIAL_OVERLAP + 1))
        jump = RIG_SEQUENTIAL_OVERLAP * 2
        while position + jump < lengths[group]:
            steps.append(jump)
            jump *= 2
        for a in views:
            assert a.rig is not None
            # Same panorama: neighbouring yaws overlap; views a full FOV apart do not.
            for b in views:
                assert b.rig is not None
                if 0 < _yaw_gap(a.rig.yaw, b.rig.yaw) < a.rig.fov:
                    add(a, b)
            # Same yaw along the sequence, with exponential jumps for wide baselines.
            for step in steps:
                for b in slots.get((group, position + step), ()):
                    assert b.rig is not None
                    if _yaw_gap(a.rig.yaw, b.rig.yaw) < 1e-3:
                        add(a, b)
            # Turning views: neighbouring yaws of the next few panoramas.
            for step in range(1, RIG_TURN_WINDOW + 1):
                for b in slots.get((group, position + step), ()):
                    assert b.rig is not None
                    if 1e-3 <= _yaw_gap(a.rig.yaw, b.rig.yaw) <= a.rig.fov:
                        add(a, b)


def _cross_allowed(a: SfmFrame, b: SfmFrame, positions: dict[str, int]) -> bool:
    """Whether a spatial (cross-sequence or loop-closure) pair is worth matching."""
    if a.rig is not None and b.rig is not None:
        if a.rig.panorama == b.rig.panorama:
            return False
        if a.group == b.group and abs(positions[a.rig.panorama] - positions[b.rig.panorama]) <= RIG_SEQUENTIAL_OVERLAP:
            return False
        # Views facing apart see different façades. Only judged when both headings are known.
        if a.heading is not None and b.heading is not None and _yaw_gap(a.heading, b.heading) > max(a.rig.fov, b.rig.fov):
            return False
        return True
    if a.group == b.group and a.rig is None and b.rig is None and abs(b.index - a.index) <= SEQUENTIAL_OVERLAP:
        return False
    return True


def _pairs(frames: list[SfmFrame]) -> list[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    positions = _rig_positions(frames)
    _rig_pairs(frames, positions, pairs)
    by_group: dict[str, list[SfmFrame]] = {}
    for f in frames:
        by_group.setdefault(f.group, []).append(f)
    for members in by_group.values():
        group = sorted((f for f in members if f.rig is None), key=lambda f: f.index)
        for i, a in enumerate(group):
            for b in group[i + 1 : i + 1 + SEQUENTIAL_OVERLAP]:
                pairs.add(tuple(sorted((a.image_name, b.image_name))))
            # Exponential jumps give dense keyframes wide baselines too.
            jump = SEQUENTIAL_OVERLAP * 2
            while i + jump < len(group):
                pairs.add(tuple(sorted((a.image_name, group[i + jump].image_name))))
                jump *= 2
    xy = np.array([[f.east, f.north] for f in frames])
    if len(frames) > 1 and float(np.ptp(xy, axis=0).max()) < DEGENERATE_PRIOR_SPREAD_M:
        groups = [sorted(members, key=lambda f: f.index) for members in by_group.values()]
        for gi, ga in enumerate(groups):
            for gb in groups[gi + 1 :]:
                for a in ga:
                    chosen = gb[a.index % CROSS_SEQUENCE_STRIDE :: CROSS_SEQUENCE_STRIDE]
                    if a.rig is not None or any(b.rig is not None for b in chosen):
                        # Eight views per panorama would make the regular subsample
                        # eight times denser; keep it to an even spread of bounded size.
                        chosen = [b for b in chosen if _cross_allowed(a, b, positions)]
                        if len(chosen) > RIG_CROSS_SEQUENCE_CAP:
                            picks = np.linspace(0, len(chosen) - 1, RIG_CROSS_SEQUENCE_CAP).round().astype(int)
                            chosen = [chosen[k] for k in sorted(set(picks.tolist()))]
                    for b in chosen:
                        pairs.add(tuple(sorted((a.image_name, b.image_name))))
        return sorted(pairs)
    for i, a in enumerate(frames):
        d = np.hypot(*(xy - xy[i]).T)
        order = np.argsort(d)
        taken = 0
        for j in order:
            if j == i or d[j] > SPATIAL_RADIUS_M:
                continue
            b = frames[j]
            if not _cross_allowed(a, b, positions):
                continue
            pairs.add(tuple(sorted((a.image_name, b.image_name))))
            taken += 1
            if taken >= SPATIAL_NEIGHBOURS:
                break
    return sorted(pairs)


def _camera_params(frame: SfmFrame) -> str:
    """SIMPLE_RADIAL "f,cx,cy,k" from a 35 mm-equivalent focal length, when known.

    A rig view's focal length is exact — it was rendered — so it comes from
    its field of view rather than from any camera metadata.
    """
    if frame.rig is not None:
        focal = frame.width / 2 / math.tan(math.radians(frame.rig.fov) / 2)
    elif frame.focal35:
        focal = frame.focal35 / 36.0 * max(frame.width, frame.height)
    else:
        return ""
    return f"{focal:.3f},{frame.width / 2:.3f},{frame.height / 2:.3f},0"


def _camera_groups(frames: list[SfmFrame]) -> list[list[SfmFrame]]:
    """Frames that share one camera: a contribution sequence, or one rig sensor."""
    groups: dict[str, list[SfmFrame]] = {}
    for f in frames:
        key = f"seq:{f.group}" if f.rig is None else f"rig:{_rig_prefix(f.width, f.height, f.rig)}"
        groups.setdefault(key, []).append(f)
    return list(groups.values())


def rig_configs(frames: list[SfmFrame]) -> list[pycolmap.RigConfig]:
    """One rig per view size and field of view; its sensors are the yaws.

    Each sensor's pose in the rig is a pure rotation about the vertical axis
    (``cam_from_pano``, the same convention the views were cut with) and no
    translation: the views of one panorama share its centre. The reference
    sensor is the yaw seen most often, so as many rig frames as possible
    carry it.
    """
    buckets: dict[str, dict[float, int]] = {}
    for f in frames:
        if f.rig is not None:
            yaws = buckets.setdefault(_rig_bucket(f.width, f.height, f.rig.fov), {})
            yaws[f.rig.yaw] = yaws.get(f.rig.yaw, 0) + 1
    configs = []
    for bucket, yaws in sorted(buckets.items()):
        reference = max(sorted(yaws), key=lambda yaw: yaws[yaw])
        cameras = []
        # COLMAP requires the reference sensor first.
        for yaw in sorted(yaws, key=lambda value: (value != reference, value)):
            prefix = f"{bucket}y{round(yaw * 100):05d}/"
            if yaw == reference:
                cameras.append(pycolmap.RigConfigCamera(ref_sensor=True, image_prefix=prefix))
                continue
            rotation = cam_from_pano(yaw) @ cam_from_pano(reference).T
            cam_from_rig = pycolmap.Rigid3d(pycolmap.Rotation3d(rotation), np.zeros(3))
            cameras.append(pycolmap.RigConfigCamera(ref_sensor=False, image_prefix=prefix, cam_from_rig=cam_from_rig))
        configs.append(pycolmap.RigConfig(cameras=cameras))
    return configs


def solve(frames: list[SfmFrame], images_dir: Path, masks_dir: Path, work_dir: Path, *, threads: int = -1) -> SfmResult:
    work_dir.mkdir(parents=True, exist_ok=True)
    database = work_dir / "database.db"
    if database.exists():
        database.unlink()

    by_name = {f.image_name: f for f in frames}
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.num_threads = threads
    extraction.sift.max_num_features = 8192
    for members in _camera_groups(frames):
        reader = pycolmap.ImageReaderOptions()
        reader.camera_model = "SIMPLE_RADIAL"
        reader.mask_path = str(masks_dir)
        params = _camera_params(members[0])
        if params:
            reader.camera_params = params
        pycolmap.extract_features(
            database,
            images_dir,
            image_names=[f.image_name for f in members],
            camera_mode=pycolmap.CameraMode.SINGLE,
            reader_options=reader,
            extraction_options=extraction,
            device=pycolmap.Device.cpu,
        )

    rigged = False
    configs = rig_configs(frames)
    if configs:
        try:
            with pycolmap.Database.open(database) as db:
                pycolmap.apply_rig_config(configs, db)
            rigged = True
        except Exception as error:  # noqa: BLE001 - the rig pairing still holds the views together
            log.warning("rig configuration not applied (%s); solving panorama views as independent cameras", type(error).__name__)

    pair_file = work_dir / "pairs.txt"
    pairs = _pairs(frames)
    pair_file.write_text("".join(f"{a} {b}\n" for a, b in pairs))
    matching = pycolmap.FeatureMatchingOptions()
    matching.num_threads = threads
    pairing = pycolmap.ImportedPairingOptions()
    pairing.match_list_path = str(pair_file)
    pycolmap.match_image_pairs(database, matching_options=matching, pairing_options=pairing, device=pycolmap.Device.cpu)

    # COLMAP 4's global mapper (GLOMAP) first: on a 400-frame street video it
    # registered 395 frames where the incremental mapper stopped at 298, with
    # twice the sparse points. Incremental mapping remains the fallback.
    models = {}
    try:
        global_options = pycolmap.GlobalPipelineOptions()
        # The rig's relative rotations are exact (the views were rendered), not estimates to refine.
        global_options.mapper.refine_sensor_from_rig = not rigged
        models = pycolmap.global_mapping(database, images_dir, work_dir / "global", options=global_options)
    except Exception:  # noqa: BLE001 - fall back to incremental mapping below
        models = {}
    best = max(models.values(), key=lambda r: r.num_reg_images()) if models else None
    if best is None or best.num_reg_images() < max(3, int(0.5 * len(frames))):
        options = pycolmap.IncrementalPipelineOptions()
        options.num_threads = threads
        options.multiple_models = True
        options.min_model_size = 3
        options.ba_refine_sensor_from_rig = not rigged
        incremental = pycolmap.incremental_mapping(database, images_dir, work_dir / "sparse", options=options)
        candidates = [m for m in [best, *incremental.values()] if m is not None]
        best = max(candidates, key=lambda r: r.num_reg_images()) if candidates else None
    if best is None:
        raise SfmError("insufficient_overlap", "no camera model could be initialised")
    model = best

    registered = [by_name[img.name].frame_id for img in model.images.values() if img.has_pose]
    edges: list[tuple[str, str, int]] = []
    with pycolmap.Database.open(database) as db:
        ids = {img.image_id: img.name for img in db.read_all_images()}
        pair_ids, geometries = db.read_two_view_geometries()
        for pair_id, geometry in zip(pair_ids, geometries):
            inliers = int(len(geometry.inlier_matches))
            if inliers < 15:
                continue
            a, b = pycolmap.pair_id_to_image_pair(pair_id)
            edges.append((by_name[ids[a]].frame_id, by_name[ids[b]].frame_id, inliers))

    return SfmResult(
        reconstruction=model,
        registered=registered,
        edges=edges,
        mean_reprojection_error=float(model.compute_mean_reprojection_error()),
        sparse_points=int(model.num_points3D()),
    )


# ── Georeferencing ──────────────────────────────────────────────────────────

WGS84_A = 6378137.0
WGS84_E2 = 6.69437999014e-3


def geodetic_to_enu(lat: float, lon: float, alt: float, lat0: float, lon0: float, alt0: float) -> tuple[float, float, float]:
    def ecef(la: float, lo: float, h: float) -> np.ndarray:
        la, lo = math.radians(la), math.radians(lo)
        n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(la) ** 2)
        return np.array([(n + h) * math.cos(la) * math.cos(lo), (n + h) * math.cos(la) * math.sin(lo), (n * (1 - WGS84_E2) + h) * math.sin(la)])

    d = ecef(lat, lon, alt) - ecef(lat0, lon0, alt0)
    la0, lo0 = math.radians(lat0), math.radians(lon0)
    east = -math.sin(lo0) * d[0] + math.cos(lo0) * d[1]
    north = -math.sin(la0) * math.cos(lo0) * d[0] - math.sin(la0) * math.sin(lo0) * d[1] + math.cos(la0) * d[2]
    up = math.cos(la0) * math.cos(lo0) * d[0] + math.cos(la0) * math.sin(lo0) * d[1] + math.sin(la0) * d[2]
    return float(east), float(north), float(up)


def enu_to_geodetic(east: float, north: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Small-area inverse, for bounds and footprints (sub-centimetre over a scene)."""
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(math.radians(lat0)) ** 2)
    m = n * (1 - WGS84_E2) / (1 - WGS84_E2 * math.sin(math.radians(lat0)) ** 2)
    return lat0 + math.degrees(north / m), lon0 + math.degrees(east / (n * math.cos(math.radians(lat0))))


@dataclass
class Georeference:
    inliers: int
    median_residual_m: float
    p90_residual_m: float


def _rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


def _similarity_2d(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Least-squares 2D similarity (Umeyama) taking ``src`` onto ``dst``."""
    ms, md = src.mean(0), dst.mean(0)
    xs, xd = src - ms, dst - md
    cov = xd.T @ xs / len(src)
    u, d, vt = np.linalg.svd(cov)
    sign = np.diag([1.0, np.sign(np.linalg.det(u @ vt)) or 1.0])
    rot = u @ sign @ vt
    var = (xs**2).sum() / len(src)
    scale = float((d * np.diag(sign)).sum() / var) if var > 0 else 1.0
    return scale, rot, md - scale * rot @ ms


def georeference(result: SfmResult, frames: list[SfmFrame], *, max_error_m: float, seed: int = 0) -> Georeference:
    """Place the solved model in metric ENU around the anchor, in place.

    Street captures are close to collinear, which leaves a 3D fit to GPS
    points free to roll the street about its own axis. So the vertical comes
    from the cameras instead: phones and vehicle cameras are held roughly
    upright, and the mean of their "up" directions is the scene's up. With up
    fixed, the remaining unknowns are a 2D similarity (scale, heading,
    offset), fitted robustly to the horizontal GPS priors with RANSAC. Phone
    altitude is too noisy to use; cameras are set near +2 m instead.

    Residuals are reported so a badly placed scene is published as
    ``approximate``, never as precise.
    """
    model = result.reconstruction
    by_name = {f.image_name: f for f in frames}
    # One position per camera centre: the views of a panorama share theirs, so
    # they count once — eight views of one place are not eight GPS agreements.
    stations: dict[str, tuple[list[np.ndarray], list[float]]] = {}
    ups = []
    for img in model.images.values():
        if not img.has_pose:
            continue
        f = by_name[img.name]
        rot = img.cam_from_world().rotation.matrix()
        ups.append(-rot.T @ np.array([0.0, 1.0, 0.0]))
        key = f"rig:{f.rig.panorama}" if f.rig is not None else f"frame:{f.frame_id}"
        stations.setdefault(key, ([], [f.east, f.north]))[0].append(img.projection_center())
    centers = [np.mean(members, axis=0) for members, _ in stations.values()]
    targets = [target for _, target in stations.values()]
    if len(centers) < 3:
        raise SfmError("georeference_failed", "fewer than three solved cameras")
    centers_np, targets_np = np.array(centers), np.array(targets)
    level = _rotation_between(np.mean(ups, axis=0), np.array([0.0, 0.0, 1.0]))
    horizontal = (centers_np @ level.T)[:, :2]

    rng = np.random.default_rng(seed)
    best: np.ndarray | None = None
    n = len(horizontal)
    for _ in range(min(2000, n * (n - 1))):
        i, j = rng.choice(n, size=2, replace=False)
        if np.linalg.norm(horizontal[i] - horizontal[j]) < 1e-6 or np.linalg.norm(targets_np[i] - targets_np[j]) < 1.0:
            continue
        s, r, t = _similarity_2d(horizontal[[i, j]], targets_np[[i, j]])
        residual = np.linalg.norm(horizontal @ (s * r).T + t - targets_np, axis=1)
        inliers = residual <= max_error_m
        if best is None or inliers.sum() > best.sum():
            best = inliers
    if best is None or best.sum() < 3:
        raise SfmError("georeference_failed", "no robust alignment to position priors")
    s, r, t = _similarity_2d(horizontal[best], targets_np[best])
    residuals = np.linalg.norm(horizontal @ (s * r).T + t - targets_np, axis=1)

    rot3 = np.eye(3)
    rot3[:2, :2] = r
    rotation = rot3 @ level
    heights = (centers_np @ rotation.T)[:, 2] * s
    translation = np.array([t[0], t[1], 2.0 - float(np.median(heights))])
    model.transform(pycolmap.Sim3d(s, pycolmap.Rotation3d(rotation), translation))
    return Georeference(
        inliers=int((residuals <= max_error_m).sum()),
        median_residual_m=float(np.median(residuals)),
        p90_residual_m=float(np.percentile(residuals, 90)),
    )
