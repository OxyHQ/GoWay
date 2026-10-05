# Vendored: Depth Anything 3 (network code only)

- Upstream: <https://github.com/ByteDance-Seed/Depth-Anything-3>
- Commit: `3d835ec1a5802d64a8b8b15f817a1ab54809bfe4`
- Licence: Apache License 2.0, copyright ByteDance Ltd. and/or its affiliates
  (`LICENSE` in this directory is the upstream licence text, unchanged).
- Used by: `recon/dense.py`, to run the **DA3-BASE** checkpoint
  (`depth-anything/DA3-BASE`, Apache-2.0, pinned in `models.py`).

Only DA3-SMALL, DA3-BASE, DA3METRIC-LARGE and DA3MONO-LARGE weights are
Apache-2.0. The LARGE, GIANT and NESTED checkpoints are CC BY-NC 4.0 and must
never be loaded by this code; only `configs/da3-base.yaml` is vendored.

## What is here

The minimum needed to build the DA3-BASE network and run its forward pass:
`cfg.py`, `configs/da3-base.yaml`, `model/` (the any-view network, the DinoV2
backbone, the DualDPT depth head, the camera encoder and decoder, reference
view selection and their layer utilities) and the four `utils/` modules they
import (`alignment.py`, `constants.py`, `geometry.py`, `logger.py`).

Not vendored: `api.py`, the CLI, the Gradio app, services, benchmarks,
exporters, the 3D Gaussian head (`gsdpt.py`, `gs_adapter.py`,
`utils/gs_renderer.py`), ray-pose recovery (`utils/ray_utils.py`), the input and
output processors and pose alignment. The preprocessing and scale alignment that
`api.py` performs are re-implemented in `recon/dense.py` without its
dependencies (no xformers, open3d, gradio, moviepy, evo, e3nn, trimesh,
pycolmap or matplotlib, and no Hugging Face Hub client).

## Modifications (Apache-2.0 §4(b))

1. Every absolute import `depth_anything_3.…` (and the module paths inside
   `configs/da3-base.yaml`) is rewritten to
   `goway_reconstruction.vendor.depth_anything_3.…`.
2. `cfg.py`: OmegaConf replaced by `yaml.safe_load` and plain dicts; the
   global `eval` resolver, config inheritance and dotlist overrides removed;
   `create_object` only imports from inside this package and only supports
   `args: as_params`.
3. `model/da3.py`: `NestedDepthAnything3Net`, the ray-pose path and the 3D
   Gaussian head removed (requesting them raises `NotImplementedError`);
   `_wrap_cfg` returns a plain dict instead of an OmegaConf object.
4. `model/__init__.py`: exports only `DepthAnything3Net`.
5. `model/dinov2/layers/swiglu_ffn.py`: the optional xformers `SwiGLU` import
   removed; the pure-PyTorch `SwiGLUFFN` is always used (DA3-BASE uses the MLP
   FFN either way).
6. `utils/constants.py`: trimmed to `THRESH_FOR_REF_SELECTION`.
7. `utils/logger.py`: logs through the standard `logging` module at DEBUG
   level instead of printing coloured text.
8. `utils/geometry.py`: `affine_inverse` is a plain function rather than
   `@torch.jit.script` (deprecated); the computation is unchanged.
9. Added `__init__.py` files for `vendor/depth_anything_3`, `utils` and
   `model/utils`, and this README.

With the pinned weights, the vendored network and `recon/dense.py` reproduce
upstream `DepthAnything3.inference` depth to float precision.
