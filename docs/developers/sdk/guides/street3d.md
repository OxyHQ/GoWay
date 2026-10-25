# Street 3D and captures

Street 3D publishes explorable 3D scenes of streets, reconstructed from photos and videos people contribute. The SDK has two namespaces for it: `client.street3d` reads published scenes and coverage (no account needed), and `client.captures` lets a signed-in contributor upload media. Neither exposes how scenes are built.

## Find scenes in an area

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient();

const coverage = await goway.street3d.coverage({ west: 2.16, south: 41.38, east: 2.18, north: 41.40 });

for (const scene of coverage.scenes) {
  console.log(scene.id, scene.center, scene.posterUrl);
}
for (const area of coverage.areas) {
  console.log(area.state, area.contributionBand); // e.g. 'partial', '5-19'
}
```

- `scenes` are published scenes (`StreetSceneSummary`): `id`, `version`, `center`, `bounds`, `footprint`, `placement`, `publishedAt`, optional `posterUrl`.
- `areas` are places that are not (yet) a scene, with a `state` from `STREET_COVERAGE_AREA_STATES` and a coarse `contributionBand`. Use them to invite contributions.
- The server caps the box size. A deployment with Street 3D switched off answers `coverage` with `GoWayUnavailableError`.

## Load a scene

```ts
const manifest = await goway.street3d.scene(scene.id);

for (const asset of manifest.assets) {
  console.log(asset.role, asset.format, asset.url, asset.byteSize);
}
```

A `StreetSceneManifest` lists the scene's `assets` (Gaussian splats in `spz` or `rad`, and a `jpeg` poster; see `STREET_SCENE_ASSET_ROLES` and `STREET_SCENE_ASSET_FORMATS`), its world transform, initial view, navigation viewpoints and quality figures. An unknown scene, or a deployment with Street 3D off, rejects with `GoWayNotFoundError`.

Report a scene to moderation (needs an access token). Repeating a report returns the existing one:

```ts
await goway.street3d.report(scene.id, { reason: 'privacy', note: 'A face is visible near the door' });
```

## Contribute captures

Contributing needs an access token. The flow is: read the policy, open a session, register each file by its hash, upload the bytes to the URL GoWay hands back, then finalize.

```ts
const apiBaseUrl = 'https://api.goway.to';
const linked = oxyServices.createLinkedClient({ baseURL: apiBaseUrl });
const contributor = createGoWayClient({ apiBaseUrl, fetch: linked.fetchOptional });
// Dispose linked when this component or provider closes.

// 1. What GoWay accepts, and the consent text version to record.
const policy = await contributor.captures.policy();
if (!policy.enabled) throw new Error('Contributions are closed');

// 2. A session groups one outing's captures.
const captureSession = await contributor.captures.createSession({
  source: 'camera',
  consentVersion: policy.consentVersion,
});

// 3. Register a file before uploading it.
const ticket = await contributor.captures.register(captureSession.id, {
  mediaKind: 'photo',
  source: 'camera',
  contentHash: sha256Hex, // lower-case hex SHA-256 of the file
  byteSize: bytes.byteLength,
  contentType: 'image/jpeg',
  location: [{ origin: 'device_capture', coordinate: { latitude: 41.3874, longitude: 2.1686 }, accuracyMeters: 8 }],
});

// 4. Upload, unless GoWay already holds these exact bytes.
if (ticket.upload) {
  await fetch(ticket.upload.url, { method: ticket.upload.method, headers: ticket.upload.headers, body: bytes });
}

// 5. Finalize: GoWay checks the stored object and starts processing.
const asset = await contributor.captures.finalize(ticket.asset.id);
console.log(asset.state, asset.privacy.state);
```

- `policy.photo` and `policy.video` list the accepted `contentTypes` and size limits; `policy.equirectangular` the limits for 360-degree media.
- `contentHash` must be the lower-case hex SHA-256 of the file (`CAPTURE_CONTENT_HASH_ALGORITHM`). Hashing first lets GoWay deduplicate: when `ticket.upload` is absent, skip the upload and finalize.
- `location` needs at least one piece of evidence, each with exactly one of `coordinate` and `exifGps`, and an `origin` from `CAPTURE_LOCATION_ORIGINS`.
- Send `upload.headers` verbatim: they are part of what was signed. The upload URL expires at `upload.expiresAt`.
- Pass a UUID `idempotencyKey` and reuse it when retrying the same `register` call.
- Nothing is published until the privacy gate (`asset.privacy.state`) is `passed`.

`sessions()`, `session(id)`, `assets(sessionId)` and `asset(id)` read back your own contributions. `remove(assetId)` withdraws one: its media is deleted and it never feeds a scene.

## See also

- [API reference: `client.street3d`](../api-reference/index.md#clientstreet3d-gowaystreet3dapi) and [`client.captures`](../api-reference/index.md#clientcaptures-gowaycapturesapi)
