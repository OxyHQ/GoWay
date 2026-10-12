# Vendored: RaCo (network code only)

- Upstream: <https://github.com/cvg/RaCo> — "RaCo: Ranking and Covariance for
  Practical Learned Keypoints", Shenoi, Lindenberger, Sarlin, Pollefeys (3DV 2026).
- Commit: `35790eb48074ed14839d0fb496b8806caa4e766b`
- Licence: Apache License 2.0 (`LICENSE` in this directory is the upstream
  licence text, unchanged).
- Used by: `recon/features.py`, to run the `raco.pth` weights of the upstream
  `v1.0.0` release (pinned in `models.py`).

## Why vendored instead of installed

The upstream package depends on `opencv-python` (which conflicts with the
worker's `opencv-python-headless`), `matplotlib`, and an unpinned
`lightglue @ git+…`. The network itself needs only PyTorch and torchvision.

## What is here

`model.py` is upstream `raco/raco.py`: the detector, the ranker head and the
covariance head. Not vendored: `raco/utils.py` (image loading and resizing,
which `recon/features.py` does itself), `raco/viz2d.py`, `hubconf.py` and the
notebooks.

## Modifications (Apache-2.0 §4(b))

1. The `from .utils import ImagePreprocessor` import, the `preprocess_conf`
   attribute and the `extract()` method are removed; callers resize the image
   and call `forward()`.
2. The constructor no longer downloads or loads weights (it loaded them with
   `strict=False` from a URL and printed a line). `weights` defaults to `None`
   and passing one raises: the worker loads the digest-verified state dict
   itself with `strict=True`.
3. Added `__init__.py` and this README.
