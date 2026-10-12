# Street 3D reconstruction pipeline

Part of [#16](https://github.com/OxyHQ/GoWay/issues/16): the path from a
privacy-cleared contribution to a published, versioned Gaussian scene. Expiry of
raw captures is in [`STREET3D_LIFECYCLE.md`](./STREET3D_LIFECYCLE.md); this file
covers everything after an upload is finalized.

```text
contributor ──PUT──▶ S3 captures/ (raw, temporary)
                         │
backend scheduler ──SQS jobs──▶ external worker ──S3 derived/, jobs/──▶
        ▲                                     │
        └──────────── SQS events ◀────────────┘
backend validates ──copy──▶ public scene bucket (CDN) ──▶ viewer
```

## Roles

| Component | Owns |
| --- | --- |
| Backend (`packages/backend`) | Canonical job, scene and capture state in PostgreSQL; scheduling; input manifests; result validation; publication; moderation; cleanup. |
| SQS `jobs` queue | At-least-once delivery of job envelopes. The visibility timeout is the worker lease. Redrives to a DLQ after bounded receives. |
| SQS `events` queue | Worker → backend progress, heartbeats, completion and failure. The worker never calls the GoWay API and needs no GoWay credential. |
| External worker (`packages/reconstruction-worker`) | Privacy preprocessing, matching, SfM, georeferencing, Gaussian training, compression, quality metrics. Outbound HTTPS to AWS only. |
| Temporary bucket | `captures/` raw media, `derived/` privacy-safe derivatives, `jobs/` manifests and attempt outputs. Never versioned, never public. |
| Scene bucket | Published scene assets only, behind a CDN. Written by the backend after validation, never by the worker. |

The worker may be offline for days. Nothing user-facing waits for it: jobs queue,
captures report `privacy pending` or `waiting for overlap`, and the map keeps
working.

## Job contract

The envelope, the input manifests, the events and the results are versioned JSON
(`schemaVersion: 1`). The canonical fixtures live in
`packages/reconstruction-worker/contract/fixtures/`; the backend's zod parser and
the worker's pydantic models are both tested against the same files, so the two
languages cannot drift silently. Database rows are never serialized into SQS.

Two job types exist:

- `capture_privacy` — one asset. Downloads the raw object, extracts keyframes
  from video (the sharpest frame of each window, the windows tiling the WHOLE
  recording: one per `minIntervalSeconds`, up to `maxFrames`, wider beyond),
  detects faces, plates, people and vehicles, writes privacy-safe derivatives
  (sensitive regions irreversibly blurred, metadata stripped) and training
  masks (people and vehicles excluded), and reports a verdict.
- `scene_reconstruct` — one scene version. Consumes ONLY privacy-safe
  derivatives listed in a backend-written input manifest, solves cameras,
  georeferences, trains, compresses, evaluates gates and writes a result.

### Idempotency

SQS delivers at least once. `jobId` is fixed when the backend creates the job
row; a scene version is unique per job, and the backend accepts exactly one
completion per job. Each attempt writes under `jobs/<jobId>/attempt-<n>/`, so a
duplicate delivery cannot overwrite another attempt's outputs. A worker that
finds a valid `result.json` for its job re-reports it instead of recomputing.

### Leases, heartbeats and recovery

- The worker extends the message's visibility while it works and emits a
  `heartbeat` event at the same cadence.
- A crash or network loss stops both; SQS redelivers after the visibility
  timeout, and the backend marks a job with a stale heartbeat as `retry_wait`.
- A restarted worker removes stale scratch directories, then resumes training
  from a local checkpoint if the same job and inputs are redelivered to it.
- The message is deleted only after the outputs are uploaded and the
  `completed` or terminal `failed` event has been sent.
- After bounded receives the message moves to the DLQ, and the backend marks
  the job `failed`.

### Cancellation and supersession

The backend cancels by writing `jobs/<jobId>/cancel`. The worker checks for it
before every expensive stage and stops at the next safe checkpoint. A job is
cancelled when its sources are removed or blocked, when a newer job for the same
scene supersedes it, or when an operator cancels it.

### Failure classes

`insufficient_overlap`, `camera_solve_failed`, `georeference_failed`,
`privacy_failed`, `out_of_memory`, `corrupt_input`, `quality_failed`,
`worker_interrupted`, `cancelled`, `internal`. Only `out_of_memory`,
`worker_interrupted` and `internal` are retryable. `insufficient_overlap` returns
the scene to `needs_more_capture` and never retries GPU work.

## Privacy gate

A capture is a reconstruction input only after the backend records a `passed`
verdict naming the privacy pipeline version (`capture_assets` makes the
eligibility column generated, so no other path can open it). The worker fails
closed: a missing model, a checksum mismatch, a detector error or derivative
metadata that survives stripping all produce `privacy_failed` and no derivative
is reported. The current version is `goway-privacy/3`
(`goway_reconstruction/__init__.py` says what each version changed).

Derivatives are re-encoded pixels only (no EXIF, XMP, ICC or maker notes),
sRGB: a photo's embedded profile (an iPhone's Display P3) and a video's colour
signalling (matrix, range, primaries; HLG and PQ HDR tone-mapped) are converted
into the pixels before the metadata is dropped. HEIC is decoded (`pillow-heif`).
JPEG q95, 4:4:4; a photo keeps up to 4096 px (`keyframe*` in `STREET3D_POLICY`).

Blur and exclusion are separate regions (`privacy/redact.py`):

- **Destroyed** (mosaic, then blur; the cell grows with the frame, so a higher
  resolution never leaves more of a face): faces, the heads of detected people,
  detected plates, every person and vehicle within its instance outline, and
  the plate band of every vehicle box (its lower 60 %, a two-wheeler's whole
  box) — so a plate the plate detector missed is still unreadable.
- **Excluded** from features, training and the dense point cloud: everything
  destroyed, plus a margin (16 px around boxes, the soft edge around
  outlines), so blur never becomes appearance. The rest of a vehicle's box —
  road, kerb, shopfront — is kept. The trainer downsamples masks by area and
  keeps only pixels whose every source pixel is trusted.

Raw media is never read by matching or training.

The models and their licences are reviewed in
`packages/reconstruction-worker/LICENSES.md`. Code and model weights are reviewed
separately.

### 360° captures

A contribution declares `projection: "equirectangular"` for a full 360°
panorama, photo or video ([#91](https://github.com/OxyHQ/GoWay/issues/91)). The
upload policy publishes separate 360° ceilings (`equirectangular`: bytes,
duration, width); 360° acceptance has no switch.

- **The claim never decides.** The `capture_privacy` envelope carries the
  declaration. The worker reads the projection the bytes themselves carry —
  XMP `GPano:ProjectionType` (full sphere, not cropped) for a photo, Spherical
  Video V1 (`uuid` box) or V2 (`sv3d`/`proj`/`equi`, mono `st3d`) for a video —
  and checks every decoded frame is 2:1. Declared 360° without that evidence,
  evidence of 360° on a capture declared perspective, a cubemap, stereo or
  cropped panorama, or a frame that is not 2:1: `privacy_failed`.
- **Views, not panoramas.** Each panorama (the photo, or each video keyframe,
  streamed so a long 8K video is never held whole) is cut into 14 perspective
  views with a 90° horizontal field of view: 8 at pitch 0 (yaw 0°, 45° …
  315°, neighbours overlapping by half) and 6 at pitch +45° (yaw 0°, 60° …
  300°) for the upper storeys a horizon view cuts off. A view is 4:3, as wide
  as the panorama's own pixels over 90° (a 5.7K camera gives 1440 × 1080, at
  most 2048), resampled straight from the decoded panorama. Detection,
  redaction and masking run on every view on its own; any failure fails the
  job. Blur is judged per panorama: a plain-sky view is kept, a panorama whose
  sharpest view is blurred is dropped whole.
- **The nadir is always masked.** Every view pixel more than 30° below the
  horizon is destroyed in the derivative and excluded from reconstruction,
  whether or not a detector saw the operator or the mount there. (There is no
  downward ring: below the horizon views lies almost only the nadir.)
- **Derivatives know their panorama.** Each view reports
  `panorama: { index, yawDegrees, pitchDegrees, horizontalFovDegrees }`
  (`index` is the keyframe; 0 for a photo), stored on `capture_derivatives`
  and handed back in the manifest. A view's prior heading is the capture's
  heading plus its yaw, and its intrinsics come from its field of view, not
  the 360° lens. `pitchDegrees` is absent from `goway-privacy/1` and `/2`
  views, which all look at the horizon; a later view whose manifest entry
  lacks it is solved as its own camera, never placed in the rig on a guess.
  The backend stores exactly what the worker stated
  (`capture_derivatives.panorama_pitch_degrees`, NULL when absent, and only
  on a view) and the manifest omits a NULL rather than write a 0 for it.
- **Fail closed at the backend too.** A result is refused, without retrying
  the attempt, unless its verified `projection` equals the declaration — so a
  worker that predates 360° support, which would process a panorama as one flat
  image, cannot open the gate. Views without a panorama verdict, or a panorama
  verdict without views, fail the contract on both sides.
- **The solve treats a panorama as a rig.** Views pair with the views of the
  same panorama whose axes lie within a field of view, with the same direction
  along the sequence (20 panoramas, plus exponential jumps), and with
  neighbouring directions in the next 4 panoramas; across sequences they pair
  spatially as any frame does, skipping views that face apart when both carry a
  heading. `pycolmap.apply_rig_config` then makes each panorama one rig frame
  whose sensors are its (yaw, pitch) directions, with the relative rotations
  fixed (`refine_sensor_from_rig` off). If the rig cannot be applied the solve
  continues on pairing alone. Georeferencing counts one position per panorama,
  not fourteen, and levels by each view's panorama "down", not the pitched
  view's own. Navigation viewpoints and the initial view use level views only.

### Motion priors

A guided recording carries the phone's measured gravity (`motion`, device
axes, timed from the start of the recording). The backend keeps the track only
until the privacy result arrives, then stores one gravity per keyframe in the
keyframe's camera axes (`capture_derivatives.gravity_*`) and hands it to the
solve as the manifest's optional `gravity`. The worker levels the placed scene
by it where enough frames agree, instead of assuming the phones were held
level. Design, measurements and limits:
[`STREET3D_MOTION_PRIORS.md`](./STREET3D_MOTION_PRIORS.md).

### Features

The camera solve matches local features between the bounded pairs, then COLMAP
verifies the matches geometrically and maps them (`recon/sfm.py`). The feature
set is one of three:

- `sift` — COLMAP's SIFT on the CPU;
- `aliked` — ALIKED-n16 detects and describes, LightGlue matches;
- `raco` — RaCo detects and its ranker keeps the most reliable points,
  ALIKED-n16 describes them, LightGlue+ (LightGlue retrained on RaCo
  keypoints) matches.

The learned sets run on the worker's PyTorch (`recon/features.py`, kornia and
the vendored RaCo network); the pycolmap wheel's own ALIKED needs an ONNX build
it does not ship. Every weight file is pinned by digest in `models.py` and
reviewed in `LICENSES.md`. Masks hold for every set: a keypoint survives only
on a fully trusted pixel, and masked points are dropped before the keypoint
budget is spent (`tests/test_features.py` checks each set).

Jobs use `FEATURES` in `recon/sfm.py`, recorded in the result's
`provenance.components.features`. It changes only on evidence from
`bench-sfm`, which solves a scene with each set and reports registered frames,
sparse points, reprojection error, track length, verified pairs and time, plus
held-out PSNR with `--train N` (the same budget for every set, no depth prior).
A job leaves `frames.json`, `images/` and `masks/` in its scratch, which is a
bench scene as it stands:

```sh
bun run worker:bench -- SCENE=<scene dir>
bun run worker:bench -- SCENE=<scene dir> ARGS="--features sift raco --train 7000"
```

A set replaces SIFT only if, on a Panoramax street sequence, a phone video and
a 360° panorama sequence, it registers at least as many frames with no higher
reprojection error and no lower held-out PSNR, within the job's time budget.

## Scheduling and the capture graph

- Captures cluster around scene anchors by `ST_DWithin` on the asset anchors, not
  by cell boundaries, so a scene can span geohash cells.
- A capture with no eligible neighbour is `waiting_for_overlap`.
- A scene is queued only when new information crosses configured thresholds: new
  eligible frames, new heading coverage, or at-risk inputs. A fixed `N new
  images` count alone is not used.
- Verified two-view matches from the solve become graph edges. Registered frames
  are `integrated`; unregistered frames return to `waiting_for_overlap`.

## Quality gates

A version is published only if all of these hold. The thresholds are
configuration.

- camera registration ratio
- mean reprojection error
- georeferencing inliers and median residual
- held-out PSNR
- Gaussian count and asset byte budget
- a viewer smoke test (decode and render the compressed asset)
- privacy versions of every input

A version that fails is `failed_quality`, and the scene keeps its previous
published version.

## Publication, disable and rebuild

On validation the backend copies the compressed assets to the scene bucket under
content-hashed keys, records the public manifest and marks the version
`published` (superseding the previous one). Disabling a version deletes its
public objects, invalidates the CDN path and hides it from the API at once.
Rebuilding queues a new version without blocked sources. Moderation blocks are
permanent: a blocked capture's derivatives never appear in a later input
manifest.

Published manifests carry no contributor identity, no device metadata and no
source object keys.

The worker publishes `spz` splats and a `jpeg` poster only. The contract's
`rad` level-of-detail format and `splat_environment` role are viewer formats
this pipeline does not produce: a result naming one is refused, because a
chunked RAD is many objects and publication copies one per asset. Today they
reach the scene bucket only through a [licensed import](#licensed-imports).

A result may report `viewpoints` (solved camera positions and facings, at most
2000) and a `captureFieldOfView`. They are published as the manifest's optional
`navigation`, so a viewer can walk where the scene was observed instead of
flying into unobserved space. Before storing, the backend rounds positions to
centimetres, sorts them by position, thins them so none is within 1.5 m of
another and keeps at most 1000: what is published is the set of places the
scene was seen from, never a capture sequence, a time or a contributor's path.
A licensed import's `navigation` may also state `reachMeters`, how far from a
capture position its scene holds up, and `captureHeightMeters`, how far above
the ground the rig carried its cameras (both published to the centimetre, only
with viewpoints); a worker reports neither, and the viewer derives the reach
from the field of view and assumes a hand-held height
(`docs/STREET3D_VIEWER.md`).

## Licensed imports

A scene GoWay licensed rather than reconstructed — the first is Kabukicho
Ichibangai, Shinjuku, a 3D Gaussian scan bought from Locahun 3D (Kawaii World
Industries Co., Ltd.), captured with an XGRIDS PortalCam on 2026-09-13/14 — is
published by an operator, not the worker:

```sh
bun run street3d:admin import-licensed --manifest=<import.json> --target-database=goway
```

- **A source, for life.** The scene and every version carry
  `source = 'licensed_import'` (a version's source is its scene's, by foreign
  key). It has no job (`job_id` is set iff `reconstruction`), no capture inputs
  and no edges. The schema refuses it a queued, reconstructing or
  needs-capture state, a rebuild request or a queued input set; formation never
  clusters a capture into it (contributions beside it form GoWay's own scene),
  `rebuild-scene` refuses it, and no withdrawal or block can reach it, having
  no inputs. Disable and enable work as for any version.
- **Licence as data.** `licence` records licensor, licence name and tier,
  grant reference and date, what it permits (`public_display`,
  `format_conversion`, `commercial_use`) and the command run that imported it.
  Both `public_display` and `format_conversion` are required: viewers get a
  converted level-of-detail tree and a poster. The public credit is the
  manifest's `attributions`; the licence itself is never served.
- **Privacy: attested, never bypassed.** The imagery never entered the capture
  privacy pipeline, so the version claims no pipeline version
  (`privacyPipelineVersions` is empty, by CHECK). The import manifest must
  carry `privacy: { basis, reviewedBy, note }` with `basis` one of
  `licensor_redacted` (the licensor delivered faces, plates and people
  removed, and GoWay reviewed the scene) or `goway_splat_review` (GoWay
  reviewed the splat and poster itself); without it nothing is uploaded or
  recorded. The public manifest gains only `privacyBasis`; who reviewed it and
  why stays in `privacy_attestation`.
- **Honest quality.** `heldOutPsnr` is absent (GoWay trained nothing to hold
  frames out of; the contract allows that). `registrationRatio` is 1,
  `alignmentResidualMeters` and `placement` come from the manifest, and
  `precise` is refused above `precisePlacementResidualMeters` (3 m). The
  profile is the smallest whose budget holds the tree's Gaussians and bytes,
  else the largest: a paged tree is never loaded whole. `provenance` is
  `import:licensed/1` with the manifest's components (capture device,
  converter versions) and the placement note.
- **Chunked RADs stay together.** The importer reads the RAD header (`RAD0`,
  metadata length, JSON, 8-byte padding; `street3d/radHeader.ts`) and requires
  every chunk it names beside it, at the declared size, starting `RADC`, under
  a plain `*.radc` name. Header and chunks are published under their own names
  in a directory named by the digest of the whole tree:
  `<prefix>/<sceneId>/v<version>/<treeSha256>/<name>-lod.rad` beside
  `<name>-lod-<n>.radc`, so the viewer's "beside the header" rule holds and no
  two trees ever share a key. A version's `assets` keep each chunk's key; purge
  deletes them, `status` counts them.
- **Idempotent.** Everything is validated and hashed before the first upload;
  uploads are PUTs (`Cache-Control: immutable`, S3-checked SHA-256) and the
  scene and version are recorded in one transaction. The import digest covers
  every manifest value and asset byte (not file paths), is the version's
  `result_sha256` and is unique among imports: a re-run records nothing and only
  restores missing objects. A re-run of a DISABLED version is refused rather
  than putting its bytes back online;
  `enable-version <id> --manifest=<import.json>` restores them from the same
  files, digest-checked. Naming `sceneId` publishes a new delivery as the
  scene's next version.

The manifest (paths relative to it; every viewer-facing value is parsed with
the public contract's schemas):

```json
{
  "schemaVersion": 1,
  "anchor": { "latitude": 35.69388, "longitude": 139.70224, "altitudeMeters": 39.5 },
  "enuFromScene": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  "initialView": { "position": [0, -20, 1.6], "target": [0, 10, 1.6] },
  "navigation": {
    "viewpoints": [{ "position": [0, -20, 1.6], "forward": [0, 1, 0] }],
    "fieldOfView": { "horizontalDegrees": 90, "verticalDegrees": 70 }
  },
  "footprint": { "type": "Polygon", "coordinates": [[[139.7013, 35.6930], [139.7031, 35.6930], [139.7031, 35.6948], [139.7013, 35.6948], [139.7013, 35.6930]]] },
  "bounds": { "west": 139.7013, "south": 35.6930, "east": 139.7031, "north": 35.6948 },
  "observedFrom": "2026-09-13T00:00:00+09:00",
  "observedTo": "2026-09-14T23:59:59+09:00",
  "attributions": ["3D scan © Kawaii World Industries Co., Ltd. (Locahun 3D)"],
  "licence": {
    "licensor": "Kawaii World Industries Co., Ltd. (Locahun 3D)",
    "name": "<licence name>", "tier": "<tier>",
    "grantReference": "<order or contract reference>", "grantedAt": "2026-09-20",
    "permits": ["public_display", "format_conversion", "commercial_use"]
  },
  "privacy": { "basis": "licensor_redacted", "reviewedBy": "<operator>", "note": "<what was checked>" },
  "placement": "approximate",
  "placementNote": "<how the scan was georeferenced>",
  "alignmentResidualMeters": 4,
  "provenance": { "components": { "capture": "XGRIDS PortalCam", "spark-build-lod": "2.3.1" } },
  "assets": { "splat": "kabukicho-lod.rad", "environment": "kabukicho-env-lod.rad", "poster": "poster.jpg" }
}
```

The command prints aggregate JSON (`imported`, `created`, `sceneId`,
`versionId`, `version`, `profile`, `objects`, `bytes`, `uploaded`) or
`{ "imported": false, "reason", "detail" }` naming a field or a file's role,
never a value or a path. It needs the scene bucket only — `STREET3D_SCENE_BUCKET`
(the backend task role's `s3:PutObject`/`s3:GetObject` on `<prefix>/*`) or, in
development, `STREET3D_SCENE_LOCAL_DIR` — and `STREET3D_PUBLIC_ASSET_BASE_URL`;
no queue or worker. Locally:

```sh
# packages/backend/.env
STREET3D_SCENE_LOCAL_DIR=../../.street3d-scenes
STREET3D_PUBLIC_ASSET_BASE_URL=http://127.0.0.1:8790

bun run street3d:admin import-licensed --manifest=/path/to/import.json --target-database=goway_dev
bun run street3d:serve-assets   # CORS, byte ranges, immutable; loopback only
```

## Retention

- Raw photos become deletion-eligible a short audit window after their
  privacy-safe derivative exists, and raw videos as soon as their keyframes do.
  The cleanup sweeper honours `deletionEligibleAt`.
- Derivatives expire under their own class (`privacy_safe_proxy`), and their
  protection can be extended a bounded number of times when they feed a nearly
  reconstructable, at-risk area.
- `jobs/` artifacts are temporary; training checkpoints never leave the worker.
- Published assets live in the scene bucket and survive the deletion of every
  input.

## Operating it

The backend half lives in `packages/backend/src/street3d/` (scheduler, adapters,
validation) and `src/db/street3d/` (every statement). Migration
`0006_goway_street3d` (`pre`) adds its tables; `0019` and `0020` (`pre`) add
scene and version sources for licensed imports.

### Configuring it

There is no switch. The read API is always on (it serves what is published).
The pipeline — and its in-process scheduler, ticking every 60 s after the
server listens — runs when everything it needs is configured, and not
otherwise; `/ready` never depends on it.

| Variable | Purpose |
| --- | --- |
| `AWS_REGION` | Queues and scene bucket (falls back to `CAPTURE_S3_REGION`). |
| `STREET3D_JOBS_QUEUE_URL`, `STREET3D_EVENTS_QUEUE_URL` | The two queues. |
| `STREET3D_JOBS_DLQ_URL` | Optional: the jobs DLQ, for `status` and failing dead-lettered jobs. |
| `STREET3D_SCENE_BUCKET` | Published assets, under `scenes/`. |
| `STREET3D_PUBLIC_ASSET_BASE_URL` | Origin the scene bucket is served from. |
| `STREET3D_SCENE_LOCAL_DIR` | Development only, never beside `STREET3D_SCENE_BUCKET`: a local directory standing in for the scene bucket, for licensed imports, served by `street3d:serve-assets`. |
| `STREET3D_CDN_DISTRIBUTION_ID` | Optional: invalidated on disable. |
| `CAPTURE_S3_*` | The temporary bucket; `derived/` and `jobs/` live beside `captures/`. |

Thresholds, gates and per-profile budgets are `STREET3D_POLICY` in
`packages/backend/src/config/street3d.ts` — code, not configuration; gates and
budgets are written into every input manifest and re-checked on the result.

Each tick drains events, fails dead-lettered jobs, recovers stale leases,
writes cancel markers, queues privacy passes, forms scenes, refreshes coverage,
dispatches the outbox and purges disabled versions. Phases are independently
safe under concurrency, so the in-process loop, `street3d:tick` and the admin
command can overlap. The attempt number travels as the SQS message attribute
`attempt`; envelopes are exactly the contract fixtures.

### Backend task role

| Resource | Actions |
| --- | --- |
| Temporary bucket `captures/*` | existing capture permissions (`s3:PutObject` via presign, `s3:GetObject`, `s3:DeleteObject`) |
| Temporary bucket `jobs/*` | `s3:PutObject` (manifests, cancel markers), `s3:GetObject` (results; source of copies), `s3:DeleteObject` |
| Temporary bucket `derived/*` | `s3:GetObject`, `s3:DeleteObject` |
| Temporary bucket | `s3:ListBucket` conditioned on `s3:prefix` `jobs/*` and `derived/*` |
| Scene bucket `<prefix>/*` | `s3:PutObject` (server-side copy target; a licensed import's uploads), `s3:GetObject` (HEAD verification), `s3:DeleteObject` |
| Jobs queue | `sqs:SendMessage`, `sqs:GetQueueAttributes` |
| Events queue | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` |
| Jobs DLQ (optional) | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` |
| CDN distribution (optional) | `cloudfront:CreateInvalidation` |

The external worker's role is separate: receive/delete/change-visibility on the
jobs queue, send on the events queue, read `captures/*`, `derived/*` and
`jobs/*`, write `derived/*` and `jobs/*`. It has no access to the scene bucket.
Use SSE-S3 or an AWS-managed key so neither role needs KMS grants; with a
customer-managed key add `kms:GenerateDataKey`/`kms:Decrypt` for both.

### Commands

```sh
bun run street3d:tick  --target-database=goway
bun run street3d:admin status                                   --target-database=goway
bun run street3d:admin disable-version <versionId> --reason "…" --target-database=goway
bun run street3d:admin enable-version  <versionId> [--manifest=<import.json>] --target-database=goway
bun run street3d:admin rebuild-scene   <sceneId> [--profile standard] --target-database=goway
bun run street3d:admin block-capture   <assetId> --reason "…"   --target-database=goway
bun run street3d:admin cancel-job      <jobId>                  --target-database=goway
bun run street3d:admin requeue-job     <jobId>                  --target-database=goway
bun run street3d:admin import-licensed --manifest=<import.json> --target-database=goway
```

The image ships them as `dist/src/street3d/runTick.js` and `runAdmin.js`. Both
assert the database and the migration ledger first, print aggregate JSON only
(no coordinates, keys, URLs or contributor ids) and exit 1 on refusal.

- `status` — queue depth (SQS reports no message age; `oldestWaitingJobAgeSeconds`
  comes from the job outbox), jobs by kind and state, summed GPU seconds,
  wall seconds, bytes and mean cache-hit ratio from job metrics, storage bytes by
  retention class (raw), by state (derivatives) and by version state (published
  assets), scenes by state and open reports (privacy reports separately). Reports
  never disable anything automatically.
- `disable-version` hides at once and purges the public objects (CDN invalidated)
  in the same command when the pipeline is configured; otherwise the next tick
  purges. `enable-version` succeeds only if every asset still exists in the scene
  bucket or can be restored, digest-verified, from the job's result while its
  `jobs/` artifacts are retained (a licensed import: from `--manifest`, the
  files it was imported from), and only if no registered input has since been
  withdrawn or blocked.
- `block-capture` is permanent: the capture's gate is `blocked`, its content hash
  is recorded so identical bytes are refused too, open jobs are cancelled, every
  version that registered it is disabled and purged, and a rebuild without it is
  requested. A blocked capture can never re-enter a manifest.
- Contributor withdrawal (`DELETE /captures/assets/:id`) cancels open jobs and
  deletes derivatives; a published version that used it stays until a rebuild
  replaces it (moderation is the path for immediate removal). Withdrawal and
  `block-capture` lock the capture's own jobs BEFORE they read its derivatives
  (`retractCaptureFromStreet3d`): a privacy completion writes derivatives while
  holding its job, so the retraction waits for it and then requests removal of
  what it wrote, instead of missing frames committed a moment earlier. The
  locks follow one order everywhere: job, media object, asset, motion track.
