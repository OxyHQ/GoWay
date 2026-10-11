"""Gravity measured by the phone decides which way is up (docs/STREET3D_MOTION_PRIORS.md)."""

import math

import numpy as np
import pycolmap

from goway_reconstruction.recon.sfm import (
    MAX_LEVEL_DISAGREEMENT_DEG,
    SfmFrame,
    SfmResult,
    georeference,
    level,
)

DOWN = np.array([0.0, 0.0, -1.0])


def rotation(axis, degrees: float) -> np.ndarray:
    axis = np.asarray(axis, dtype=float)
    return pycolmap.Rotation3d(axis / np.linalg.norm(axis) * math.radians(degrees)).matrix()


def walk(*, pitch: float, frames: int = 30, step: float = 2.0, roll_jitter: float = 3.0, seed: int = 0):
    """A contributor walking north, the phone pitched down by ``pitch`` degrees.

    Returns world-from-camera rotations (ENU world; camera x right, y down,
    z forward) and camera centres, 1.5 m above a flat street.
    """
    rng = np.random.default_rng(seed)
    poses = []
    for i in range(frames):
        p = math.radians(pitch + rng.normal(0, 1.0))
        forward = np.array([0.0, math.cos(p), -math.sin(p)])
        down = np.array([0.0, -math.sin(p), -math.cos(p)])
        world_from_cam = np.column_stack([np.cross(down, forward), down, forward])
        world_from_cam = rotation(forward, rng.normal(0, roll_jitter)) @ world_from_cam
        poses.append((world_from_cam, np.array([rng.normal(0, 0.3), i * step, 1.5])))
    return poses


def solved(poses, *, gravity_noise: float = 1.0, gravity_error=None, seed: int = 1):
    """The walk as an SfM solve would return it: in an arbitrary similarity frame."""
    rng = np.random.default_rng(seed)
    q = rotation(rng.normal(size=3), 73.0)
    scale, offset = 0.37, np.array([4.0, -2.0, 9.0])
    model = pycolmap.Reconstruction()
    camera = pycolmap.Camera.create_from_model_name(1, "SIMPLE_PINHOLE", 1000.0, 1000, 750)
    model.add_camera(camera)
    rig = pycolmap.Rig(rig_id=1)
    rig.add_ref_sensor(camera.sensor_id)
    model.add_rig(rig)
    frames = []
    for i, (world_from_cam, centre) in enumerate(poses):
        cam_from_model = world_from_cam.T @ q.T
        centre_model = scale * q @ centre + offset
        frame = pycolmap.Frame()
        frame.frame_id = i + 1
        frame.rig_id = 1
        frame.rig_from_world = pycolmap.Rigid3d(pycolmap.Rotation3d(cam_from_model), -cam_from_model @ centre_model)
        image = pycolmap.Image(name=f"g/{i}.jpg", camera_id=1, image_id=i + 1)
        image.frame_id = i + 1
        frame.add_data_id(image.data_id)
        model.add_frame(frame)
        model.add_image(image)
        gravity = world_from_cam.T @ DOWN  # the phone's measurement, in camera axes
        if gravity_error is not None:
            gravity = gravity_error @ gravity
        gravity = rotation(rng.normal(size=3), rng.normal(0, gravity_noise)) @ gravity
        frames.append(SfmFrame(str(i), "g", i, f"g/{i}.jpg", 1000, 750, centre[0], centre[1], 0.0, None, gravity=tuple(gravity)))
    return SfmResult(reconstruction=model, registered=[], edges=[], mean_reprojection_error=0.0, sparse_points=0), frames


def tilt_after(result: SfmResult, poses) -> np.ndarray:
    """Per camera: how far the placed model's down is from the true down, degrees."""
    errors = []
    for image in result.reconstruction.images.values():
        world_from_cam, _ = poses[image.image_id - 1]
        true_down_in_cam = world_from_cam.T @ DOWN
        placed_down_in_cam = image.cam_from_world().rotation.matrix() @ DOWN
        errors.append(math.degrees(math.acos(np.clip(true_down_in_cam @ placed_down_in_cam, -1, 1))))
    return np.array(errors)


def strip_gravity(frames):
    return [SfmFrame(f.frame_id, f.group, f.index, f.image_name, f.width, f.height, f.east, f.north, f.up, f.focal35) for f in frames]


def test_phones_pitched_down_tilt_the_street_unless_gravity_levels_it():
    poses = walk(pitch=15.0)
    without, frames = solved(poses)
    geo = georeference(without, strip_gravity(frames), max_error_m=5.0)
    assert geo.level_source == "cameras" and geo.gravity_frames == 0 and geo.gravity_residual_deg is None
    # The old estimate believes the phones were level: the whole street leans by their pitch.
    assert 12.0 < np.median(tilt_after(without, poses)) < 18.0
    heights = [image.projection_center()[2] for image in without.reconstruction.images.values()]
    assert max(heights) - min(heights) > 10.0  # 60 m of street climbing a 15° slope

    with_gravity, frames = solved(poses)
    geo = georeference(with_gravity, frames, max_error_m=5.0)
    assert geo.level_source == "gravity" and geo.gravity_frames == 30
    assert np.median(tilt_after(with_gravity, poses)) < 1.0
    assert geo.gravity_residual_deg is not None and geo.gravity_residual_deg < 2.5
    heights = [image.projection_center()[2] for image in with_gravity.reconstruction.images.values()]
    assert max(heights) - min(heights) < 1.0
    assert geo.median_residual_m < 1.0  # leveling also stops the street shrinking in the GPS fit


def test_level_cameras_are_unaffected_by_adding_gravity():
    poses = walk(pitch=0.0)
    result, frames = solved(poses)
    geo = georeference(result, frames, max_error_m=5.0)
    assert geo.level_source == "gravity" and np.median(tilt_after(result, poses)) < 1.0


def test_gravity_in_the_wrong_axes_is_refused_not_trusted():
    # A recording orientation mistaken by 90° (picture axes turned about the optical axis).
    poses = walk(pitch=10.0)
    result, frames = solved(poses, gravity_error=rotation([0, 0, 1], 90.0))
    geo = georeference(result, frames, max_error_m=5.0)
    assert geo.level_source == "cameras"
    assert geo.gravity_residual_deg is not None and geo.gravity_residual_deg > MAX_LEVEL_DISAGREEMENT_DEG
    assert np.median(tilt_after(result, poses)) < 15.0  # no worse than without gravity
    # Upside down (a sign error) is refused the same way.
    result, frames = solved(poses, gravity_error=rotation([1, 0, 0], 180.0))
    assert georeference(result, frames, max_error_m=5.0).level_source == "cameras"


def test_a_minority_of_bad_measurements_does_not_move_the_level():
    rng = np.random.default_rng(3)
    true_down = np.array([0.0, 0.0, -1.0])
    good = [rotation(rng.normal(size=3), rng.normal(0, 1.0)) @ true_down for _ in range(16)]
    bad = [rotation(rng.normal(size=3), 60.0) @ true_down for _ in range(4)]
    cameras = [rotation([1, 0, 0], 12.0) @ true_down for _ in range(20)]
    decided = level(np.array(cameras), np.array(good + bad))
    assert decided.source == "gravity" and decided.gravity_frames == 20
    assert math.degrees(math.acos(decided.down @ true_down)) < 1.0


def test_a_coherent_majority_wins_even_when_the_minority_drags_the_mean_away():
    # Three agree; two are perpendicular. Their mean is ~34° from the three,
    # outside the 10° inlier bound, so seeding from the mean found no inliers.
    true_down = np.array([0.0, 0.0, -1.0])
    measured = np.array([true_down, true_down, true_down, [1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
    decided = level(np.array([true_down] * 5), measured)
    assert decided.source == "gravity" and decided.gravity_frames == 5
    assert math.degrees(math.acos(np.clip(decided.down @ true_down, -1, 1))) < 1e-6
    # Seeding is bounded: thousands of measurements use a spread of candidates.
    many = np.array([true_down] * 3000 + [[1.0, 0.0, 0.0]] * 1000)
    assert level(np.array([true_down] * 10), many).source == "gravity"


def test_too_few_or_disagreeing_measurements_fall_back_to_the_cameras():
    true_down = np.array([0.0, 0.0, -1.0])
    cameras = np.array([true_down] * 10)
    assert level(cameras, np.zeros((0, 3))).source == "cameras"
    assert level(cameras, np.array([true_down, true_down])).source == "cameras"  # fewer than three
    scattered = np.array([rotation([1, 0, 0], a) @ true_down for a in (0, 40, 80, 120, 160)])
    assert level(cameras, scattered).source == "cameras"  # no consensus, and far from the cameras
    # Centred on the cameras' own up, so only the lack of agreement refuses it.
    noisy = np.array([rotation(axis, a) @ true_down for axis in ([1, 0, 0], [0, 1, 0]) for a in (-35, -20, 0, 20, 35)])
    decided = level(cameras, noisy)
    assert decided.source == "cameras" and decided.gravity_frames == 10


def test_the_manifest_gravity_reaches_the_solver():
    import json
    from pathlib import Path

    from goway_reconstruction.contract import SceneInputManifest
    from goway_reconstruction.recon.job import sfm_frame

    raw = json.loads((Path(__file__).resolve().parents[1] / "contract" / "fixtures" / "scene_input_manifest.json").read_text())
    manifest = SceneInputManifest.model_validate(raw)
    anchor = (manifest.anchor.latitude, manifest.anchor.longitude)
    frames = {f.frameId: sfm_frame(f, f"{f.sequenceGroup}/{f.frameId}.jpg", None, anchor) for f in manifest.frames}
    assert frames["f-01"].gravity == (0.0346, 0.9919, 0.1219)
    assert frames["f-02"].gravity is None
