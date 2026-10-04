import { describe, expect, test } from 'bun:test';
import {
  GoWayAbortError,
  GoWayApiError,
  GoWayNotFoundError,
  GoWayResponseError,
  GoWayUnauthorizedError,
  GoWayUnavailableError,
  GoWayValidationError,
  type GoWayFetch,
} from '@goway.to/sdk';

import { classifyGoWayError } from '@/lib/goway/errors';
import { createFixtureFetch } from '@/lib/goway/mockTransport';

import { createStreet3dApi, type Street3dApi } from '../api';

const API = 'https://api.example.test';
const RAMBLA = { west: 2.17, south: 41.379, east: 2.175, north: 41.383 };

function fixtureApi(token: string | null = null): Street3dApi {
  return createStreet3dApi({ apiBaseUrl: API, fetch: createFixtureFetch(), getAccessToken: () => token });
}

/** A fetch that answers one canned response and records what it was asked. */
function canned(status: number, body: unknown, seen: Array<{ url: string; init: unknown }> = []): GoWayFetch {
  return async (url, init) => {
    seen.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, headers: { get: () => null }, text: async () => text };
  };
}

describe('fallback transport against the fixtures', () => {
  test('coverage returns the scenes and areas inside the box', async () => {
    const coverage = await fixtureApi().coverage(RAMBLA);
    expect(coverage.scenes.map((scene) => scene.id)).toContain('s3d_fixture_rambla_liceu');
    expect(coverage.areas.length).toBeGreaterThan(0);
    for (const area of coverage.areas) {
      expect(area.bounds.east).toBeGreaterThanOrEqual(RAMBLA.west);
      expect(area.bounds.west).toBeLessThanOrEqual(RAMBLA.east);
    }
  });

  test('scene returns a manifest the viewer can open', async () => {
    const manifest = await fixtureApi().scene('s3d_fixture_rambla_liceu');
    expect(manifest.worldTransform.enuFromScene).toHaveLength(16);
    expect(manifest.assets.map((asset) => asset.role).sort()).toEqual(['poster', 'splat', 'splat_preview']);
    expect(manifest.attributions.length).toBeGreaterThan(0);
  });

  test('an unknown scene is GoWay saying not found', async () => {
    const error = await fixtureApi().scene('nope').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayNotFoundError);
    expect(classifyGoWayError(error).kind).toBe('notFound');
  });

  test('a report needs a session, and goes through with one', async () => {
    const anonymous = await fixtureApi().report('s3d_fixture_rambla_liceu', { reason: 'privacy' }).catch((e: unknown) => e);
    expect(anonymous).toBeInstanceOf(GoWayUnauthorizedError);

    const report = await fixtureApi('token').report('s3d_fixture_rambla_liceu', { reason: 'inaccurate', note: ' offset ' });
    expect(report.sceneId).toBe('s3d_fixture_rambla_liceu');
    expect(report.reason).toBe('inaccurate');
  });
});

describe('request shape', () => {
  test('coverage serialises the box with sorted keys under /api/v1', async () => {
    const seen: Array<{ url: string; init: unknown }> = [];
    const api = createStreet3dApi({ apiBaseUrl: `${API}/`, fetch: canned(200, { scenes: [], areas: [] }, seen) });
    await api.coverage({ west: 1, south: 2, east: 3, north: 4 });
    expect(seen[0].url).toBe(`${API}/api/v1/street3d/coverage?east=3&north=4&south=2&west=1`);
  });

  test('report posts a trimmed note to the reports route', async () => {
    const seen: Array<{ url: string; init: unknown }> = [];
    const api = createStreet3dApi({
      apiBaseUrl: API,
      fetch: canned(500, {}),
      writeFetch: canned(201, { id: 'r1', sceneId: 's 1', version: 1, reason: 'other', createdAt: 'x' }, seen),
      getAccessToken: () => 'should-not-be-sent',
    });
    await api.report('s 1', { reason: 'other', note: '  hello  ' });
    expect(seen[0].url).toBe(`${API}/api/v1/street3d/scenes/s%201/reports`);
    const init = seen[0].init as { method: string; body: string; headers: Record<string, string> };
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reason: 'other', note: 'hello' });
    // The linked write transport authenticates itself.
    expect(init.headers.Authorization).toBeUndefined();
  });

  test('refuses bad input before sending anything', () => {
    const api = createStreet3dApi({ apiBaseUrl: API, fetch: canned(200, {}) });
    expect(() => api.coverage({ west: Number.NaN, south: 0, east: 1, north: 1 })).toThrow(GoWayValidationError);
    expect(() => api.scene('..')).toThrow(GoWayValidationError);
    expect(() => api.report('s', { reason: 'nope' as never })).toThrow(GoWayValidationError);
    expect(() => api.report('s', { reason: 'other', note: 'x'.repeat(501) })).toThrow(GoWayValidationError);
  });
});

describe('error mapping', () => {
  test('a bare 404 (no GoWay body) is NOT "not found" — the route may not be deployed', async () => {
    const error = await createStreet3dApi({ apiBaseUrl: API, fetch: canned(404, '<html>') })
      .coverage(RAMBLA)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayApiError);
    expect(error).not.toBeInstanceOf(GoWayNotFoundError);
    expect((error as GoWayApiError).status).toBe(404);
  });

  test('503 is unavailable and retryable', async () => {
    const error = await createStreet3dApi({ apiBaseUrl: API, fetch: canned(503, { error: { code: 'service_unavailable', message: 'down' } }) })
      .coverage(RAMBLA)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayUnavailableError);
    expect(classifyGoWayError(error).retryable).toBe(true);
  });

  test('a malformed body is a response error, not a crash in a render', async () => {
    const error = await createStreet3dApi({ apiBaseUrl: API, fetch: canned(200, { scenes: 'no' }) })
      .coverage(RAMBLA)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayResponseError);
  });

  test('an unknown area state is skipped rather than fatal', async () => {
    const coverage = await createStreet3dApi({
      apiBaseUrl: API,
      fetch: canned(200, {
        scenes: [],
        areas: [
          { id: 'a', state: 'from_the_future', center: { latitude: 0, longitude: 0 }, bounds: { west: 0, south: 0, east: 0, north: 0 } },
          { id: 'b', state: 'partial', center: { latitude: 0, longitude: 0 }, bounds: { west: 0, south: 0, east: 0, north: 0 }, contributionBand: '1-4' },
        ],
      }),
    }).coverage(RAMBLA);
    expect(coverage.areas.map((entry) => entry.id)).toEqual(['b']);
  });

  test('an aborted request is an abort, which renders as nothing', async () => {
    const controller = new AbortController();
    const pending = fixtureApi().coverage(RAMBLA, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoWayAbortError);
    expect(classifyGoWayError(error).kind).toBe('aborted');
  });
});

describe('the SDK seam', () => {
  test('uses client.street3d when the installed SDK has it', async () => {
    const calls: string[] = [];
    const sdk: Street3dApi = {
      coverage: async () => {
        calls.push('coverage');
        return { scenes: [], areas: [] };
      },
      scene: async () => {
        throw new Error('unused');
      },
      report: async () => {
        throw new Error('unused');
      },
    };
    const api = createStreet3dApi({ client: { street3d: sdk }, apiBaseUrl: API, fetch: canned(500, {}) });
    expect(api).toBe(sdk);
    await api.coverage(RAMBLA);
    expect(calls).toEqual(['coverage']);
  });

  test('falls back when the client has no street3d namespace', async () => {
    const api = createStreet3dApi({ client: { places: {} }, apiBaseUrl: API, fetch: canned(200, { scenes: [], areas: [] }) });
    expect(await api.coverage(RAMBLA)).toEqual({ scenes: [], areas: [] });
  });
});
