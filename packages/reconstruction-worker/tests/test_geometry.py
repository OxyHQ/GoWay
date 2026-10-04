import math

import numpy as np

from goway_reconstruction.recon.sfm import SfmFrame, _pairs, _similarity_2d, enu_to_geodetic, geodetic_to_enu


def test_enu_round_trip():
    lat0, lon0 = 48.87, 2.30
    e, n, _ = geodetic_to_enu(48.8705, 2.3012, 0, lat0, lon0, 0)
    assert 80 < e < 95 and 50 < n < 60
    lat, lon = enu_to_geodetic(e, n, lat0, lon0)
    assert abs(lat - 48.8705) < 1e-7 and abs(lon - 2.3012) < 1e-7


def test_similarity_recovers_known_transform():
    rng = np.random.default_rng(1)
    src = rng.uniform(-50, 50, (20, 2))
    theta = 0.7
    rot = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    dst = 3.5 * src @ rot.T + np.array([10.0, -4.0])
    s, r, t = _similarity_2d(src, dst)
    assert abs(s - 3.5) < 1e-6 and np.allclose(r, rot) and np.allclose(t, [10, -4])


def test_pairs_are_bounded_not_all_vs_all():
    frames = []
    for g in range(3):
        for i in range(60):
            frames.append(SfmFrame(f"{g}-{i}", f"g{g}", i, f"g{g}/{g}-{i}.jpg", 100, 100, i * 3.0, g * 4.0, 0, None))
    far = SfmFrame("far", "g9", 0, "g9/far.jpg", 100, 100, 5000, 5000, 0, None)
    pairs = _pairs(frames + [far])
    n = len(frames) + 1
    assert len(pairs) < n * (n - 1) / 2 / 3
    assert not any("far" in a or "far" in b for a, b in pairs)
    # different sequences near each other do get compared
    assert any(a.startswith("g0/") and b.startswith("g1/") for a, b in pairs)
