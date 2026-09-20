/**
 * The suppression rule, the matcher under it, and its documented failures.
 *
 * The last of those matters as much as the first two. This is overlay-side
 * suppression over tiles GoWay does not own, so it is imperfect BY
 * CONSTRUCTION, and a test suite that only asserts the cases it gets right
 * would make it look finished. The `still wrong` block at the bottom pins the
 * known misses in place, so that a later change which fixes one has to say so
 * and a later change which introduces a worse one fails here.
 */
import { describe, expect, test } from 'bun:test';
import type { Place, PlaceStatus } from '@goway.to/sdk';

import type { MapLabelFeature } from '@/components/map';
import {
  describeLabel,
  findPlaceForLabel,
  labelMatchesPlace,
  LABEL_MATCH_RADIUS_M,
  namesMatch,
  normalizeName,
  reconcileLabel,
  suppressLabelledPlaces,
} from '@/lib/goway/basemapLabels';

const AT = { latitude: 41.3851, longitude: 2.1734 };

/** ~metres north of a point, at Barcelona's latitude. */
function north(from: { latitude: number; longitude: number }, meters: number) {
  return { latitude: from.latitude + meters / 111_320, longitude: from.longitude };
}

function label(name: string, overrides: Partial<MapLabelFeature> = {}): MapLabelFeature {
  return {
    id: `poi:${name}`,
    name,
    kind: 'poi',
    coordinate: AT,
    category: 'bar',
    ...overrides,
  };
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

describe('names, compared the way a human would', () => {
  test('accents, case and punctuation are not a difference', () => {
    expect(namesMatch('Gràcia', 'gracia')).toBe(true);
    expect(namesMatch('Cafès El Magnífico', 'Cafes El Magnifico')).toBe(true);
    expect(namesMatch('Bar  Marsella', 'Bar Marsella')).toBe(true);
    expect(normalizeName('Farmàcia Gran de Gràcia')).toBe('farmacia gran de gracia');
  });

  test('a longer name that STARTS with the shorter one is the same thing', () => {
    expect(namesMatch('Hospital Clínic', 'Hospital Clínic de Barcelona')).toBe(true);
  });

  test('a prefix that is merely short is a coincidence, not a match', () => {
    // "Bar" prefixes half of Barcelona's POIs. The length gate is what stops
    // one bar suppressing every chip on the street.
    expect(namesMatch('Bar', 'Bar Marsella')).toBe(false);
    expect(namesMatch('Can', 'Can Solé')).toBe(false);
  });

  test('containment anywhere else is refused, because it means a CONTAINER', () => {
    // "Sants" is a neighbourhood inside the district "Sants-Montjuïc". Matching
    // them would suppress the chip for one against the label for the other.
    expect(namesMatch('Sants', 'Sants-Montjuïc')).toBe(false);
    expect(namesMatch('Marsella', 'Bar Marsella')).toBe(false);
  });

  test('an empty name never matches anything', () => {
    expect(namesMatch('', 'Bar Marsella')).toBe(false);
    expect(namesMatch('   ', '   ')).toBe(false);
  });
});

describe('a label and a place being the same thing', () => {
  test('same name, same point', () => {
    expect(labelMatchesPlace(label('Bar Marsella'), place('Bar Marsella'))).toBe(true);
  });

  test('a match survives the editorial disagreement about where a venue IS', () => {
    const shifted = place('Bar Marsella', { location: north(AT, LABEL_MATCH_RADIUS_M - 10) });
    expect(labelMatchesPlace(label('Bar Marsella'), shifted)).toBe(true);
  });

  test('two branches of one chain on different blocks stay two places', () => {
    const faraway = place('Bar Marsella', { location: north(AT, LABEL_MATCH_RADIUS_M + 50) });
    expect(labelMatchesPlace(label('Bar Marsella'), faraway)).toBe(false);
  });

  test('the radius reaches the real disagreements measured in the tiles', () => {
    // Liceu: GoWay holds 41.3803,2.1735 and the tiles label the station at
    // 41.3814,2.17307 — 128 m apart, because a metro station with four
    // entrances has no single point either source is wrong about.
    const liceu = place('Liceu', { location: { latitude: 41.3803, longitude: 2.1735 } });
    const tiled = label('Liceu', {
      coordinate: { latitude: 41.3814, longitude: 2.17307 },
      category: 'railway',
    });
    expect(labelMatchesPlace(tiled, liceu)).toBe(true);
  });

  test('an AREA label is never a GoWay place, however well the name fits', () => {
    // GoWay Places holds businesses and venues, not the gazetteer. A city label
    // must not be able to suppress a chip or open a place card.
    const city = label('Barcelona', { kind: 'area', category: 'city' });
    expect(labelMatchesPlace(city, place('Barcelona'))).toBe(false);
  });
});

describe('the suppression rule', () => {
  test('a place the basemap already names loses its second chip', () => {
    const marsella = place('Bar Marsella');
    const result = suppressLabelledPlaces({
      places: [marsella],
      labels: [label('Bar Marsella')],
    });
    expect(result.places).toEqual([]);
    expect(result.suppressed.get(marsella.id)?.name).toBe('Bar Marsella');
  });

  test('a place the basemap is NOT naming keeps its chip', () => {
    const solé = place('Can Solé');
    const result = suppressLabelledPlaces({
      places: [solé],
      labels: [label('Bar Marsella')],
    });
    expect(result.places).toEqual([solé]);
    expect(result.suppressed.size).toBe(0);
  });

  test('the SELECTION never yields: a selection you cannot see is not one', () => {
    const marsella = place('Bar Marsella');
    const result = suppressLabelledPlaces({
      places: [marsella],
      labels: [label('Bar Marsella')],
      selectedPlaceId: marsella.id,
    });
    expect(result.places).toEqual([marsella]);
    expect(result.suppressed.size).toBe(0);
  });

  test('an enriched place never yields: OSM cannot say "reachable through Oxy"', () => {
    const marsella = place('Bar Marsella');
    const result = suppressLabelledPlaces({
      places: [marsella],
      labels: [label('Bar Marsella')],
      enrichedPlaceIds: new Set([marsella.id]),
    });
    expect(result.places).toEqual([marsella]);
  });

  test('a permanently closed place never yields: OSM keeps labelling the dead', () => {
    const closed = place('Bar Marsella', { status: 'closed' as PlaceStatus });
    const result = suppressLabelledPlaces({
      places: [closed],
      labels: [label('Bar Marsella')],
    });
    expect(result.places).toEqual([closed]);
  });

  test('nothing suppressed returns the INPUT array, so markers do not rebuild', () => {
    const places = [place('Can Solé')];
    expect(suppressLabelledPlaces({ places, labels: [] }).places).toBe(places);
    expect(suppressLabelledPlaces({ places, labels: [label('Elsewhere')] }).places).toBe(places);
    expect(suppressLabelledPlaces({ places: [], labels: [label('x')] }).places).toEqual([]);
  });

  test('suppression touches the MAP only — the caller still has every place', () => {
    // The sheet's list reads `explore.places`, which this never filters. A row
    // that lost its pin is still a row, still searchable, still openable.
    const places = [place('Bar Marsella'), place('Can Solé')];
    const result = suppressLabelledPlaces({ places, labels: [label('Bar Marsella')] });
    expect(result.places).toHaveLength(1);
    expect(places).toHaveLength(2);
  });
});

describe('resolving a tapped label back to a place', () => {
  test('the places already on screen answer first, with no request', () => {
    const marsella = place('Bar Marsella');
    expect(findPlaceForLabel(label('Bar Marsella'), [place('Can Solé'), marsella])).toBe(marsella);
  });

  test('two candidates in range resolve to the nearer one', () => {
    const near = place('Bar Marsella', { id: 'near', location: north(AT, 5) });
    const far = place('Bar Marsella', { id: 'far', location: north(AT, 120) });
    expect(findPlaceForLabel(label('Bar Marsella'), [far, near])).toBe(near);
  });

  test('nothing in range is an honest null, not a nearest-anything', () => {
    expect(findPlaceForLabel(label('Bar Marsella'), [place('Can Solé')])).toBeNull();
    expect(findPlaceForLabel(label('Bar Marsella'), [])).toBeNull();
  });

  test('search reconciliation only ever trusts a result the BACKEND reconciled', () => {
    const marsella = place('Bar Marsella');
    const results = [
      // A geocoder candidate with the right name and no `place`: the backend
      // did NOT match it through `places_sources`, so it is not a place here
      // either. Treating it as one would be a second reconciliation rule.
      { id: 'photon:1', displayName: 'Bar Marsella', kind: 'poi', coordinate: AT, source: 'photon' },
      { id: 'goway:1', displayName: 'Bar Marsella', kind: 'poi', coordinate: AT, source: 'goway', place: marsella },
    ] as Parameters<typeof reconcileLabel>[1];
    expect(reconcileLabel(label('Bar Marsella'), results)).toBe(marsella);
    expect(reconcileLabel(label('Bar Marsella'), results.slice(0, 1))).toBeNull();
  });
});

describe('describing a label without inventing a category', () => {
  test('the tiles own token, tidied into words', () => {
    expect(describeLabel(label('x', { category: 'hospital', subcategory: 'clinic' }))).toBe('Clinic');
    expect(describeLabel(label('x', { category: 'place_of_worship', subcategory: undefined }))).toBe(
      'Place of worship',
    );
  });

  test('no token means no subtitle — never a category GoWay made up', () => {
    expect(describeLabel(label('x', { category: undefined, subcategory: undefined }))).toBeNull();
    expect(describeLabel(label('x', { category: '  ', subcategory: undefined }))).toBeNull();
  });
});

describe('what this still gets wrong, because the tiles are not ours', () => {
  test('a real name disagreement is NOT matched, and both are drawn', () => {
    // Decoded from a live tile over La Rambla: OSM calls it "Mercat de Sant
    // Josep - La Boqueria"; GoWay's record is "Mercat de la Boqueria". Neither
    // equality nor a prefix relation holds, so the chip is not suppressed and
    // the user sees the thing named twice. Loosening the matcher to fix this
    // would start suppressing the wrong places, which is the worse failure.
    const osm = label('Mercat de Sant Josep - La Boqueria', { category: 'grocery' });
    const goway = place('Mercat de la Boqueria');
    expect(labelMatchesPlace(osm, goway)).toBe(false);
    expect(suppressLabelledPlaces({ places: [goway], labels: [osm] }).suppressed.size).toBe(0);
  });

  test('no labels reported means no suppression at all, at any zoom', () => {
    // Below ~z14 the basemap draws no POI labels, so there is nothing to
    // suppress against and every chip is drawn. That is correct, and it is also
    // why the behaviour visibly changes as the user zooms with no explanation
    // on screen.
    const places = [place('Bar Marsella')];
    expect(suppressLabelledPlaces({ places, labels: [] }).places).toBe(places);
  });
});
