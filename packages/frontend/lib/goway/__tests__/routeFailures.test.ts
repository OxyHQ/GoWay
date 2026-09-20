/**
 * What the app is allowed to say when it does not know the way.
 *
 * The defect these tests exist for is not a crash. It is a straight line drawn
 * between two stops, in the route's own colour, with a distance beside it,
 * when GoWay could not work out a route at all. A user cannot tell that apart
 * from an answer — which makes it worse than an error, because an error is
 * recoverable and a confident wrong road is not.
 *
 * Two things have to hold for that to stay fixed, and only one of them is
 * about drawing:
 *
 *  1. Every routing outcome the API can return has to classify into a kind the
 *     panel renders DIFFERENTLY. `no_route` and `unsupported_mode` are ANSWERS
 *     — the request was fine, the world or this deployment's coverage is the
 *     answer — and before this they both fell through to `unknown`, which the
 *     panel renders as "Something went wrong" with a "Try again" button that
 *     cannot work.
 *  2. Nothing may be retried that cannot succeed by being repeated.
 */
import { describe, expect, test } from 'bun:test';
import {
  createGoWayClient,
  GoWayAbortError,
  GoWayNetworkError,
  GoWayNoRouteError,
  GoWayTimeoutError,
  GoWayUnavailableError,
  GoWayUnsupportedModeError,
  type GoWayClient,
} from '@goway.to/sdk';

import { classifyGoWayError, shouldRetryGoWay, type GoWayFailureKind } from '@/lib/goway/errors';

describe('routing outcomes classify into something the panel can say', () => {
  test('"no route exists" is its own answer, not a fault', () => {
    const failure = classifyGoWayError(new GoWayNoRouteError('no route'));
    expect(failure.kind).toBe('noRoute');
    // Two points separated by an ocean will still be separated by an ocean on
    // the second attempt.
    expect(failure.retryable).toBe(false);
  });

  test('"GoWay does not route that mode here" is its own answer too', () => {
    const failure = classifyGoWayError(new GoWayUnsupportedModeError('no bicycle costing'));
    expect(failure.kind).toBe('unsupportedMode');
    expect(failure.retryable).toBe(false);
  });

  test('neither is ever retried', () => {
    for (const error of [new GoWayNoRouteError('x'), new GoWayUnsupportedModeError('x')]) {
      expect(shouldRetryGoWay(0, error)).toBe(false);
    }
  });

  test('a deployment with no routing engine reads as unavailable, and may be retried', () => {
    // What `POST /routes` answers when ROUTING_VALHALLA_URL is unset —
    // measured against production before this change existed.
    const failure = classifyGoWayError(new GoWayUnavailableError('Routing is not configured.'));
    expect(failure.kind).toBe('unavailable');
    expect(failure.retryable).toBe(true);
  });

  test('a superseded request is not a failure at all', () => {
    expect(classifyGoWayError(new GoWayAbortError('superseded')).kind).toBe('aborted');
  });

  test('a timeout is not mistaken for being offline', () => {
    expect(classifyGoWayError(new GoWayTimeoutError('slow')).kind).toBe('timeout');
    expect(classifyGoWayError(new GoWayNetworkError('down')).kind).toBe('offline');
  });
});

describe('every routing answer survives the whole chain, envelope to sentence', () => {
  /**
   * Built through the REAL SDK rather than by constructing an error class.
   *
   * The thing that can rot here is not the classifier: it is the chain. GoWay
   * answers `{ error: { code, message } }` over HTTP, the SDK turns that into
   * a class, and only then does `classifyGoWayError` see it. A test that
   * constructs `new GoWayNoRouteError(...)` by hand skips the two links most
   * likely to break, so each case below goes through `routes.directions` with
   * a `fetch` that answers exactly what the backend answers.
   */
  const BARCELONA = { latitude: 41.3851, longitude: 2.1734 };
  const MADRID = { latitude: 40.4168, longitude: -3.7038 };

  function clientAnswering(status: number, body: unknown): GoWayClient {
    const text = JSON.stringify(body);
    return createGoWayClient({
      apiBaseUrl: 'https://api.goway.to',
      fetch: async () => ({ status, headers: { get: () => null }, text: async () => text }),
    });
  }

  async function kindFor(status: number, body: unknown): Promise<GoWayFailureKind | 'ok'> {
    try {
      await clientAnswering(status, body).routes.directions({
        origin: { coordinate: BARCELONA },
        destination: { coordinate: MADRID },
        mode: 'drive',
      });
      return 'ok';
    } catch (error) {
      return classifyGoWayError(error).kind;
    }
  }

  const ANSWERS: ReadonlyArray<readonly [string, number, GoWayFailureKind]> = [
    ['no_route', 404, 'noRoute'],
    ['unsupported_mode', 422, 'unsupportedMode'],
    // What production answered before a routing engine existed.
    ['service_unavailable', 503, 'unavailable'],
    ['provider_unavailable', 503, 'unavailable'],
  ];

  for (const [code, status, expected] of ANSWERS) {
    test(`${code} reaches the panel as "${expected}"`, async () => {
      expect(await kindFor(status, { error: { code, message: `${code} happened` } })).toBe(expected);
    });
  }

  test('not one of them arrives as "Something went wrong"', async () => {
    for (const [code, status] of ANSWERS) {
      expect(await kindFor(status, { error: { code, message: 'x' } })).not.toBe('unknown');
    }
  });

  test('an empty routes array is a 200 and is NOT an error', async () => {
    // The other shape of "no route exists". `useDirections` turns it into the
    // same `noRoute` the panel renders, which is why this must not throw.
    expect(await kindFor(200, { routes: [] })).toBe('ok');
  });
});
