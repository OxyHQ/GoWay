/**
 * The embed parameter contract: a malformed parameter is ignored, never fatal.
 *
 * This is the test that justifies `/frame` existing at all. Everything else on
 * `goway.to` is reached by somebody who typed our name; `/frame` is reached
 * inside an iframe on a page built by a stranger, from a URL assembled by code
 * we have never seen, on a site whose author cannot debug us and will not
 * report to us. `?center=undefined,undefined` is not a contrived input — it is
 * what a templating bug emits, and it arrives from production the first week.
 *
 * The precedent is specific and recent: `fix(map): stop a NaN coordinate from
 * taking the whole app down`. MapLibre's `LngLat` constructor THROWS on a
 * non-number, and thrown from a React effect that reaches the root error
 * boundary — so one bad coordinate did not misplace a pin, it replaced the
 * application. An embed hands that same constructor values chosen by a third
 * party. `parseEmbedParams` is the only thing standing between the two, so
 * "cannot throw" is asserted here exhaustively rather than argued in a comment.
 *
 * The fuzz case at the bottom is the one that earns its keep: the named cases
 * cover the malformed inputs we thought of, and it covers the ones we did not.
 */
import { describe, expect, test } from 'bun:test';

import {
  MAX_MARKERS,
  initialViewportFrom,
  parseEmbedParams,
  shouldFitBounds,
  type RawParams,
} from '@/lib/map/embed';
import { DEFAULT_VIEWPORT } from '@/components/map/types';

describe('Apple\'s spelling — center and span', () => {
  test('reads `center=LAT,LON` the way maps.apple.com/frame writes it', () => {
    const parsed = parseEmbedParams({ center: '41.3874,2.1686' });
    expect(parsed.center).toEqual({ latitude: 41.3874, longitude: 2.1686 });
  });

  test('turns `span` into a box centred on `center`, halving each delta', () => {
    // Apple's span is the FULL width and height, not a radius. Getting that
    // wrong doubles every embedded viewport and is invisible without a number.
    const parsed = parseEmbedParams({ center: '40,10', span: '2,4' });
    expect(parsed.bounds).toEqual({ south: 39, north: 41, west: 8, east: 12 });
  });

  test('ignores a `span` with no `center` — a size is not a view', () => {
    expect(parseEmbedParams({ span: '2,4' }).bounds).toBeUndefined();
  });

  test('prefers an explicit `zoom` over a `span`, because it is the more precise instruction', () => {
    const parsed = parseEmbedParams({ center: '40,10', span: '2,4', zoom: '15' });
    expect(parsed.bounds).toBeDefined();
    expect(shouldFitBounds(parsed)).toBe(false);
  });

  test('fits the span when no zoom was given', () => {
    expect(shouldFitBounds(parseEmbedParams({ center: '40,10', span: '2,4' }))).toBe(true);
  });

  test('refuses a non-positive span — a zero-area box makes both engines jump to max zoom', () => {
    expect(parseEmbedParams({ center: '40,10', span: '0,0' }).bounds).toBeUndefined();
    expect(parseEmbedParams({ center: '40,10', span: '-2,-4' }).bounds).toBeUndefined();
  });
});

describe("GoWay's spelling — lat, lng, zoom", () => {
  test('reads `lat`/`lng`/`zoom`, the shape the app route uses', () => {
    const parsed = parseEmbedParams({ lat: '51.5', lng: '-0.12', zoom: '14' });
    expect(parsed.center).toEqual({ latitude: 51.5, longitude: -0.12 });
    expect(parsed.zoom).toBe(14);
  });

  test('accepts `lon` and `z` as aliases, because both are in the wild', () => {
    const parsed = parseEmbedParams({ lat: '51.5', lon: '-0.12', z: '9' });
    expect(parsed.center).toEqual({ latitude: 51.5, longitude: -0.12 });
    expect(parsed.zoom).toBe(9);
  });

  test('needs BOTH halves of a coordinate — a lone `lat` is not a place', () => {
    expect(parseEmbedParams({ lat: '51.5' }).center).toBeUndefined();
  });

  test('a partial instruction is still an instruction: zoom alone survives', () => {
    // The alternative — dropping `zoom` for want of a centre — leaves an
    // embedder unable to tell whether their parameter was wrong or their URL was.
    const viewport = initialViewportFrom(parseEmbedParams({ zoom: '15' }));
    expect(viewport.zoom).toBe(15);
    expect(viewport.latitude).toBe(DEFAULT_VIEWPORT.latitude);
  });
});

describe('ranges', () => {
  test('rejects an impossible latitude rather than clamping it', () => {
    // Clamping 999 to 85 would put the map at the north pole and let the
    // embedder believe the parameter worked.
    expect(parseEmbedParams({ center: '999,0' }).center).toBeUndefined();
    expect(parseEmbedParams({ center: '-91,0' }).center).toBeUndefined();
  });

  test('wraps a longitude past the antimeridian, because it is a seam and not an edge', () => {
    expect(parseEmbedParams({ center: '0,185' }).center).toEqual({ latitude: 0, longitude: -175 });
    expect(parseEmbedParams({ center: '0,-185' }).center).toEqual({ latitude: 0, longitude: 175 });
  });

  test('rejects a zoom outside what the engines can draw', () => {
    expect(parseEmbedParams({ zoom: '99' }).zoom).toBeUndefined();
    expect(parseEmbedParams({ zoom: '-1' }).zoom).toBeUndefined();
  });

  test('clamps pitch instead of rejecting it — 90 is an overshoot, not a bug', () => {
    expect(parseEmbedParams({ pitch: '90' }).pitch).toBe(85);
    expect(parseEmbedParams({ pitch: '-10' }).pitch).toBe(0);
  });

  test('a bare `?zoom=` is absence, not zoom 0', () => {
    // `Number('')` is 0, and zoom 0 in a 200px box looks exactly like a broken
    // embed. This is the reason the emptiness check lives in the reader.
    expect(parseEmbedParams({ zoom: '' }).zoom).toBeUndefined();
    expect(parseEmbedParams({ zoom: '   ' }).zoom).toBeUndefined();
  });
});

describe('markers and places', () => {
  test('reads repeated `marker=` parameters in order', () => {
    const parsed = parseEmbedParams({ marker: ['1,2', '3,4'] });
    expect(parsed.markers).toEqual([
      { latitude: 1, longitude: 2 },
      { latitude: 3, longitude: 4 },
    ]);
  });

  test('drops an unparseable marker and keeps the rest', () => {
    const parsed = parseEmbedParams({ marker: ['1,2', 'nonsense', '3,4'] });
    expect(parsed.markers).toHaveLength(2);
  });

  test('caps the marker list, because the parameter is repeatable and arrives from a stranger', () => {
    const many = Array.from({ length: MAX_MARKERS + 25 }, (_, i) => `${i % 80},0`);
    expect(parseEmbedParams({ marker: many }).markers).toHaveLength(MAX_MARKERS);
  });

  test('carries a place id, and refuses an absurdly long one', () => {
    expect(parseEmbedParams({ place: 'abc123' }).placeId).toBe('abc123');
    expect(parseEmbedParams({ place: 'x'.repeat(500) }).placeId).toBeUndefined();
  });
});

describe('interactivity and theme', () => {
  test('is interactive unless the embedder explicitly opted out', () => {
    expect(parseEmbedParams({}).interactive).toBe(true);
    expect(parseEmbedParams({ interactive: 'yes' }).interactive).toBe(true);
    expect(parseEmbedParams({ interactive: '1' }).interactive).toBe(true);
    expect(parseEmbedParams({ interactive: '0' }).interactive).toBe(false);
    expect(parseEmbedParams({ interactive: 'false' }).interactive).toBe(false);
  });

  test('takes a theme only when it names one of the two appearances', () => {
    expect(parseEmbedParams({ theme: 'dark' }).appearance).toBe('dark');
    expect(parseEmbedParams({ theme: 'chartreuse' }).appearance).toBeUndefined();
  });
});

describe('the contract: never throws, never emits a non-finite number', () => {
  const hostile: RawParams[] = [
    {},
    { center: 'undefined,undefined' },
    { center: 'NaN,NaN' },
    { center: 'null,null' },
    { center: '' },
    { center: ',' },
    { center: '1' },
    { center: '1,2,3' },
    { center: '${lat},${lng}' },
    { center: 'Infinity,-Infinity' },
    { center: '1e400,1e400' },
    { lat: 'NaN', lng: 'NaN' },
    { zoom: 'NaN' },
    { zoom: 'Infinity' },
    { bearing: 'NaN', pitch: 'NaN' },
    { span: 'NaN,NaN', center: '0,0' },
    { span: 'Infinity,Infinity', center: '0,0' },
    { marker: ['NaN,NaN', 'undefined,undefined', ''] },
    { center: ['0,0', '1,1'] },
    { place: '' },
    { interactive: 'maybe' },
    // Whatever a router hands over when a key is present with no value.
    { zoom: undefined, center: undefined },
    { marker: 'not even a pair' },
    { center: '0,0', span: '1,1', zoom: 'abc', bearing: 'xyz', pitch: '{}' },
  ];

  for (const params of hostile) {
    test(`survives ${JSON.stringify(params)}`, () => {
      const parsed = parseEmbedParams(params);
      const viewport = initialViewportFrom(parsed);

      // Not "did not throw" alone — the values handed to the engine must be
      // finite, because `LngLat` throws on a NaN and that is the crash.
      expect(Number.isFinite(viewport.latitude)).toBe(true);
      expect(Number.isFinite(viewport.longitude)).toBe(true);
      expect(Number.isFinite(viewport.zoom)).toBe(true);
      expect(Number.isFinite(viewport.bearing ?? 0)).toBe(true);
      expect(Number.isFinite(viewport.pitch ?? 0)).toBe(true);
      for (const marker of parsed.markers) {
        expect(Number.isFinite(marker.latitude)).toBe(true);
        expect(Number.isFinite(marker.longitude)).toBe(true);
      }
      if (parsed.bounds) {
        for (const edge of Object.values(parsed.bounds)) {
          expect(Number.isFinite(edge)).toBe(true);
        }
      }
    });
  }

  test('survives a thousand random query strings', () => {
    // The named cases above cover the malformed inputs somebody thought of.
    // This covers the ones nobody did, which is the category the NaN crash
    // came from.
    const alphabet = '0123456789.,-+eE aN Ifity{}$_undefllNaN%';
    const keys = ['center', 'span', 'lat', 'lng', 'zoom', 'z', 'bearing', 'pitch', 'marker', 'place', 'theme', 'interactive'];
    let seed = 20260920;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let i = 0; i < 1000; i += 1) {
      const params: RawParams = {};
      const count = 1 + Math.floor(next() * 4);
      for (let k = 0; k < count; k += 1) {
        const key = keys[Math.floor(next() * keys.length)];
        const length = Math.floor(next() * 14);
        let value = '';
        for (let c = 0; c < length; c += 1) value += alphabet[Math.floor(next() * alphabet.length)];
        params[key] = value;
      }

      const parsed = parseEmbedParams(params);
      const viewport = initialViewportFrom(parsed);
      expect(Number.isFinite(viewport.latitude * viewport.longitude * viewport.zoom)).toBe(true);
    }
  });
});
