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
