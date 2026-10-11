/**
 * Live route shapes leave the API's general bucket for a wider one of their
 * own; nothing else does.
 */
import { describe, expect, it } from 'bun:test';
import type { Request } from 'express';
import { isLiveShapeRequest } from '../liveShapeRequest';

const request = (method: string, originalUrl: string) =>
  ({ method, originalUrl, url: originalUrl }) as Request;

describe('isLiveShapeRequest', () => {
  it('matches only GET of a live source shape', () => {
    expect(isLiveShapeRequest(request('GET', '/api/v1/live/sources/mta-bus/shapes/M500004'))).toBe(
      true,
    );
    expect(
      isLiveShapeRequest(request('GET', '/api/v1/live/sources/mta-subway/shapes/1..S03R?x=1')),
    ).toBe(true);
    expect(isLiveShapeRequest(request('GET', '/api/v1/live/sources'))).toBe(false);
    expect(isLiveShapeRequest(request('GET', '/api/v1/live/sources/mta-bus/shapes/a/b'))).toBe(
      false,
    );
    expect(isLiveShapeRequest(request('POST', '/api/v1/live/sources/mta-bus/shapes/a'))).toBe(
      false,
    );
    expect(isLiveShapeRequest(request('GET', '/api/v1/places?q=/live/sources/x/shapes/y'))).toBe(
      false,
    );
  });
});
