import torch

from goway_reconstruction.recon.train import affine_colour_fit


def test_recovers_an_affine_colour_map():
    gen = torch.Generator().manual_seed(0)
    pred = torch.rand(50_000, 3, generator=gen)
    M = torch.tensor([[0.9, 0.05, 0.0], [0.02, 1.1, 0.03], [0.0, -0.04, 0.95]])
    b = torch.tensor([0.02, -0.01, 0.03])
    got_M, got_b = affine_colour_fit(pred, pred @ M.T + b)
    assert torch.allclose(got_M, M, atol=1e-4)
    assert torch.allclose(got_b, b, atol=1e-4)


def test_degenerate_samples_fall_back_to_identity():
    pred = torch.full((100, 3), 0.5)
    got_M, got_b = affine_colour_fit(pred, pred)
    assert torch.equal(got_M, torch.eye(3))
    assert torch.equal(got_b, torch.zeros(3))


def test_misregistered_cameras_are_outliers_but_a_walk_is_not():
    import numpy as np

    from goway_reconstruction.recon.train import inlier_cameras

    walk = np.stack([np.linspace(0, 100, 200), np.zeros(200), np.zeros(200)], 1)
    assert inlier_cameras(walk).all()
    lingered = np.concatenate([np.zeros((800, 3)), walk])  # stood still, then walked
    assert inlier_cameras(lingered).all()
    two_captures = np.concatenate([walk, walk + [300.0, 0.0, 0.0]])  # one area, captured twice apart
    assert inlier_cameras(two_captures).all()
    stray = np.concatenate([walk, [[32_000.0, 5.0, 0.0]]])
    assert inlier_cameras(stray).tolist() == [True] * 200 + [False]
    # a panorama whose views the solve scattered: none of them has neighbours
    rng = np.random.default_rng(0)
    scattered = np.concatenate([walk, rng.uniform(-5_000, 5_000, (8, 3))])
    assert inlier_cameras(scattered).tolist() == [True] * 200 + [False] * 8
