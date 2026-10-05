# `packages/reconstruction-worker`

The GoWay Street 3D reconstruction worker. It consumes durable AWS SQS jobs,
turns raw contributions into privacy-safe derivatives, solves camera geometry,
trains Gaussian scenes and reports versioned results. The backend owns every
decision about publishing them. Design: [`docs/STREET3D_PIPELINE.md`](../../docs/STREET3D_PIPELINE.md).

## Why Python lives here

The SfM / 3DGS ecosystem (COLMAP, gsplat, PyTorch) is Python/CUDA-first. GoWay
does not force GPU reconstruction code into TypeScript for language
uniformity. The worker still belongs under `packages/*` and is driven by
reproducible root commands. It is not a Bun workspace member.

## Requirements

- Linux (WSL2 works) with an NVIDIA GPU and its driver. Nothing else from the
  host: Python, PyTorch, the CUDA compiler and headers are pinned in `uv.lock`
  and installed by `uv`.
- [`uv`](https://docs.astral.sh/uv/).
- Local disk for the cache and scratch (`min_free_disk_gb`, default 30 GB).

## Commands

```bash
bun run worker:setup                     # uv sync --locked; verify models; compile GPU kernels
bun run worker:doctor                    # GPU, toolchain, models, disk, AWS access
bun run worker:doctor -- ARGS=--smoke    # plus a GPU train/encode/render smoke test
bun run worker:run                       # consume jobs until drained
bun run worker:run -- ARGS="--max-jobs 10 --max-hours 4"
make -C packages/reconstruction-worker status   # queue, ledger, cache, scratch
make -C packages/reconstruction-worker drain    # finish the current job, then stop
make -C packages/reconstruction-worker test
```

`SIGTERM`/`Ctrl-C` also drain: the current job finishes (or reaches its next
safe checkpoint) before the process exits.

## Configuration

Copy `config.example.toml` to `~/.config/goway-worker/config.toml` and fill in
the queue URLs and bucket. That file stays on the worker host and is never
committed. Every key can also be set as `GOWAY_WORKER_*` in the environment.

### Credentials

The worker holds no long-lived AWS key. Its AWS profile uses a
`credential_process` (AWS IAM Roles Anywhere's signing helper) that exchanges a
locally stored X.509 certificate for one-hour role credentials:

```ini
# ~/.aws/config on the worker host
[profile goway-worker]
credential_process = aws_signing_helper credential-process --certificate <cert.pem> --private-key <key.pem> --trust-anchor-arn <arn> --profile-arn <arn> --role-arn <arn>
```

The role can only receive, extend and delete messages on the jobs queue, send
to the events queue, read `captures/`, `derived/` and `jobs/`, and write
`derived/` and `jobs/` in the temporary bucket. Revoking the certificate revokes
the worker. No inbound port is ever opened: every connection is outbound HTTPS
to AWS.

## What runs, in order

1. **`capture_privacy`**: download one raw object (digest-checked), decode it
   (EXIF orientation applied; video reduced to sharp keyframes), detect faces,
   plates, people and vehicles, destroy those regions, re-encode without any
   metadata, and upload the derivative and a training mask. Any failure is
   `privacy_failed` or `corrupt_input`. Nothing partial is reported. A capture
   declared 360° is first verified against its own projection metadata and its
   2:1 pixels, then each panorama is cut into eight 90° views that are
   processed one by one, with the nadir always masked
   (`docs/STREET3D_PIPELINE.md` → 360° captures).
2. **`scene_reconstruct`**: fetch the backend's input manifest and the listed
   derivatives (through the content cache), solve cameras with bounded matching
   (the views of one panorama as a rig),
   georeference with a robust fit, seed the Gaussians with a dense point cloud
   fused from pose-conditioned multi-view depth (`recon/dense.py`; only depth
   that neighbouring frames confirm, and it falls back to the sparse points on
   any failure), train Gaussians within the profile's budget,
   encode SPZ plus a preview LOD, decode and render the encoded asset as a smoke
   test, and evaluate every gate. Assets are uploaded only when the gates pass.

## Contract

`contract/fixtures/*.json` are the canonical job, manifest, result and event
documents. `tests/test_contract.py` parses them with the worker's pydantic models
and the backend parses the same files with zod. Change both or neither.

## Licences

See [`LICENSES.md`](./LICENSES.md): code and model weights are reviewed
separately, and every weight file is pinned by SHA-256.

## Boundary

This package is **internal**. COLMAP, gsplat, the detectors and the SPZ encoder
are replaceable implementation details, never public GoWay contracts. What
consumers see is the backend's published scene manifest in `@goway.to/sdk`.
