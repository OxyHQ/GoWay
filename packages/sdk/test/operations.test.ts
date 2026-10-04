import { API_OPERATIONS, GOWAY_API_BASE_PATH, type ApiOperation } from '@goway/contracts';
import { describe, expect, it } from 'vitest';
import { createGoWayClient, DEFAULT_GOWAY_API_BASE_URL, type GoWayFetch } from '../src/index';

/**
 * The SDK covers the WHOLE route registry, and nothing outside it.
 *
 * `API_OPERATIONS` is the list the OpenAPI document is generated from and the
 * backend's routes are held to, so an operation added there without an SDK
 * method fails this suite instead of shipping as a route only hand-written
 * clients can reach.
 */

/** The value each path parameter is called with below. */
const PATH_VALUES: Readonly<Record<string, string>> = {
  placeId: 'p1',
  key: 'payments.faircoin.accepted',
  sessionId: 's1',
  assetId: 'a1',
  sceneId: 'scene1',
};

function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function expectedKey(operation: ApiOperation): string {
  const path = operation.path.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const value = PATH_VALUES[name];
    if (value === undefined) throw new Error(`no test value for path parameter ${name}`);
    return encodeURIComponent(value);
  });
  return operationKey(operation.method, `${GOWAY_API_BASE_PATH}${path}`);
}

/** Every SDK method that issues a request, called once with valid input. */
async function callEverything(): Promise<Set<string>> {
  const issued = new Set<string>();
  const fetch: GoWayFetch = async (url, init) => {
    const path = url.slice(DEFAULT_GOWAY_API_BASE_URL.length).split('?')[0]!;
    issued.add(operationKey(init.method, path));
    // Every call is recorded before its answer is parsed; an empty answer is
    // enough, and the parse failures it causes elsewhere are not under test.
    return { status: 204, headers: { get: () => null }, text: async () => '' };
  };
  const goway = createGoWayClient({ fetch, getAccessToken: () => 'token' });
  const box = { west: 0, south: 0, east: 1, north: 1 };
  const assetInput = {
    mediaKind: 'photo',
    source: 'camera',
    contentHash: 'a'.repeat(64),
    byteSize: 1,
    contentType: 'image/jpeg',
    location: [{ origin: 'device_capture', coordinate: { latitude: 0, longitude: 0 } }],
  } as const;

  const calls: Promise<unknown>[] = [
    goway.places.get('p1'),
    goway.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10 }),
    goway.places.inBounds(box),
    goway.places.create({ name: 'n', location: { latitude: 0, longitude: 0 } }),
    goway.places.update('p1', { name: 'n' }),
    goway.places.capabilities.put('p1', 'payments.faircoin.accepted', { value: true }),
    goway.places.capabilities.delete('p1', 'payments.faircoin.accepted'),
    goway.places.claims.create('p1', { role: 'owner' }),
    goway.places.claims.list('p1'),
    goway.claims.mine(),
    goway.search.query({ query: 'x' }),
    goway.geocode.forward({ query: 'x' }),
    goway.geocode.reverse({ latitude: 0, longitude: 0 }),
    goway.geocode.structured({ city: 'x' }),
    goway.routes.directions({ origin: { placeId: 'a' }, destination: { placeId: 'b' }, mode: 'walk' }),
    goway.captures.policy(),
    goway.captures.sessions(),
    goway.captures.createSession({ source: 'camera', consentVersion: 'v1' }),
    goway.captures.session('s1'),
    goway.captures.assets('s1'),
    goway.captures.register('s1', { ...assetInput, location: [...assetInput.location] }),
    goway.captures.asset('a1'),
    goway.captures.finalize('a1'),
    goway.captures.remove('a1'),
    goway.street3d.coverage(box),
    goway.street3d.scene('scene1'),
    goway.street3d.report('scene1', { reason: 'privacy' }),
  ];
  await Promise.allSettled(calls);
  return issued;
}

describe('the route registry', () => {
  it('is reached in full by the SDK', async () => {
    const issued = await callEverything();
    const unreached = API_OPERATIONS.filter((operation) => !issued.has(expectedKey(operation))).map(
      (operation) => `${operation.operationId} (${expectedKey(operation)})`,
    );
    expect(unreached).toEqual([]);
  });

  it('is the only thing the SDK reaches', async () => {
    const registered = new Set(API_OPERATIONS.map(expectedKey));
    expect([...(await callEverything())].filter((key) => !registered.has(key))).toEqual([]);
  });
});
