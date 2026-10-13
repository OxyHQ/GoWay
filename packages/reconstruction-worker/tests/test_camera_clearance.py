"""The air around a camera stays clear: what holds or hazes a camera is cleared, real surfaces near it are not."""

import math

import torch

from goway_reconstruction.recon.train import crowds_camera

IDENTITY = [1.0, 0.0, 0.0, 0.0]  # wxyz
WIDE = 0.5  # focal over long side of a 90° view


def _crowded(means, scales, opacities, cameras, quats=None, **kwargs):
    return crowds_camera(
        torch.tensor(means, dtype=torch.float32),
        torch.tensor(scales, dtype=torch.float32),
        torch.tensor(quats or [IDENTITY] * len(means), dtype=torch.float32),
        torch.tensor(opacities, dtype=torch.float32),
        torch.tensor(cameras, dtype=torch.float32).reshape(-1, 3),
        WIDE,
        **kwargs,
    ).tolist()


def test_an_opaque_gaussian_crowds_a_camera_only_by_holding_it():
    crowded = _crowded(
        means=[
            [0.03, 0.0, 0.02],  # a wide blob a few centimetres from the camera
            [0.0, 0.0, -0.15],  # ground under the camera: wide, but thin along the vertical
            [0.0, 0.5, 0.0],  # a wall half a unit away, thin across
            [3.0, 0.0, 0.0],  # a large Gaussian far from every camera
            [0.0, 0.0, 0.02],  # a small speck right by the camera, not around it
        ],
        scales=[[0.2, 0.1, 0.3], [0.5, 0.5, 0.005], [0.4, 0.004, 0.4], [0.5, 0.5, 0.5], [0.003, 0.003, 0.003]],
        opacities=[0.9] * 5,
        cameras=[[0.0, 0.0, 0.0]],
    )
    assert crowded == [True, False, False, False, False]


def test_haze_is_faint_and_fills_much_of_the_view():
    crowded = _crowded(
        means=[[0.35, 0.0, 0.0]] * 2 + [[0.2, 0.0, 0.0]] * 2 + [[3.0, 0.0, 0.0], [0.0, 0.0, -0.15]],
        scales=[
            [0.1, 0.1, 0.1],  # faint, outside 3σ of the camera, spanning 0.86 of the view: haze
            [0.1, 0.1, 0.1],  # the same, opaque: a surface, kept
            [0.01, 0.01, 0.01],  # faint but small on screen: kept
            [0.04, 0.04, 0.04],  # faint, spanning 0.6 of the view: haze
            [0.1, 0.1, 0.1],  # faint but far away: kept
            [0.5, 0.5, 0.005],  # a faint sheet just under the camera: haze (an opaque one is ground)
        ],
        opacities=[0.01, 0.6, 0.01, 0.04, 0.01, 0.02],
        cameras=[[0.0, 0.0, 0.0]],
    )
    assert crowded == [True, False, False, True, False, True]


def test_holding_takes_the_rotation_into_account():
    # A thin slab tilted 90° about x: its thin axis then runs along world z.
    half = math.sqrt(0.5)
    slab = {"means": [[0.0, 0.0, 0.0]], "scales": [[0.5, 0.005, 0.5]], "opacities": [0.9]}
    along_y, along_z = [[0.0, 0.2, 0.0]], [[0.0, 0.0, 0.2]]
    assert _crowded(**slab, cameras=along_y) == [False]
    assert _crowded(**slab, cameras=along_z) == [True]
    assert _crowded(**slab, cameras=along_y, quats=[[half, half, 0.0, 0.0]]) == [True]
    assert _crowded(**slab, cameras=along_z, quats=[[half, half, 0.0, 0.0]]) == [False]


def test_chunks_and_many_cameras_agree_with_one_pass():
    gen = torch.Generator().manual_seed(0)
    means = torch.rand((5000, 3), generator=gen) * 4 - 2
    scales = torch.rand((5000, 3), generator=gen) * 0.3 + 0.001
    quats = torch.nn.functional.normalize(torch.randn((5000, 4), generator=gen), dim=1)
    opacities = torch.rand(5000, generator=gen) * 0.2
    cameras = torch.rand((40, 3), generator=gen) * 4 - 2
    whole = crowds_camera(means, scales, quats, opacities, cameras, WIDE, chunk=1 << 20)
    chunked = crowds_camera(means, scales, quats, opacities, cameras, WIDE, chunk=333)
    assert whole.any() and not whole.all()
    assert torch.equal(whole, chunked)


def test_no_cameras_crowds_nothing():
    assert _crowded([[0.0, 0.0, 0.0]], [[1.0, 1.0, 1.0]], [0.01], []) == [False]
