import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  DEFAULT_GOWAY_API_BASE_URL,
  GOWAY_API_BASE_PATH,
  GoWayValidationError,
} from '../src/index';
import { fakeFetch, queryOf, rejection } from './helpers';

const camera = {
  id: 'open-roads.cam-1',
  providerId: 'open-roads',
  name: 'A-2 km 596',
  kind: 'traffic',
  position: { latitude: 41.39, longitude: 2.16 },
  heading: 90,
  roadName: 'A-2',
  media: { kind: 'snapshot', refreshSeconds: 60, width: 1280, height: 720 },
  status: 'live',
  lastFrameAt: '2026-10-22T11:59:00.000Z',
  attribution: { label: 'Source: Open Roads', href: 'https://example.org/credit' },
  licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
};
const BOX = { west: 1, south: 40, east: 3, north: 42 };

describe('goway.cameras', () => {
  it('lists the cameras in a box with the filters on the wire, and parses the page', async () => {
    const { fetch, calls } = fakeFetch(200, { items: [camera], nextCursor: null });
    const goway = createGoWayClient({ fetch });
    const page = await goway.cameras.list({ ...BOX, kind: 'traffic', limit: 50 });
    expect(page.items[0]?.attribution.label).toBe('Source: Open Roads');
    expect(page.nextCursor).toBeNull();
    const query = new URLSearchParams(queryOf(calls[0]?.url ?? ''));
    expect(Object.fromEntries(query)).toEqual({
      west: '1',
      south: '40',
      east: '3',
      north: '42',
      kind: 'traffic',
      limit: '50',
    });
    expect(calls[0]?.url).toContain('/cameras?');
  });

  it('refuses a box that is upside down before any request is made', async () => {
    const { fetch, calls } = fakeFetch(200, {});
    const goway = createGoWayClient({ fetch });
    const error = await rejection(goway.cameras.list({ ...BOX, south: 43 }));
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });

  it('reads one camera, and refuses an id that is not one', async () => {
    const { fetch, calls } = fakeFetch(200, camera);
    const goway = createGoWayClient({ fetch });
    expect((await goway.cameras.get('open-roads.cam-1')).status).toBe('live');
    expect(calls[0]?.url.endsWith('/cameras/open-roads.cam-1')).toBe(true);
    expect(await rejection(goway.cameras.get('../places'))).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(1);
  });

  it('reads observations, newest first, as aggregates', async () => {
    const observation = {
      cameraId: 'open-roads.cam-1',
      from: '2026-10-22T11:58:00.000Z',
      to: '2026-10-22T11:59:00.000Z',
      counts: { car: 12, truck: 1 },
      present: { car: 3 },
      flowPerMinute: 13,
      congestion: 'busy',
      health: 'ok',
    };
    const { fetch, calls } = fakeFetch(200, { items: [observation], nextCursor: null });
    const goway = createGoWayClient({ fetch });
    const page = await goway.cameras.observations('open-roads.cam-1', {
      since: '2026-10-22T00:00:00.000Z',
      limit: 10,
    });
    expect(page.items[0]?.counts.car).toBe(12);
    expect(calls[0]?.url).toContain('/cameras/open-roads.cam-1/observations?');
  });

  it('lists the providers with their terms', async () => {
    const provider = {
      id: 'open-roads',
      name: 'Open Roads',
      attribution: camera.attribution,
      licence: camera.licence,
      redistribution: 'relay',
      cameraCount: 815,
      coverage: null,
    };
    const { fetch } = fakeFetch(200, { items: [provider], nextCursor: null });
    const page = await createGoWayClient({ fetch }).cameras.providers();
    expect(page.items[0]?.redistribution).toBe('relay');
  });

  it("builds the URL of GoWay's copy of a picture, from the API origin, and no other", () => {
    // `apiBaseUrl` is the ORIGIN; the API's base path is the SDK's to add, as on every request.
    const goway = createGoWayClient({ apiBaseUrl: 'https://api.example.test' });
    expect(goway.cameras.snapshotUrl('open-roads.cam-1')).toBe(
      'https://api.example.test/api/v1/cameras/open-roads.cam-1/snapshot',
    );
    expect(createGoWayClient().cameras.snapshotUrl('a.b')).toBe(
      `${DEFAULT_GOWAY_API_BASE_URL}${GOWAY_API_BASE_PATH}/cameras/a.b/snapshot`,
    );
    expect(() => goway.cameras.snapshotUrl('a/../b')).toThrow(GoWayValidationError);
  });

  it('refuses a response that is not a camera, rather than handing it on', async () => {
    const { fetch } = fakeFetch(200, { ...camera, status: 'flying' });
    const goway = createGoWayClient({ fetch });
    await expect(goway.cameras.get('open-roads.cam-1')).rejects.toBeDefined();
  });
});
