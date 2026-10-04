# Street 3D capture expiry

Part of [#16](https://github.com/OxyHQ/GoWay/issues/16) and
[#10](https://github.com/OxyHQ/GoWay/issues/10). This implements application
expiry for temporary capture objects. It does not enable Street 3D publicly.

## Run the cleanup task

Apply the generated migrations through the normal deploy procedure first:

```sh
bun run db:migrate --target-database=goway
bun run captures:cleanup --target-database=goway --dry-run --limit=100
bun run captures:cleanup --target-database=goway --limit=100
```

Use the actual database name in place of `goway`. Both modes assert the connected
database and current migration ledger before reading capture rows. Execution
requires the existing `CAPTURE_S3_*` configuration and credentials with
`s3:DeleteObject` restricted to the temporary capture prefix. Dry runs need no
object store or AWS credentials.

The shipped backend image includes the entrypoint:

```sh
bun packages/backend/dist/src/capture/runCleanup.js --target-database=goway --limit=100
```

Schedule that command as a small periodic task on the existing backend platform,
for example every five minutes. This change supplies the command; it does not
provision a scheduler, bucket or credentials. Start with a dry run and configure
the schedule before accepting production uploads. Keep this out of API startup:
map availability must not depend on the cleanup service or an owned GPU.

Enable execution only after **all API instances** run the registration/finalize
guards from this change. The older API cancels `deleting` and is unsafe alongside
an active sweeper. If rolling back after cleanup has started, retain these guards;
stopping the scheduler alone does not make outstanding deletion intents safe to
revive.

Each invocation handles at most `--limit` objects (default 100, maximum 1000).
It prints aggregate JSON: `candidates`, `declaredBytes`, `deleted`, `failed` and
`deletedDeclaredBytes`. Byte counts are declared sizes, not measured reclaimed
storage or cloud billing. A failed deletion produces a nonzero exit status;
other objects in the batch still proceed. No object keys, contributor IDs, signed
URLs or provider exception bodies appear in this summary. Alert on failed runs,
a growing deletion backlog, or repeated full batches; increase frequency or
capacity when expiry backlog grows. A slow store can make a sequential batch
take up to roughly 30 seconds per DELETE, plus signing and database work, so size
the task timeout and batch limit together.

## State and concurrency

1. In a short transaction, select expired `expected`/`stored` objects with
   `FOR UPDATE SKIP LOCKED`. Recheck expiry, protection and upload-intent expiry
   under the row lock. `protectedUntil` cannot exceed `expiresAt` by schema.
2. Commit `deleting`. In the same transaction, mark pending uploads `abandoned`
   and other contributions `expired` (preserving contributor removals). This
   closes their generated reconstruction eligibility before any object I/O.
3. Delete the server-generated key through the object-store interface.
4. Only after success, record `deletedAt`, `deletionReason=expired` and `deleted`.

`deleting` is irreversible: S3 may have completed a request even when its response
was lost. Registration of identical bytes receives a retryable conflict while
deletion is in progress; finalization cannot revive the object. Once tombstoned,
the same bytes may be uploaded again to a new key with a new lifecycle. Concurrent
first registrations serialize by content hash, including when no row exists yet.

An interrupted or failed intent becomes retryable after `--retry-after-seconds`
(default 300; allowed 30–86400). Overlapping long runs may repeat a DELETE, which
is idempotent. Only one completion writes/counts the tombstone. A retry never
cancels intent or reuses its key.

Compact contribution/provenance rows remain. Published scenes are not stored in
`capture_media_objects`; its retention-class constraint refuses published assets.
Their future publication lifecycle must remain independent from this sweeper.

## Object-store backstop

Use a **dedicated, never-versioned temporary bucket** with public access blocked.
In a versioned bucket, DELETE can create a marker while retaining every original
pixel. The S3 adapter rejects such responses; cleanup remains failed/retryable
instead of recording false erasure. Suspending versioning does not purge old
versions. Supporting an existing versioned bucket requires explicit version
purging before this adapter can be used safely.

Configure S3 Lifecycle on the temporary prefix as a backstop. For the default
`CAPTURE_S3_KEY_PREFIX=captures`, a conservative rule is:

```json
{
  "Rules": [{
    "ID": "goway-temporary-capture-backstop",
    "Status": "Enabled",
    "Filter": { "Prefix": "captures/" },
    "Expiration": { "Days": 401 },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
  }]
}
```

The 401-day backstop sits above the schema's 400-day absolute retention ceiling;
ordinary photo/video expiry remains driven by the configured, much shorter
application policy. Adapt the prefix to the deployment and merge with existing
bucket lifecycle rules. Never include published scene prefixes or an archive
transition. S3 lifecycle deletion is asynchronous and is not a precise product
deadline. The backstop also covers a PUT that started before its signed URL
expired and finished unusually late, after application deletion.

## Deliberate boundaries

- This pass acts on `expiresAt`, including uploads that were never finalized.
  It does not yet retire abandoned uploads early after their upload window.
- `deletionEligibleAt` alone does not prove a video's keyframes were safely
  persisted and privacy-cleared. Early video retirement waits for that durable
  dependency evidence; deleting purely by this timestamp would lose inputs.
- Future workers must acquire bounded protection under the same object lock
  before reading inputs and refuse `deleting`/`deleted`. There are no job leases
  or reconstruction workers implemented yet.
- Budget enforcement, bounded rescue extensions, near-duplicate decisions and
  derivative-aware early cleanup remain in #10–#13.

## Remaining epic gates

The current repository has capture contracts, authenticated registration,
direct-upload signing, finalize, location normalization, retention metadata and
this expiry task. [#16](https://github.com/OxyHQ/GoWay/issues/16) is still open:

| Track | Required implementation / validation |
| --- | --- |
| #9 | Expo capture UI and SDK surface; real photo/video upload; robust media validation and keyframes |
| #10 | Deploy cleanup/backstop; enforce storage budgets; derivative cleanup and bounded rescue |
| #13 | Privacy-safe derivatives, contributor controls, moderation, scene disable/rebuild |
| #11 | Visual capture graph, camera solve, world alignment, Gaussian training and quality gates |
| #12 | Durable SQS jobs, worker leases/heartbeat, cancellation, local cache, RTX 5090 validation |
| #14 | Versioned delivery, renderer, map transitions, Places overlays and device benchmarks |
| #15 | Coverage health, truthful expiry risk, hints and useful-coverage metrics |

A local PostGIS suite with an injected object store validates deletion state,
crash recovery, concurrent registration/cleanup, expired finalization, dry runs
and database targeting. It is not evidence of an AWS deletion, real media
preprocessing, GPU reconstruction or device performance. Release still requires
the privacy gate, reviewed code/model licenses, an authorized pilot dataset,
real worker access and the epic's end-to-end acceptance checks.
