/**
 * The fixture transport answers the SDK's REAL Street 3D requests: the same
 * `createGoWayClient` the app uses, with `createFixtureFetch` injected, so a
 * fixture that drifts from the published contract fails here at the SDK's own
 * parser rather than in a render.
 */
import { describe, expect, test } from 'bun:test';
import {
  createGoWayClient,
  GoWayAbortError,
  GoWayApiError,
  GoWayNotFoundError,
  GoWayUnauthorizedError,
  GoWayUnavailableError,
  type GoWayFetch,
} from '@goway.to/sdk';

import { classifyGoWayError } from '@/lib/goway/errors';
import { createFixtureFetch } from '@/lib/goway/mockTransport';
import { FIXTURE_SCENES } from '@/lib/goway/street3dFixtures';

import { isStreet3dEndpointMissing } from '../availability';

const API = 'https://api.example.test';
const [scene] = [...FIXTURE_SCENES.values()];

function client(token: string | null = null, fetch: GoWayFetch = createFixtureFetch()) {
  return createGoWayClient({ apiBaseUrl: API, fetch, getAccessToken: () => token }).street3d;
}

function canned(status: number, body: string): GoWayFetch {
  return async () => ({ status, headers: { get: () => null }, text: async () => body });
}

describe('SDK street3d against the fixture transport', () => {
  test('coverage returns the scenes and areas inside the box', async () => {
    const coverage = await client().coverage(scene.bounds);
    expect(coverage.scenes.map((entry) => entry.id)).toContain(scene.id);
    for (const area of coverage.areas) {
      expect(area.bounds.east).toBeGreaterThanOrEqual(scene.bounds.west);
      expect(area.bounds.west).toBeLessThanOrEqual(scene.bounds.east);
    }
  });

  test('every fixture scene parses as a manifest the viewer can open', async () => {
    for (const id of FIXTURE_SCENES.keys()) {
      const manifest = await client().scene(id);
      expect(manifest.worldTransform.enuFromScene).toHaveLength(16);
      expect(manifest.assets.map((asset) => asset.role).sort()).toEqual(['poster', 'splat', 'splat_preview']);
      expect(manifest.attributions.length).toBeGreaterThan(0);
    }
  });

  test('an unknown scene is GoWay saying not found — not a missing endpoint', async () => {
    const error = await client().scene('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayNotFoundError);
    expect(classifyGoWayError(error).kind).toBe('notFound');
    expect(isStreet3dEndpointMissing(error)).toBe(false);
  });

  test('a report needs a session, and goes through with one', async () => {
    const anonymous = await client().report(scene.id, { reason: 'privacy' }).catch((e: unknown) => e);
    expect(anonymous).toBeInstanceOf(GoWayUnauthorizedError);

    const report = await client('token').report(scene.id, { reason: 'inaccurate', note: 'offset' });
    expect(report.sceneId).toBe(scene.id);
    expect(report.reason).toBe('inaccurate');
  });

  test('the street3d fault family drives the "hide silently" path', async () => {
    const error = await client(null, createFixtureFetch({ street3d: 'unavailable' })).coverage(scene.bounds).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayUnavailableError);
    // Restore the shared fault table for the other suites.
    createFixtureFetch();
  });

  test('an aborted request is an abort, which renders as nothing', async () => {
    const controller = new AbortController();
    const pending = client().coverage(scene.bounds, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayAbortError);
    expect(classifyGoWayError(error).kind).toBe('aborted');
  });
});

describe('isStreet3dEndpointMissing', () => {
  test('a bare 404 (no GoWay body) means the deployment has no Street 3D routes', async () => {
    const error = await client(null, canned(404, '<html>')).coverage(scene.bounds).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayApiError);
    expect(isStreet3dEndpointMissing(error)).toBe(true);
  });

  test('a 503 is not a missing endpoint', async () => {
    const error = await client(null, canned(503, '{"error":{"code":"service_unavailable","message":"off"}}'))
      .coverage(scene.bounds)
      .catch((e: unknown) => e);
    expect(isStreet3dEndpointMissing(error)).toBe(false);
  });
});
