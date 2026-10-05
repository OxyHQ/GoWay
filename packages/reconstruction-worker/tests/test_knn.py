import torch

from goway_reconstruction.recon.train import _knn_scale


def test_knn_scale_matches_all_pairs_distances():
    points = torch.rand(2000, 3, generator=torch.Generator().manual_seed(0))
    expected = torch.cdist(points, points).topk(4, largest=False).values[:, 1:].mean(1).clamp(min=1e-4)
    assert torch.allclose(_knn_scale(points), expected, atol=1e-5)


def test_knn_scale_floors_duplicate_points():
    points = torch.zeros(10, 3)
    assert torch.all(_knn_scale(points) == 1e-4)
