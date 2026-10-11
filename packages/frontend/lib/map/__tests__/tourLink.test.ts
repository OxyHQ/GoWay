/**
 * The tour link: encode → decode is the identity (to the link's precision),
 * and anything that is not a tour this build wrote is `null` — never a throw,
 * never a half-trusted tour.
 */
import { describe, expect, test } from 'bun:test';

import type { Tour } from '@/lib/map/camera/tour';
import { decodeTour, encodeTour, parseTourFromParams, tourLink } from '@/lib/map/tourLink';

const TOUR: Tour = {
  speed: 1.5,
  keyframes: [
    {
      id: 'a',
      center: { latitude: 41.40363, longitude: 2.17436 },
      zoom: 16.25,
      pitch: 55,
      bearing: 0,
      aim: 'path',
      holdMs: 0,
    },
    {
      id: 'b',
      center: { latitude: 41.38791, longitude: 2.16992 },
      zoom: 17,
      pitch: 60,
      bearing: 123.4,
      aim: 'fixed',
      holdMs: 2500,
    },
    {
      id: 'c',
      center: { latitude: 41.41449, longitude: 2.1527 },
      zoom: 15.5,
      pitch: 0,
      bearing: 0,
      aim: 'lookAt',
      lookAt: { latitude: 41.40363, longitude: 2.17436 },
      holdMs: 100,
    },
    {
      id: 'd',
      center: { latitude: -33.85678, longitude: 151.2153 },
      zoom: 3,
      pitch: 12.5,
      bearing: 0,
      aim: 'path',
      holdMs: 0,
    },
  ],
};

describe('round trip', () => {
  test('decode(encode(tour)) is the tour, ids renumbered', () => {
    const decoded = decodeTour(encodeTour(TOUR));
    expect(decoded).not.toBeNull();
    expect(decoded?.speed).toBe(1.5);
    expect(decoded?.keyframes.map((k) => k.id)).toEqual(['k1', 'k2', 'k3', 'k4']);
    decoded?.keyframes.forEach((k, i) => {
      const { id: _a, ...want } = TOUR.keyframes[i];
      const { id: _b, ...got } = k;
      expect(got).toEqual(want);
    });
  });

  test('encoding is stable and compact', () => {
    const a = encodeTour(TOUR);
    expect(encodeTour(decodeTour(a) as Tour)).toBe(a);
    expect(a.startsWith('1.')).toBe(true);
    expect(a.length).toBeLessThan(80);
  });

  test('the link carries the payload and the first camera', () => {
    const url = new URL(tourLink(TOUR, 'https://goway.to/'));
    expect(url.pathname).toBe('/studio');
    expect(url.searchParams.get('lat')).toBe('41.40363');
    expect(url.searchParams.get('zoom')).toBe('16.25');
    const params = Object.fromEntries(url.searchParams);
    expect(parseTourFromParams(params)?.keyframes).toHaveLength(4);
    expect(parseTourFromParams({ tour: [encodeTour(TOUR), 'garbage'] })).not.toBeNull();
  });
});

describe('malformed input', () => {
  const good = encodeTour(TOUR);
  const payload = good.slice(2);

  test.each([
    ['empty', ''],
    ['no version', payload],
    ['unknown version', `2.${payload}`],
    ['version only', '1.'],
    ['not base64url', '1.@@@@'],
    ['standard base64 chars', `1.${payload}+/`],
    ['truncated', good.slice(0, good.length - 3)],
    ['trailing bytes', `${good}AAAA`],
    ['huge', `1.${'A'.repeat(5000)}`],
    ['one keyframe', encodeTour({ speed: 1, keyframes: [TOUR.keyframes[0]] })],
  ])('%s → null', (_name, value) => {
    expect(decodeTour(value)).toBeNull();
  });

  test('out-of-range values are refused by the schema', () => {
    const bad = (patch: Partial<Tour['keyframes'][number]>) =>
      encodeTour({ speed: 1, keyframes: [TOUR.keyframes[0], { ...TOUR.keyframes[1], ...patch }] });
    expect(decodeTour(bad({ pitch: 75 }))).toBeNull();
    expect(decodeTour(bad({ center: { latitude: 89, longitude: 0 } }))).toBeNull();
    expect(decodeTour(bad({ zoom: 30 }))).toBeNull();
    expect(decodeTour(bad({ holdMs: 60_000 }))).toBeNull();
    expect(decodeTour(encodeTour({ ...TOUR, speed: 9 }))).toBeNull();
  });

  test('random bytes never throw', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let i = 0; i < 2000; i++) {
      const length = Math.floor(rand() * 120);
      let text = '1.';
      for (let k = 0; k < length; k++) text += alphabet[Math.floor(rand() * alphabet.length)];
      expect(() => decodeTour(text)).not.toThrow();
    }
  });

  test('absent or non-string params are null', () => {
    expect(parseTourFromParams({})).toBeNull();
    expect(parseTourFromParams({ tour: undefined })).toBeNull();
    expect(parseTourFromParams({ tour: [] })).toBeNull();
  });
});
