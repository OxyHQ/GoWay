"""Rig-aware pairing for views cut from 360° panoramas."""

import numpy as np

from goway_reconstruction.privacy.panorama import cam_from_pano
from goway_reconstruction.recon.sfm import (
    RIG_CROSS_SEQUENCE_CAP,
    RigView,
    SfmFrame,
    _pairs,
    frame_image_name,
    rig_configs,
)


def panoramas(group: str, count: int, *, east0: float = 0.0, north: float = 0.0, step: float = 2.0, heading: float | None = None, drop=()):
    frames = []
    for p in range(count):
        for k in range(8):
            if (p, k) in drop:
                continue
            rig = RigView(panorama=f"{group}-asset-{p:05d}", yaw=k * 45.0, fov=90.0)
            frames.append(
                SfmFrame(
                    f"{group}-{p}-{k}", group, p * 8 + k, frame_image_name(group, f"{group}-{p}-{k}", 1280, 960, rig),
                    1280, 960, east0 + p * step, north, 0.0, None, rig=rig,
                    heading=None if heading is None else (heading + k * 45.0) % 360,
                )
            )
    return frames


def view(frames, p: int, k: int, group: str = "g"):
    return next(f for f in frames if f.frame_id == f"{group}-{p}-{k}")


def paired(pairs, a, b) -> bool:
    return tuple(sorted((a.image_name, b.image_name))) in pairs


def test_views_of_one_panorama_share_a_name_after_their_sensor_prefix():
    frames = panoramas("g", 1)
    suffixes = {f.image_name.rsplit("/", 1)[-1] for f in frames}
    prefixes = {f.image_name.rsplit("/", 1)[0] for f in frames}
    assert len(suffixes) == 1 and len(prefixes) == 8


def test_same_panorama_pairs_only_overlapping_neighbours():
    frames = panoramas("g", 3)
    pairs = set(_pairs(frames))
    assert paired(pairs, view(frames, 1, 0), view(frames, 1, 1))  # 45° apart: overlap
    assert paired(pairs, view(frames, 1, 0), view(frames, 1, 7))  # across 0°/360°
    assert not paired(pairs, view(frames, 1, 0), view(frames, 1, 2))  # 90° apart: none
    assert not paired(pairs, view(frames, 1, 0), view(frames, 1, 4))


def test_each_yaw_runs_along_the_sequence_with_turning_neighbours():
    frames = panoramas("g", 30)
    pairs = set(_pairs(frames))
    assert paired(pairs, view(frames, 0, 2), view(frames, 5, 2))  # same yaw, five panoramas on
    assert paired(pairs, view(frames, 0, 2), view(frames, 20, 2))
    assert not paired(pairs, view(frames, 0, 2), view(frames, 25, 2))  # beyond the window, not a jump
    assert paired(pairs, view(frames, 3, 2), view(frames, 4, 3))  # turning: neighbouring yaw, next panorama
    assert paired(pairs, view(frames, 3, 2), view(frames, 5, 4))  # 90° apart but displaced: may overlap
    assert not paired(pairs, view(frames, 3, 2), view(frames, 4, 6))  # facing away
    assert not paired(pairs, view(frames, 3, 2), view(frames, 10, 3))  # turning only nearby


def test_rig_pairs_are_bounded_and_never_self():
    frames = panoramas("g", 60)
    pairs = _pairs(frames)
    assert all(a != b for a, b in pairs)
    assert len(pairs) < 60 * 8 * 60  # far below all-vs-all (≈ 115k)
    per_view: dict[str, int] = {}
    for a, b in pairs:
        per_view[a] = per_view.get(a, 0) + 1
        per_view[b] = per_view.get(b, 0) + 1
    # Rig neighbours (~80) plus the spatial loop-closure budget plain frames also get.
    assert max(per_view.values()) < 160


def test_missing_views_do_not_shift_the_sequence():
    frames = panoramas("g", 4, drop={(1, 0), (1, 1)})
    pairs = set(_pairs(frames))
    assert paired(pairs, view(frames, 0, 2), view(frames, 1, 2))
    assert paired(pairs, view(frames, 1, 2), view(frames, 2, 2))


def test_cross_sequence_views_facing_apart_are_not_paired():
    a = panoramas("a", 3, heading=0.0)
    b = panoramas("b", 3, north=4.0, heading=0.0)
    pairs = set(_pairs(a + b))
    assert paired(pairs, view(a, 1, 2, "a"), view(b, 1, 2, "b"))  # both face east
    assert not paired(pairs, view(a, 1, 2, "a"), view(b, 1, 6, "b"))  # east against west


def test_degenerate_priors_keep_rig_cross_pairs_capped():
    a = panoramas("a", 40, step=0.0)
    b = panoramas("b", 40, step=0.0)
    pairs = _pairs(a + b)
    cross: dict[str, int] = {}
    for x, y in pairs:
        if x.split("/")[-1].startswith("a") != y.split("/")[-1].startswith("a"):
            cross[x] = cross.get(x, 0) + 1
    names_a = {f.image_name for f in a}
    assert max(n for name, n in cross.items() if name in names_a) <= RIG_CROSS_SEQUENCE_CAP * 2


def test_rig_config_matches_the_view_cut():
    frames = panoramas("g", 3, drop={(0, 0), (1, 0)})
    (config,) = rig_configs(frames)
    cameras = config.cameras
    assert cameras[0].ref_sensor and not any(c.ref_sensor for c in cameras[1:])
    prefixes = {f.image_name.rsplit("/", 1)[0] + "/" for f in frames}
    assert {c.image_prefix for c in cameras} == prefixes
    reference_yaw = next(f.rig.yaw for f in frames if f.image_name.startswith(cameras[0].image_prefix))
    assert reference_yaw != 0.0  # the yaw seen most often, not a yaw some panoramas lack
    for camera in cameras[1:]:
        yaw = next(f.rig.yaw for f in frames if f.image_name.startswith(camera.image_prefix))
        expected = cam_from_pano(yaw) @ cam_from_pano(reference_yaw).T
        assert np.allclose(camera.cam_from_rig.rotation.matrix(), expected, atol=1e-9)
        assert np.allclose(camera.cam_from_rig.translation, 0)


def test_plain_frames_are_paired_as_before():
    plain = [SfmFrame(f"p-{i}", "p", i, f"p/p-{i}.jpg", 100, 100, i * 3.0, 0, 0, None) for i in range(30)]
    assert rig_configs(plain) == []
    pairs = set(_pairs(plain))
    assert ("p/p-0.jpg", "p/p-1.jpg") in pairs and ("p/p-0.jpg", "p/p-20.jpg") in pairs
