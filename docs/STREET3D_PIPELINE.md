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
  from video, detects faces, plates, people and vehicles, writes privacy-safe
  derivatives (sensitive regions irreversibly blurred, metadata stripped) and
  training masks (people and vehicles excluded), and reports a verdict.
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
is reported.

Derivatives are re-encoded pixels only (no EXIF, XMP, ICC or maker notes). Faces,
plate regions and the heads of detected people are blurred irreversibly in the
derivative. People and vehicles are excluded from feature extraction and from the
training loss through masks, so they do not become geometry. Raw media is never
read by matching or training.

The models and their licences are reviewed in
`packages/reconstruction-worker/LICENSES.md`. Code and model weights are reviewed
separately.

### 360° captures

A contribution declares `projection: "equirectangular"` for a full 360°
panorama, photo or video ([#91](https://github.com/OxyHQ/GoWay/issues/91)). The
upload policy publishes separate 360° ceilings (`equirectangular`: bytes,
duration, width), and `CAPTURE_EQUIRECTANGULAR_ENABLED` switches acceptance off.

- **The claim never decides.** The `capture_privacy` envelope carries the
  declaration. The worker reads the projection the bytes themselves carry —
  XMP `GPano:ProjectionType` (full sphere, not cropped) for a photo, Spherical
  Video V1 (`uuid` box) or V2 (`sv3d`/`proj`/`equi`, mono `st3d`) for a video —
  and checks every decoded frame is 2:1. Declared 360° without that evidence,
  evidence of 360° on a capture declared perspective, a cubemap, stereo or
  cropped panorama, or a frame that is not 2:1: `privacy_failed`.
- **Views, not panoramas.** Each panorama (the photo, or each video keyframe,
  streamed so a long 8K video is never held whole) is resized so 90° spans one
  view width and cut into 8 perspective views of 1280 × 960 at yaw 0°, 45° …
  315°, pitch 0, 90° horizontal field of view — neighbours overlap by half.
  Detection, redaction and masking run on every view on its own; any failure
  fails the job.
- **The nadir is always masked.** Every view pixel more than 30° below the
  horizon is destroyed in the derivative and excluded from reconstruction,
  whether or not a detector saw the operator or the mount there.
- **Derivatives know their panorama.** Each view reports
  `panorama: { index, yawDegrees, horizontalFovDegrees }` (`index` is the
  keyframe; 0 for a photo), stored on `capture_derivatives` and handed back in
  the manifest. A view's prior heading is the capture's heading plus its yaw,
  and its intrinsics come from its field of view, not the 360° lens.
- **Fail closed at the backend too.** A result is refused, without retrying
  the attempt, unless its verified `projection` equals the declaration — so a
  worker that predates 360° support, which would process a panorama as one flat
  image, cannot open the gate. Views without a panorama verdict, or a panorama
  verdict without views, fail the contract on both sides.
- **The solve treats a panorama as a rig.** Views pair with their neighbouring
  yaws in the same panorama, with the same yaw along the sequence (20
  panoramas, plus exponential jumps), and with neighbouring yaws in the next 4
  panoramas; across sequences they pair spatially as any frame does, skipping
  views that face apart when both carry a heading. `pycolmap.apply_rig_config`
  then makes each panorama one rig frame whose sensors are its yaws, with the
  relative rotations fixed (`refine_sensor_from_rig` off). If the rig cannot be
  applied the solve continues on pairing alone. Georeferencing counts one
  position per panorama, not eight.

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

A result may report `viewpoints` (solved camera positions and facings, at most
2000) and a `captureFieldOfView`. They are published as the manifest's optional
`navigation`, so a viewer can move between observed positions instead of flying
into unobserved space. Before storing, the backend rounds positions to
centimetres, sorts them by position, thins them so none is within 1.5 m of
another and keeps at most 1000: what is published is the set of places the
scene was seen from, never a capture sequence, a time or a contributor's path.

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
`0006_goway_street3d` (`pre`) adds its tables.

### Switching it on

Nothing runs until configured; `/ready` never depends on it.

| Variable | Purpose |
| --- | --- |
| `STREET3D_SCHEDULER_ENABLED` | Run `tick()` in-process after the server listens (default `false`). |
| `STREET3D_SCHEDULER_INTERVAL_SECONDS` | Seconds between ticks (default 60). |
| `STREET3D_VIEWING_ENABLED` | Serve the public read API (default `false`). |
| `STREET3D_AWS_REGION` | Queues and scene bucket (falls back to `AWS_REGION`). |
| `STREET3D_JOBS_QUEUE_URL`, `STREET3D_EVENTS_QUEUE_URL` | The two queues. |
| `STREET3D_JOBS_DLQ_URL` | Optional: the jobs DLQ, for `status` and failing dead-lettered jobs. |
| `STREET3D_SCENE_BUCKET`, `STREET3D_SCENE_KEY_PREFIX` | Published assets (prefix default `scenes`). |
| `STREET3D_PUBLIC_ASSET_BASE_URL` | Origin the scene bucket is served from. |
| `STREET3D_CDN_DISTRIBUTION_ID` | Optional: invalidated on disable. |
| `CAPTURE_S3_*` | The temporary bucket; `derived/` and `jobs/` live beside `captures/`. |

Thresholds, gates and per-profile budgets are documented in
`packages/backend/.env.example`; gates and budgets are written into every input
manifest and re-checked on the result.

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
| Scene bucket `<prefix>/*` | `s3:PutObject` (server-side copy target), `s3:GetObject` (HEAD verification), `s3:DeleteObject` |
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
bun run street3d:admin enable-version  <versionId>              --target-database=goway
bun run street3d:admin rebuild-scene   <sceneId> [--profile standard] --target-database=goway
bun run street3d:admin block-capture   <assetId> --reason "…"   --target-database=goway
bun run street3d:admin cancel-job      <jobId>                  --target-database=goway
bun run street3d:admin requeue-job     <jobId>                  --target-database=goway
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
  `jobs/` artifacts are retained, and only if no registered input has since
  been withdrawn or blocked.
- `block-capture` is permanent: the capture's gate is `blocked`, its content hash
  is recorded so identical bytes are refused too, open jobs are cancelled, every
  version that registered it is disabled and purged, and a rebuild without it is
  requested. A blocked capture can never re-enter a manifest.
- Contributor withdrawal (`DELETE /captures/assets/:id`) cancels open jobs and
  deletes derivatives; a published version that used it stays until a rebuild
  replaces it (moderation is the path for immediate removal).
