/**
 * The Valhalla adapter, with `fetch` injected and no socket opened.
 *
 * Two things are under test and they fail in opposite ways. NORMALIZATION is
 * silent when it is wrong — a mis-scaled distance, a maneuver pointing at the
 * wrong vertex and a leg joined at the wrong index all render as a believable
 * route. FAILURE MAPPING is loud but lands in the wrong place: an upstream
 * "there is no path between these points" reported as an outage makes a client
 * retry forever and tells a user GoWay is broken when the answer was simply no.
 *
 * The fixture below is shaped like a real Valhalla `/route` response, down to
 * the per-leg encoded shapes, the numeric maneuver types and `length` being in
 * KILOMETRES because that is what the request asked for.
 */

import '../../__tests__/testEnv';
import { describe, expect, it } from 'bun:test';
import { ApiError, isApiError } from '../../http/apiError';
import { createValhallaProvider, type FetchLike, type ValhallaProviderOptions } from '../valhalla';

/** (2.17, 41.387) (2.1712, 41.3875) (2.1725, 41.3881) (2.1738, 41.3889) at 1e6. */
const LEG_ONE_SHAPE = 'o~`}mA_hmcCg^_jAod@gpA_q@gpA';
/** (2.1738, 41.3889) (2.1751, 41.3896) (2.1764, 41.3902) at 1e6. */
const LEG_TWO_SHAPE = 'gud}mAoutcCwj@gpAod@gpA';

/** A two-leg driving trip, as Valhalla answers one. */
function valhallaTrip(): unknown {
  return {
    locations: [
      { type: 'break', lat: 41.387, lon: 2.17 },
      { type: 'break', lat: 41.3889, lon: 2.1738 },
      { type: 'break', lat: 41.3902, lon: 2.1764 },
    ],
    legs: [
      {
        maneuvers: [
          {
            type: 1,
            instruction: 'Drive east on Carrer de la Princesa.',
            street_names: ['Carrer de la Princesa'],
            time: 42,
            length: 0.315,
            begin_shape_index: 0,
            end_shape_index: 2,
          },
          {
            type: 10,
            instruction: 'Turn right onto Via Laietana.',
            street_names: ['Via Laietana'],
            time: 18,
            length: 0.12,
            begin_shape_index: 2,
            end_shape_index: 3,
          },
          {
            type: 5,
            instruction: 'Your first stop is on the right.',
            time: 0,
            length: 0,
            begin_shape_index: 3,
            end_shape_index: 3,
          },
        ],
        summary: { time: 60, length: 0.435 },
        shape: LEG_ONE_SHAPE,
      },
      {
        maneuvers: [
          {
            type: 1,
            instruction: 'Drive north.',
            time: 30,
            length: 0.2,
            begin_shape_index: 0,
            end_shape_index: 2,
          },
          {
            type: 4,
            instruction: 'You have arrived at your destination.',
            time: 0,
            length: 0,
            begin_shape_index: 2,
            end_shape_index: 2,
          },
        ],
        summary: { time: 30, length: 0.2 },
        shape: LEG_TWO_SHAPE,
      },
    ],
    summary: { time: 90, length: 0.635 },
    status_message: 'Found route between points',
    status: 0,
    units: 'kilometers',
    language: 'en-US',
  };
}

const ORIGIN = { coordinate: { latitude: 41.387, longitude: 2.17 } };
const STOP = { coordinate: { latitude: 41.3889, longitude: 2.1738 } };
const DESTINATION = { coordinate: { latitude: 41.3902, longitude: 2.1764 } };

function options(overrides: Partial<ValhallaProviderOptions> = {}): ValhallaProviderOptions {
  return {
    url: 'https://valhalla.test/route',
    timeoutMs: 1_000,
    modes: ['drive', 'walk', 'bike'],
    maxAlternatives: 2,
    userAgent: 'GoWay/test (+https://goway.to)',
    ...overrides,
  };
}

/** Answers every call with one JSON body. Nothing here touches the network. */
function answering(body: unknown, status = 200): FetchLike {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function provider(fetchImpl: FetchLike, overrides: Partial<ValhallaProviderOptions> = {}) {
  return createValhallaProvider(options({ fetch: fetchImpl, ...overrides }));
}

/** The shared-vocabulary code an adapter failure carries. */
async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (isApiError(error)) return error.code;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('normalization', () => {
  it('turns a real-shaped response into the GoWay contract', async () => {
    const routes = await provider(answering({ trip: valhallaTrip() })).route({
      locations: [ORIGIN, STOP, DESTINATION],
      mode: 'drive',
      alternatives: false,
    });

    expect(routes).toHaveLength(1);
    const [route] = routes;
    expect(route.mode).toBe('drive');
    expect(route.id).toMatch(/^[0-9a-f-]{36}$/);
    // Kilometres in, metres out. A route reported in kilometres renders as an
    // ETA that is off by a factor of a thousand and still looks like a number.
    expect(route.distanceMeters).toBeCloseTo(635, 6);
    expect(route.durationSeconds).toBe(90);
    expect(route.legs).toHaveLength(2);
    expect(route.legs[0].distanceMeters).toBeCloseTo(435, 6);
    expect(route.legs[1].durationSeconds).toBe(30);
  });

  it('joins the legs into ONE line without repeating the shared stop', async () => {
    const [route] = await provider(answering({ trip: valhallaTrip() })).route({
      locations: [ORIGIN, STOP, DESTINATION],
      mode: 'drive',
      alternatives: false,
    });

    // Four points plus three, minus the stop both legs name: six, not seven.
    expect(route.geometry.type).toBe('LineString');
    expect(route.geometry.coordinates).toEqual([
      [2.17, 41.387],
      [2.1712, 41.3875],
      [2.1725, 41.3881],
      [2.1738, 41.3889],
      [2.1751, 41.3896],
      [2.1764, 41.3902],
    ]);
  });

  it('indexes every maneuver into the JOINED line, not into its own leg', async () => {
    const [route] = await provider(answering({ trip: valhallaTrip() })).route({
      locations: [ORIGIN, STOP, DESTINATION],
      mode: 'drive',
      alternatives: false,
    });

    const first = route.legs[0].maneuvers;
    const second = route.legs[1].maneuvers;
    expect(first.map((maneuver) => maneuver.geometryIndex)).toEqual([0, 2, 3]);
    // The second leg starts at index 3 of the joined line. Indexing it from 0
    // would point every one of its maneuvers at the first leg — the bug this
    // test exists for, and one no renderer can detect.
    expect(second.map((maneuver) => maneuver.geometryIndex)).toEqual([3, 5]);
    expect(second[1].coordinate).toEqual({ latitude: 41.3902, longitude: 2.1764 });
    expect(first[1].coordinate).toEqual({ latitude: 41.3881, longitude: 2.1725 });
  });

  it('maps Valhalla’s numeric maneuver types onto the GoWay vocabulary', async () => {
    const [route] = await provider(answering({ trip: valhallaTrip() })).route({
      locations: [ORIGIN, STOP, DESTINATION],
      mode: 'drive',
      alternatives: false,
    });

    expect(route.legs[0].maneuvers.map((maneuver) => maneuver.type)).toEqual([
      'depart',
      'turn-right',
      'arrive',
    ]);
    expect(route.legs[1].maneuvers.map((maneuver) => maneuver.type)).toEqual(['depart', 'arrive']);
    expect(route.legs[0].maneuvers[0].streetName).toBe('Carrer de la Princesa');
    // Absent, not an empty string: "GoWay does not know this road's name" is a
    // different fact from "this road is called nothing".
    expect(route.legs[1].maneuvers[0].streetName).toBeUndefined();
    expect(route.legs[0].maneuvers[1].instruction).toBe('Turn right onto Via Laietana.');
  });

  it('converts from whatever unit the engine ANSWERED in, not the one requested', async () => {
    const trip = { ...(valhallaTrip() as Record<string, unknown>), units: 'miles' };
    const [route] = await provider(answering({ trip })).route({
      locations: [ORIGIN, DESTINATION],
      mode: 'drive',
      alternatives: false,
    });
    // 0.635 miles, not 0.635 km. An engine configured with another default
    // would otherwise turn three miles into three kilometres — a 60 % error
    // that still renders as a believable ETA.
    expect(route.distanceMeters).toBeCloseTo(0.635 * 1609.344, 6);
  });

  it('returns alternatives after the primary route, each with its own id', async () => {
    const routes = await provider(
      answering({ trip: valhallaTrip(), alternates: [{ trip: valhallaTrip() }] }),
    ).route({ locations: [ORIGIN, DESTINATION], mode: 'drive', alternatives: true });

    expect(routes).toHaveLength(2);
    expect(routes[0].id).not.toBe(routes[1].id);
  });
});

describe('the request it sends', () => {
  it('speaks Valhalla’s own dialect, and identifies GoWay while doing it', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const spy: FetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(new Response(JSON.stringify({ trip: valhallaTrip() }), { status: 200 }));
    };

    await provider(spy, { apiKey: 'secret-key' }).route({
      locations: [ORIGIN, STOP, DESTINATION],
      mode: 'bike',
      alternatives: true,
      locale: 'ca-ES',
    });

    expect(seenUrl).toBe('https://valhalla.test/route?api_key=secret-key');
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers['user-agent']).toBe('GoWay/test (+https://goway.to)');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(String(seenInit?.body)) as {
      locations: { lat: number; lon: number; type: string }[];
      costing: string;
      alternates: number;
      directions_options: { units: string; language: string };
    };
    expect(body.costing).toBe('bicycle');
    // Every stop is a hard break, so the engine's legs are exactly the legs the
    // contract promises: one per pair of consecutive stops.
    expect(body.locations).toEqual([
      { lat: 41.387, lon: 2.17, type: 'break' },
      { lat: 41.3889, lon: 2.1738, type: 'break' },
      { lat: 41.3902, lon: 2.1764, type: 'break' },
    ]);
    expect(body.alternates).toBe(2);
    expect(body.directions_options).toEqual({ units: 'kilometers', language: 'ca-ES' });
  });

  it('asks for no alternatives unless the caller wants them', async () => {
    let seenBody = '';
    const spy: FetchLike = (_url, init) => {
      seenBody = String(init.body);
      return Promise.resolve(new Response(JSON.stringify({ trip: valhallaTrip() }), { status: 200 }));
    };
    await provider(spy).route({ locations: [ORIGIN, DESTINATION], mode: 'walk', alternatives: false });
    const body = JSON.parse(seenBody) as Record<string, unknown>;
    expect(body.alternates).toBeUndefined();
    expect(body.costing).toBe('pedestrian');
  });
});

describe('failure mapping', () => {
  it('answers NO ROUTE as an empty list, because that is a normal answer', async () => {
    // Valhalla reports "no path" as an HTTP failure. Passing that through as an
    // error would make a client retry a question that will never have a
    // different answer, and render "GoWay is down" for "you cannot drive there".
    for (const errorCode of [170, 171, 442, 443, 444]) {
      const routes = await provider(
        answering({ error_code: errorCode, error: 'No path could be found for input' }, 400),
      ).route({ locations: [ORIGIN, DESTINATION], mode: 'drive', alternatives: false });
      expect(routes).toEqual([]);
    }
  });

  it('maps a missing costing model to unsupported_mode', async () => {
    const code = await codeOf(
      provider(answering({ error_code: 125, error: 'No costing method found' }, 400)).route({
        locations: [ORIGIN, DESTINATION],
        mode: 'bike',
        alternatives: false,
      }),
    );
    expect(code).toBe('unsupported_mode');
  });

  it('maps a refused request to validation_failed, which is NOT retryable', async () => {
    const code = await codeOf(
      provider(
        answering({ error_code: 154, error: 'Path distance exceeds the max distance limit' }, 400),
      ).route({ locations: [ORIGIN, DESTINATION], mode: 'drive', alternatives: false }),
    );
    expect(code).toBe('validation_failed');
  });

  it('maps an UPSTREAM rate limit to provider_unavailable, not rate_limited', async () => {
    // `rate_limited` means GoWay throttled THIS caller. An engine throttling
    // GoWay is the map data source being unavailable; telling the caller to
    // slow down would be a lie they cannot act on.
    const code = await codeOf(
      provider(answering({}, 429)).route({
        locations: [ORIGIN, DESTINATION],
        mode: 'drive',
        alternatives: false,
      }),
    );
    expect(code).toBe('provider_unavailable');
  });

  it('maps an engine 5xx to provider_unavailable', async () => {
    const code = await codeOf(
      provider(answering({}, 503)).route({
        locations: [ORIGIN, DESTINATION],
        mode: 'drive',
        alternatives: false,
      }),
    );
    expect(code).toBe('provider_unavailable');
  });

  it('bounds the call with its own timeout and reports it as provider_unavailable', async () => {
    // Never resolves on its own. Without the AbortController the request would
    // hang until the client gave up, with nothing logged — indistinguishable
    // from the service being down.
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });

    let failure: unknown;
    try {
      await provider(hang, { timeoutMs: 25 }).route({
        locations: [ORIGIN, DESTINATION],
        mode: 'drive',
        alternatives: false,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('provider_unavailable');
    expect((failure as ApiError).details).toEqual({ reason: 'timeout' });
  });

  it('maps an unreachable engine to provider_unavailable', async () => {
    const code = await codeOf(
      provider(() => Promise.reject(new Error('ECONNREFUSED 10.0.0.1:8002'))).route({
        locations: [ORIGIN, DESTINATION],
        mode: 'drive',
        alternatives: false,
      }),
    );
    expect(code).toBe('provider_unavailable');
  });

  it('maps a 200 that is not a route to provider_unavailable', async () => {
    const code = await codeOf(
      provider(answering({ hello: 'world' })).route({
        locations: [ORIGIN, DESTINATION],
        mode: 'drive',
        alternatives: false,
      }),
    );
    expect(code).toBe('provider_unavailable');
  });

  it('maps an undecodable shape to provider_unavailable rather than serving it', async () => {
    const trip = valhallaTrip() as { legs: { shape: string }[] };
    trip.legs[0].shape = 'not-a-polyline!!';
    const code = await codeOf(
      provider(answering({ trip })).route({
        locations: [ORIGIN, STOP, DESTINATION],
        mode: 'drive',
        alternatives: false,
      }),
    );
    expect(code).toBe('provider_unavailable');
  });

  it('refuses a mode this deployment does not offer without calling the engine', async () => {
    let called = false;
    const spy: FetchLike = () => {
      called = true;
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const code = await codeOf(
      provider(spy, { modes: ['drive', 'walk'] }).route({
        locations: [ORIGIN, DESTINATION],
        mode: 'bike',
        alternatives: false,
      }),
    );
    expect(code).toBe('unsupported_mode');
    expect(called).toBe(false);
  });

  it('refuses fewer than two locations', async () => {
    const code = await codeOf(
      provider(answering({ trip: valhallaTrip() })).route({
        locations: [ORIGIN],
        mode: 'drive',
        alternatives: false,
      }),
    );
    expect(code).toBe('validation_failed');
  });

  it('never puts a coordinate in a failure a caller may log', async () => {
    // `ApiErrorDetails` is the part of an error an integrator logs verbatim,
    // and a route request IS a user's precise location.
    let failure: ApiError | undefined;
    try {
      await provider(answering({}, 503)).route({
        locations: [ORIGIN, DESTINATION],
        mode: 'drive',
        alternatives: false,
      });
    } catch (error) {
      failure = error as ApiError;
    }
    const serialized = JSON.stringify(failure?.toResponseBody());
    expect(serialized).not.toContain('41.387');
    expect(serialized).not.toContain('2.17');
  });
});
