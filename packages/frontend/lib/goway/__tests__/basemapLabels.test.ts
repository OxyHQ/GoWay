/**
 * Resolution, de-confliction, and the line between them.
 *
 * The line is the point of this file. Resolving a tapped label to a place is an
 * INFERENCE and is allowed to be one, because a wrong answer shows a plausible
 * card the user can back out of. Removing a marker is not, because a wrong
 * answer deletes a place from the map silently. So the tests below assert two
 * different standards on purpose: `reconcileLabel` is allowed to guess within
 * stated bounds, and nothing anywhere is allowed to drop a marker.
 */
import { describe, expect, test } from 'bun:test';
import type { Place, PlaceStatus, SearchResult } from '@goway.to/sdk';

import type { MapLabelFeature, MapMarker } from '@/components/map';
import {
  DECLUTTER_RADIUS_PX,
  declutterMarkerLabels,
  describeLabel,
  LABEL_RESOLVE_RADIUS_M,
  reconcileLabel,
} from '@/lib/goway/basemapLabels';

const AT = { latitude: 41.3851, longitude: 2.1734 };

/** ~metres north of a point, at Barcelona's latitude. */
function north(from: { latitude: number; longitude: number }, meters: number) {
  return { latitude: from.latitude + meters / 111_320, longitude: from.longitude };
}

function label(name: string, overrides: Partial<MapLabelFeature> = {}): MapLabelFeature {
  return { id: `poi:${name}`, name, kind: 'poi', coordinate: AT, anchored: true, category: 'bar', ...overrides };
}

function place(name: string, overrides: Partial<Place> = {}): Place {
  return {
    id: `place-${name}`,
    name,
    location: AT,
    categories: ['bar'],
    status: 'open' as PlaceStatus,
    verification: { state: 'unverified' },
    sources: [],
    capabilities: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Place;
}

function result(name: string, embedded?: Place, coordinate = AT): SearchResult {
  return {
    id: `r-${name}-${embedded?.id ?? 'none'}`,
    displayName: name,
    kind: 'poi',
    coordinate,
    source: embedded ? 'goway' : 'photon',
    ...(embedded ? { place: embedded, placeId: embedded.id } : {}),
  } as SearchResult;
}

function marker(id: string, text: string | undefined, overrides: Partial<MapMarker> = {}): MapMarker {
  return {
    id,
    coordinate: AT,
    ...(text === undefined ? {} : { label: text }),
    accessibilityLabel: `${id}, a place`,
    ...overrides,
  };
}

describe('resolving a tapped label — an inference, within stated bounds', () => {
  test('only a candidate the BACKEND reconciled can be the answer', () => {
    const bar = place('Bar Marsella');
    // The geocoder candidate has the right name and no `place`: the backend did
    // NOT match it through `places_sources`, so it is not a place here either.
    // Trusting it would be a second, client-side definition of identity.
    expect(reconcileLabel(label('Bar Marsella'), [result('Bar Marsella')])).toBeNull();
    expect(reconcileLabel(label('Bar Marsella'), [result('Bar Marsella', bar)])).toBe(bar);
  });

  test('names are NOT compared here — the search was by the name already', () => {
    // GoWay's own search decided these candidates answer to the tapped text.
    // A second string rule in the client would compete with the backend's.
    const different = place('Mercat de Sant Josep');
    expect(reconcileLabel(label('Mercat de la Boqueria'), [result('x', different)])).toBe(different);
  });

  test('the nearest reconciled candidate wins', () => {
    const near = place('Liceu', { id: 'near', location: north(AT, 10) });
    const far = place('Liceu', { id: 'far', location: north(AT, 120) });
    expect(reconcileLabel(label('Liceu'), [result('a', far), result('b', near)])).toBe(near);
  });

  test('the radius reaches the real disagreements measured in the tiles', () => {
    // Liceu: GoWay holds 41.3803,2.1735 and the tiles label the station at
    // 41.3814,2.17307 — 128 m apart, because a metro station with four
    // entrances has no single point either source is wrong about.
    const liceu = place('Liceu', { location: { latitude: 41.3803, longitude: 2.1735 } });
    const tiled = label('Liceu', { coordinate: { latitude: 41.3814, longitude: 2.17307 } });
    expect(reconcileLabel(tiled, [result('liceu', liceu)])).toBe(liceu);
  });

  test('beyond the radius it answers null rather than nearest-anything', () => {
    const faraway = place('Liceu', { location: north(AT, LABEL_RESOLVE_RADIUS_M + 60) });
    expect(reconcileLabel(label('Liceu'), [result('liceu', faraway)])).toBeNull();
    expect(reconcileLabel(label('Liceu'), [])).toBeNull();
  });

  test('a street, a river and a city are never resolved to a place', () => {
    // GoWay Places holds businesses and venues, not the gazetteer and not the
    // street network. Asking would only invite a wrong match.
    const anything = place('Carrer de Montcada');
    for (const kind of ['road', 'water', 'area'] as const) {
      expect(reconcileLabel(label('Carrer de Montcada', { kind }), [result('x', anything)])).toBeNull();
    }
  });
});

describe('de-confliction — no marker is ever removed', () => {
  test('a chip on top of a placed label drops its TEXT and keeps everything else', () => {
    const out = declutterMarkerLabels({
      markers: [marker('p1', 'Bar Marsella', { kind: 'bar' })],
      labels: [label('anything at all')],
      zoom: 16,
    });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBeUndefined();
    // Still on the map, still identifiable, still announced.
    expect(out[0].id).toBe('p1');
    expect(out[0].coordinate).toEqual(AT);
    expect(out[0].kind).toBe('bar');
    expect(out[0].accessibilityLabel).toBe('p1, a place');
  });

  test('identity is never claimed: a DIFFERENT name on the same spot still declutters', () => {
    // This is the whole design. Overlapping pixels are a fact about pixels; the
    // two may or may not be the same thing, and this does not care, because the
    // worst case is a name read one tap away rather than zero.
    const out = declutterMarkerLabels({
      markers: [marker('p1', 'Can Solé')],
      labels: [label('Bar Marsella')],
      zoom: 16,
    });
    expect(out[0].label).toBeUndefined();
    expect(out).toHaveLength(1);
  });

  test('a label that is not on the same spot changes nothing', () => {
    const markers = [marker('p1', 'Bar Marsella')];
    const out = declutterMarkerLabels({
      markers,
      labels: [label('Elsewhere', { coordinate: north(AT, 400) })],
      zoom: 16,
    });
    // The INPUT array, so a settled frame does not rebuild every marker.
    expect(out).toBe(markers);
  });

  test('the same two points declutter zoomed OUT and not zoomed in', () => {
    // 40 m apart is 179 px at z18 — two clearly separate pieces of text, both
    // of which should say their name — and 11 px at z14, where they are on the
    // same spot. That inversion is why this is decided in pixels and could not
    // be decided in metres.
    const markers = [marker('p1', 'Bar Marsella')];
    const labels = [label('Nearby', { coordinate: north(AT, 40) })];
    expect(declutterMarkerLabels({ markers, labels, zoom: 18 })).toBe(markers);
    expect(declutterMarkerLabels({ markers, labels, zoom: 14 })[0].label).toBeUndefined();
  });

  test('the SELECTION keeps its name: it is the map answering what you just did', () => {
    const markers = [marker('p1', 'Bar Marsella', { selected: true })];
    expect(declutterMarkerLabels({ markers, labels: [label('Bar Marsella')], zoom: 16 })).toBe(markers);
  });

  test('a cluster keeps its text, because a count duplicates nothing', () => {
    const markers = [marker('c1', undefined, { count: 7 })];
    expect(declutterMarkerLabels({ markers, labels: [label('x')], zoom: 16 })).toBe(markers);
  });

  test('nothing to work with is a no-op, not a crash', () => {
    const markers = [marker('p1', 'Bar Marsella')];
    expect(declutterMarkerLabels({ markers, labels: [], zoom: 16 })).toBe(markers);
    expect(declutterMarkerLabels({ markers: [], labels: [label('x')], zoom: 16 })).toEqual([]);
    // A NaN zoom is the seam's recurring hazard; here it means "do nothing".
    expect(declutterMarkerLabels({ markers, labels: [label('x')], zoom: Number.NaN })).toBe(markers);
  });

  test('the radius is about the size of the two pieces of text it separates', () => {
    expect(DECLUTTER_RADIUS_PX).toBeGreaterThanOrEqual(16);
    expect(DECLUTTER_RADIUS_PX).toBeLessThanOrEqual(48);
  });

  test('every marker survives, always — the property this file exists to hold', () => {
    const markers = [
      marker('a', 'One'),
      marker('b', 'Two'),
      marker('c', undefined, { count: 4 }),
      marker('d', 'Four', { selected: true }),
    ];
    const out = declutterMarkerLabels({ markers, labels: [label('x')], zoom: 18 });
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('describing a label without inventing a category', () => {
  test('a POI gets the tiles own token, tidied into words', () => {
    expect(describeLabel(label('x', { category: 'hospital', subcategory: 'clinic' }))).toBe('Clinic');
    expect(describeLabel(label('x', { category: 'place_of_worship', subcategory: undefined }))).toBe(
      'Place of worship',
    );
  });

  test('a road gets the word a person uses, not the network tier', () => {
    // The raw token is `minor` / `trunk` / `motorway`; "Minor" under a street
    // name is the tiles talking to themselves.
    const road = (cls: string) => describeLabel(label('Carrer', { kind: 'road', category: cls }));
    expect(road('minor')).toBe('Street');
    expect(road('service')).toBe('Street');
    expect(road('primary')).toBe('Road');
    expect(road('motorway')).toBe('Motorway');
    expect(road('path')).toBe('Path');
    expect(road('ferry')).toBe('Ferry route');
    expect(describeLabel(label('Carrer', { kind: 'road', category: undefined }))).toBe('Street');
  });

  test('water always says what it is, even when the tiles are silent', () => {
    expect(describeLabel(label('Mediterrani', { kind: 'water', category: undefined }))).toBe('Water');
    expect(describeLabel(label('Besòs', { kind: 'water', category: 'river' }))).toBe('River');
  });

  test('no token means no subtitle — never a category GoWay made up', () => {
    expect(describeLabel(label('x', { category: undefined, subcategory: undefined }))).toBeNull();
    expect(describeLabel(label('x', { category: '  ', subcategory: undefined }))).toBeNull();
  });
});
