import numpy as np

from goway_reconstruction.recon import spz


def cloud(n=500, degree=1, seed=0):
    rng = np.random.default_rng(seed)
    q = rng.normal(size=(n, 4)).astype(np.float32)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    k = {0: 0, 1: 3, 2: 8, 3: 15}[degree]
    return spz.GaussianCloud(
        means=rng.uniform(-200, 200, (n, 3)).astype(np.float32),
        quats=q,
        scales=rng.uniform(-6, 1, (n, 3)).astype(np.float32),
        opacities=rng.uniform(-4, 4, n).astype(np.float32),
        sh0=rng.uniform(-1.5, 1.5, (n, 3)).astype(np.float32),
        shN=rng.uniform(-0.5, 0.5, (n, k, 3)).astype(np.float32),
    )


def test_round_trip_within_quantisation():
    c = cloud()
    d = spz.decode(spz.encode(c))
    assert d.count == c.count and d.sh_degree == 1
    assert np.abs(d.means - c.means).max() <= 0.5 / 4096 + 1e-6
    assert np.abs(d.scales - c.scales).max() <= 1 / 32 + 1e-6
    assert np.abs(d.sh0 - c.sh0).max() <= 0.5 / (0.15 * 255) + 1e-6
    # q and -q are the same rotation
    dots = np.abs((d.quats * c.quats).sum(1))
    assert dots.min() > 0.999


def test_header_and_determinism():
    data = spz.encode(cloud(degree=0))
    assert data == spz.encode(cloud(degree=0))  # gzip mtime pinned: identical bytes
    import gzip, struct

    magic, version, n, degree, frac, flags, _ = struct.unpack_from("<IIIBBBB", gzip.decompress(data))
    assert (magic, version, n, degree, frac) == (0x5053474E, 3, 500, 0, 12)


def test_refuses_out_of_range_scene():
    c = cloud()
    c.means[0, 0] = 5000.0
    try:
        spz.encode(c)
    except ValueError:
        return
    raise AssertionError("expected a range error")
