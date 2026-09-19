# `packages/reconstruction-worker`

The GoWay Street 3D reconstruction worker. It consumes durable AWS SQS jobs,
solves camera geometry from privacy-processed captures and produces versioned
3D Gaussian scenes and manifests.

Implementation lands in [#12](https://github.com/OxyHQ/GoWay/issues/12). This
package currently exists to make the boundary explicit rather than bolting a
separate project on later.

## Why Python lives here

The SfM / 3DGS ecosystem (COLMAP, gsplat, PyTorch) is Python/CUDA-first.
GoWay does not force GPU reconstruction code into TypeScript for language
uniformity. The worker still belongs under `packages/*` and is driven by
reproducible root commands:

```bash
bun run worker:setup     # uv sync
bun run worker:doctor    # environment / CUDA / queue reachability checks
bun run worker:run       # consume jobs
```

The worker owns its own Python environment through `uv`; the Bun workspace
deliberately does not try to manage it, and `packages/reconstruction-worker` is
not a Bun workspace member.

## Contract boundary

This package is **internal**. COLMAP, gsplat, PlayCanvas/SuperSplat and every
other library choice here is a replaceable implementation detail, never a
public GoWay contract.

- Job and scene contracts shared with the backend live in
  `packages/shared-types`.
- Anything consumers can see belongs in `@goway.to/sdk`.
- Python implementation details must never become public SDK contracts.

The worker may be offline without breaking GoWay, and the same contract must
scale from one local RTX 5090 to multiple owned or cloud GPUs.
