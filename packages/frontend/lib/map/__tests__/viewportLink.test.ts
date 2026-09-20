/**
 * The viewport deep link, from the hostile side.
 *
 * `@goway.to/sdk`'s `links.map()` builds `?lat=&lng=&zoom=` and the app now
 * reads it back, which means three numbers that decide where the camera opens
 * arrive from a URL — from a paste, a chat client that ate a character, a
 * crawler, a locale that writes decimals with a comma. MapLibre does not defend
 * itself here: a non-finite centre reaches `LngLat` and **throws**, which is the
 * crash `components/map/__tests__/nanCoordinates.test.ts` exists about, one
 * layer lower. So the contract these tests pin down is total — a viewport or
 * `null`, never a partial object and never an exception.
 *
 * The positive cases matter just as much: the SDK's own output must survive the
 * round trip, or the link format is promised by a published package and
 * honoured by nobody, which is exactly the state this fixed.
 */
import { describe, expect, test } from 'bun:test';

import { parseViewportFromParams } from '@/lib/map/viewportLink';

describe('the SDK round trip', () => {
  test('reads back what links.map() writes', () => {
    // Exactly the query `GoWayLinks.map()` serialises, keys sorted as it sorts
    // them: `bearing`, `lat`, `lng`, `pitch`, `zoom`.
    const params = Object.fromEntries(
      new URLSearchParams('bearing=45&lat=41.3874&lng=2.1686&pitch=30&zoom=14.5'),
    );
    expect(parseViewportFromParams(params)).toEqual({
      latitude: 41.3874,
      longitude: 2.1686,
      zoom: 14.5,
      bearing: 45,
      pitch: 30,
    });
  });

  test('bearing and pitch are optional on both sides', () => {
    expect(parseViewportFromParams({ lat: '41.3874', lng: '2.1686', zoom: '11' })).toEqual({
      latitude: 41.3874,
      longitude: 2.1686,
      zoom: 11,
    });
  });
});

describe('a link that does not ask for a viewport', () => {
  test.each([
    ['nothing at all', {}],
    ['a centre with no zoom', { lat: '41.3874', lng: '2.1686' }],
    ['a zoom with no centre', { zoom: '14' }],
    ['some other query entirely', { q: 'sagrada familia' }],
  ])('%s → null', (_name, params) => {
    expect(parseViewportFromParams(params)).toBeNull();
  });
});

describe('a link that cannot be drawn', () => {
  // Every one of these is a thing a real URL does, and every one of them used
  // to be impossible only because the app ignored the parameters entirely.
  test.each([
    ['NaN', { lat: 'NaN', lng: '2.1', zoom: '12' }],
    ['Infinity', { lat: '41.3', lng: 'Infinity', zoom: '12' }],
    ['empty string', { lat: '', lng: '2.1', zoom: '12' }],
    // `Number(' ')` is 0, which would silently open on the equator.
    ['whitespace', { lat: ' ', lng: '2.1', zoom: '12' }],
    ['a decimal comma', { lat: '41,3874', lng: '2.1686', zoom: '12' }],
    ['a word', { lat: 'barcelona', lng: '2.1', zoom: '12' }],
    // Web Mercator runs to infinity at ±85.0511; a pole is refused, not clamped,
    // because clamping answers nonsense with a confident map of Antarctica.
    ['the north pole', { lat: '90', lng: '2.1', zoom: '12' }],
    ['the south pole', { lat: '-90', lng: '2.1', zoom: '12' }],
  ])('%s → null', (_name, params) => {
    expect(parseViewportFromParams(params)).toBeNull();
  });

  test('never throws, whatever it is handed', () => {
    const hostile: Record<string, string | string[] | undefined>[] = [
      { lat: undefined, lng: undefined, zoom: undefined },
      { lat: [], lng: [], zoom: [] },
      { lat: ['41.3'], lng: ['2.1'], zoom: ['12'] },
      { lat: '1e400', lng: '2.1', zoom: '12' },
      { lat: '41.3', lng: '2.1', zoom: '-Infinity' },
    ];
    for (const params of hostile) {
      expect(() => parseViewportFromParams(params)).not.toThrow();
    }
  });
});

describe('what is corrected rather than refused', () => {
  test('a repeated parameter takes the first value', () => {
    // `?zoom=14&zoom=17` is a malformed link, not a choice. Refusing the whole
    // viewport over it would throw away a frame that is probably right.
    const params = Object.fromEntries(
      // `Object.fromEntries` over URLSearchParams keeps the LAST; the router
      // hands repeats over as an array, which is the shape that matters here.
      [['lat', ['41.3874', '0']], ['lng', ['2.1686', '0']], ['zoom', ['14', '3']]],
    ) as Record<string, string[]>;
    expect(parseViewportFromParams(params)).toEqual({
      latitude: 41.3874,
      longitude: 2.1686,
      zoom: 14,
    });
  });

  test('longitude wraps, because ±180 is a seam and not a limit', () => {
    expect(parseViewportFromParams({ lat: '0', lng: '181', zoom: '3' })?.longitude).toBe(-179);
    expect(parseViewportFromParams({ lat: '0', lng: '-181', zoom: '3' })?.longitude).toBe(179);
    expect(parseViewportFromParams({ lat: '0', lng: '540', zoom: '3' })?.longitude).toBe(180);
  });

  test('zoom clamps into the source’s advertised range', () => {
    // "as close as you can" is a legible intention; the tile source tops out
    // at 20 and MapLibre would clamp anyway, silently.
    expect(parseViewportFromParams({ lat: '41.3', lng: '2.1', zoom: '99' })?.zoom).toBe(20);
    expect(parseViewportFromParams({ lat: '41.3', lng: '2.1', zoom: '-5' })?.zoom).toBe(0);
  });

  test('bearing wraps and pitch clamps to the engines’ own ceiling', () => {
    expect(parseViewportFromParams({ lat: '41.3', lng: '2.1', zoom: '12', bearing: '450' })?.bearing).toBe(90);
    expect(parseViewportFromParams({ lat: '41.3', lng: '2.1', zoom: '12', bearing: '-90' })?.bearing).toBe(270);
    expect(parseViewportFromParams({ lat: '41.3', lng: '2.1', zoom: '12', pitch: '85' })?.pitch).toBe(60);
    expect(parseViewportFromParams({ lat: '41.3', lng: '2.1', zoom: '12', pitch: '-10' })?.pitch).toBe(0);
  });

  test('an unreadable bearing drops the bearing, not the frame', () => {
    // A rotation is a refinement OF a frame rather than part of it.
    expect(parseViewportFromParams({ lat: '41.3', lng: '2.1', zoom: '12', bearing: 'x' })).toEqual({
      latitude: 41.3,
      longitude: 2.1,
      zoom: 12,
    });
  });
});
