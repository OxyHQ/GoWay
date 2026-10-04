import { describe, expect, it } from 'vitest';
import { createGoWayClient, GoWayNotFoundError, GoWayResponseError, GoWayValidationError } from '../src/index';
import { parseStreetCoverage, parseStreetSceneManifest, parseStreetSceneReport } from '../src/parse';
import { fakeFetch, queryOf, rejection } from './helpers';

const time = '2026-10-04T10:00:00.000Z';
const digest = 'c'.repeat(64);
const footprint = { type: 'Polygon', coordinates: [[[2.3, 48.86], [2.31, 48.86], [2.31, 48.87], [2.3, 48.86]]] };
const manifest = {
  id: 'scene-1',
  version: 3,
  bounds: { west: 2.3, south: 48.86, east: 2.31, north: 48.87 },
  footprint,
  worldTransform: { anchor: { latitude: 48.8684, longitude: 2.302, altitudeMeters: 0 }, frame: 'enu', enuFromScene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  initialView: { position: [0, 0, 1.6], target: [0, 10, 1.6] },
  assets: [
    { role: 'splat', format: 'spz', url: `https://cdn.example.test/scenes/scene-1/v3/${digest}.spz`, byteSize: 10, sha256: digest, gaussians: 5 },
    { role: 'poster', format: 'jpeg', url: 'https://cdn.example.test/p.jpg', byteSize: 3, sha256: 'd'.repeat(64) },
  ],
  quality: { profile: 'draft', registrationRatio: 0.9, alignmentResidualMeters: 1.4, heldOutPsnr: 21, placement: 'precise' },
  observedFrom: time,
  observedTo: time,
  publishedAt: time,
  attributions: ['Imagery © Example, CC BY-SA 4.0'],
  privacyPipelineVersions: ['goway-privacy/1'],
};
const coverage = {
  scenes: [{ id: 'scene-1', version: 3, center: { latitude: 48.865, longitude: 2.305 }, bounds: manifest.bounds, footprint, placement: 'approximate', posterUrl: 'https://cdn.example.test/p.jpg', publishedAt: time }],
  areas: [{ id: 'area-1', state: 'at_risk', center: { latitude: 48.8684, longitude: 2.3017 }, bounds: manifest.bounds, contributionBand: '5-19', atRiskUntil: time }],
};

describe('street3d client', () => {
  it('reads coverage for a box, signed out', async () => {
    const { fetch, calls } = fakeFetch(200, coverage);
    const result = await createGoWayClient({ fetch }).street3d.coverage({ west: 2.3, south: 48.86, east: 2.31, north: 48.87 });
    expect(calls[0]?.url).toContain('/api/v1/street3d/coverage?');
    expect(queryOf(calls[0]!.url)).toBe('east=2.31&north=48.87&south=48.86&west=2.3');
    expect(calls[0]?.init.headers).not.toHaveProperty('authorization');
    expect(result).toEqual(coverage);
  });

  it('validates the box before sending anything', async () => {
    const { fetch, calls } = fakeFetch(200, coverage);
    const client = createGoWayClient({ fetch });
    expect(await rejection(client.street3d.coverage({ west: 2, south: 49, east: 3, north: 48 }))).toBeInstanceOf(GoWayValidationError);
    expect(await rejection(client.street3d.coverage({ west: 200, south: 48, east: 3, north: 49 }))).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });

  it('reads a scene manifest and maps a missing scene to not found', async () => {
    const found = fakeFetch(200, manifest);
    expect(await createGoWayClient({ fetch: found.fetch }).street3d.scene('scene 1')).toEqual(manifest);
    expect(found.calls[0]?.url).toContain('/street3d/scenes/scene%201');
    const missing = fakeFetch(404, { error: { code: 'not_found', message: 'No published Street 3D scene has that id.' } });
    expect(await rejection(createGoWayClient({ fetch: missing.fetch }).street3d.scene('nope'))).toBeInstanceOf(GoWayNotFoundError);
  });

  it('reports with a session and sends only the contract fields', async () => {
    const report = { id: 'r-1', sceneId: 'scene-1', version: 3, reason: 'privacy', createdAt: time };
    const { fetch, calls } = fakeFetch(201, report);
    const client = createGoWayClient({ fetch, getAccessToken: () => 'session-token' });
    const sent = await client.street3d.report('scene-1', { reason: 'privacy', note: 'a face', extra: 'dropped' } as never);
    expect(sent).toEqual(report);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ reason: 'privacy', note: 'a face' });
    expect(await rejection(client.street3d.report('scene-1', { reason: 'spam' } as never))).toBeInstanceOf(GoWayValidationError);
  });
});

describe('street3d parsers', () => {
  it('strip private fields and keep only the contract', () => {
    const parsed = parseStreetSceneManifest({
      ...manifest,
      jobId: 'private', captureAssetIds: ['private'],
      assets: manifest.assets.map((asset) => ({ ...asset, key: 'private/key', sourceKey: 'jobs/private' })),
      quality: { ...manifest.quality, gpuSeconds: 1 },
    });
    expect(JSON.stringify(parsed)).not.toContain('private');
    expect(JSON.stringify(parsed)).not.toContain('gpuSeconds');
    const area = parseStreetCoverage({ ...coverage, areas: [{ ...coverage.areas[0], cell: 'u09wh2h', count: 7 }] }).areas[0];
    expect(Object.keys(area!).sort()).toEqual(['atRiskUntil', 'bounds', 'center', 'contributionBand', 'id', 'state']);
    expect(Object.keys(parseStreetSceneReport({ id: 'r', sceneId: 's', version: 1, reason: 'other', createdAt: time, reporter: 'x' }))).not.toContain('reporter');
  });

  it('fail closed on unknown states, insecure URLs, bad digests and a malformed transform', () => {
    expect(() => parseStreetCoverage({ ...coverage, areas: [{ ...coverage.areas[0], state: 'great' }] })).toThrow();
    expect(() => parseStreetSceneManifest({ ...manifest, assets: [{ ...manifest.assets[0], url: 'http://cdn.example.test/a.spz' }] })).toThrow();
    // Plain HTTP only on loopback: a local asset server, which downgrades nothing.
    expect(parseStreetSceneManifest({ ...manifest, assets: [{ ...manifest.assets[0], url: 'http://localhost:8811/a.spz' }] }).assets[0]?.url).toBe('http://localhost:8811/a.spz');
    expect(() => parseStreetSceneManifest({ ...manifest, assets: [{ ...manifest.assets[0], url: 'http://localhost.example.test/a.spz' }] })).toThrow();
    expect(() => parseStreetSceneManifest({ ...manifest, assets: [{ ...manifest.assets[0], sha256: 'xyz' }] })).toThrow();
    expect(() => parseStreetSceneManifest({ ...manifest, worldTransform: { ...manifest.worldTransform, enuFromScene: [1, 0, 0] } })).toThrow();
    expect(() => parseStreetSceneManifest({ ...manifest, quality: { ...manifest.quality, placement: 'exact' } })).toThrow();
  });

  it('parse guided navigation strictly when present and leave it absent otherwise', () => {
    expect(parseStreetSceneManifest(manifest)).not.toHaveProperty('navigation');
    expect(parseStreetSceneManifest({ ...manifest, navigation: null })).not.toHaveProperty('navigation');

    const navigation = {
      viewpoints: [
        { position: [0, 0, 1.6], forward: [0, 1, 0] },
        { position: [0.1, 2.5, 1.6], forward: [0, 1, 0] },
      ],
      fieldOfView: { horizontalDegrees: 66, verticalDegrees: 50 },
    };
    const parsed = parseStreetSceneManifest({
      ...manifest,
      navigation: {
        ...navigation,
        viewpoints: navigation.viewpoints.map((viewpoint) => ({ ...viewpoint, capturedAt: time, contributor: 'private' })),
        order: 'private',
      },
    });
    expect(parsed.navigation).toEqual(navigation);
    expect(JSON.stringify(parsed)).not.toContain('private');
    expect(JSON.stringify(parsed)).not.toContain('capturedAt');
    expect(parseStreetSceneManifest({ ...manifest, navigation: { viewpoints: [] } }).navigation).toEqual({ viewpoints: [] });

    const malformed: unknown[] = [
      { fieldOfView: navigation.fieldOfView },
      { viewpoints: 'everywhere' },
      { viewpoints: [{ position: [0, 0], forward: [0, 1, 0] }] },
      { viewpoints: [{ position: [0, 0, Number.NaN], forward: [0, 1, 0] }] },
      { viewpoints: [{ position: [0, 0, 1.6], forward: [0, '1', 0] }] },
      { viewpoints: [{ position: [0, 0, 1.6] }] },
      { viewpoints: [], fieldOfView: { horizontalDegrees: 0, verticalDegrees: 50 } },
      { viewpoints: [], fieldOfView: { horizontalDegrees: 66, verticalDegrees: 180 } },
      { viewpoints: [], fieldOfView: { horizontalDegrees: 66 } },
      'nearby',
    ];
    for (const bad of malformed) expect(() => parseStreetSceneManifest({ ...manifest, navigation: bad })).toThrow();
  });

  it('surfaces a malformed body as a response error', async () => {
    const { fetch } = fakeFetch(200, { scenes: 'nope', areas: [] });
    expect(await rejection(createGoWayClient({ fetch }).street3d.coverage({ west: 2.3, south: 48.86, east: 2.31, north: 48.87 }))).toBeInstanceOf(GoWayResponseError);
  });
});
