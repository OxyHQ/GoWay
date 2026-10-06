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
