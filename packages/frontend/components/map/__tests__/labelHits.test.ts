/**
 * Hit priority, and the rule that decides which label a tap meant.
 *
 * These are the pure half of "the map's own labels are tappable". The other
 * half — that `queryRenderedFeatures` answers at all, that it answers with
 * PLACED symbols rather than with everything the tiles contain, and that a
 * padded box is genuinely necessary — cannot be asserted here, because it is a
 * property of MapLibre and of the real style. It was measured instead, by
 * driving headless Chromium against the real GoWay style and real OpenFreeMap
 * tiles over Barcelona; the numbers are recorded in `labels.ts`, and the ones
 * this file depends on are:
 *
 *  - a query at a POI's exact anchor returns the dot ALONE, and six pixels away
 *    returns nothing — hence a box, hence {@link LABEL_HIT_PAD_PX};
 *  - the label glyph sits 12–20 px BELOW the anchor (`text-anchor: top`), so
 *    the pixel the user aims at and the point the engine indexes are not the
 *    same pixel;
 *  - 16 labels were returned where the loaded source held 3185 POI features, so
 *    a collided-away label is not reported.
 */
import { describe, expect, test } from 'bun:test';

import {
  anchorFor,
  collectLabelFeatures,
  LABEL_HIT_PAD_PX,
  LABEL_SOURCE_LAYERS,
  labelCandidatesOf,
  labelKindOf,
  labelNameOf,
  isLabelSourceLayer,
  pickLabelFeature,
  sameLabelSet,
  toLabelFeature,
  type QueriedLabel,
} from '@/components/map/labels';
import type { MapLabelFeature } from '@/components/map/types';
import { TAP_LAYER_IDS, LABEL_LAYER_IDS } from '@/lib/map/tapLayers';
import { GOWAY_STYLE_LAYER_ID_LIST } from '@/lib/map/style/layers';

const TAP = { latitude: 41.3851, longitude: 2.1734 };
const AT = { x: 100, y: 100 };

/**
 * A POI as the tiles really carry one — the property bag copied verbatim from a
 * decoded `poi` feature over Barcelona, `name:latin` and all.
 */
function poi(overrides: Partial<QueriedLabel> & { name?: string } = {}): QueriedLabel {
  const { name = 'Bar Marsella', ...rest } = overrides;
  return {
    featureId: 52689361761,
    sourceLayer: 'poi',
    properties: { name, 'name:latin': name, name_int: name, class: 'bar', subclass: 'bar', rank: 12 },
    coordinate: { latitude: 41.3801, longitude: 2.1699 },
    ...rest,
  };
}

function place(name: string, overrides: Partial<QueriedLabel> = {}): QueriedLabel {
  return {
    featureId: 1523641651,
    sourceLayer: 'place',
    properties: { name, 'name:latin': name, class: 'city', rank: 1 },
    coordinate: { latitude: 41.3851, longitude: 2.1734 },
    ...overrides,
  };
}

/** A street: a LineString, no point of its own. */
function street(name: string, path: [number, number][], overrides: Partial<QueriedLabel> = {}): QueriedLabel {
  return {
    featureId: 900001,
    sourceLayer: 'transportation_name',
    properties: { name, 'name:latin': name, class: 'minor' },
    coordinate: null,
    path: path.map(([latitude, longitude]) => ({ latitude, longitude })),
    ...overrides,
  };
}

/** Projection stub: one degree is 1000 px, which is enough to order things. */
const project = (c: { latitude: number; longitude: number }) => ({
  x: (c.longitude - TAP.longitude) * 1000 + AT.x,
  y: (TAP.latitude - c.latitude) * 1000 + AT.y,
});

const pick = (candidates: readonly QueriedLabel[]) =>
  pickLabelFeature(labelCandidatesOf(candidates, TAP), AT, project);

describe('what a tile feature becomes', () => {
  test('the name is the one the style DRAWS: name:latin, else name', () => {
    expect(labelNameOf({ 'name:latin': 'Gracia', name: 'Gràcia' })).toBe('Gracia');
    expect(labelNameOf({ name: 'Gràcia' })).toBe('Gràcia');
    // `name_en` and `name_int` are present on nearly every feature and are NOT
    // what the map shows. A sheet titled differently from the label the user
    // tapped is worse than no sheet.
    expect(labelNameOf({ name_en: 'Barcelona', name_int: 'Barcelona' })).toBeNull();
    expect(labelNameOf({ name: '   ' })).toBeNull();
  });

  test('a feature with no name is not a label, so it is not tappable', () => {
    expect(toLabelFeature(poi({ properties: { class: 'bar' } }), TAP)).toBeNull();
  });

  test('every text the style draws is covered, and only those', () => {
    // The user asked for "todos esos textos": shops, streets, districts,
    // cities, water. Not the one-way ARROW, which is a symbol and not a name.
    for (const layer of ['poi', 'place', 'park', 'transportation_name', 'water_name', 'waterway']) {
      expect(isLabelSourceLayer(layer)).toBe(true);
    }
    expect(isLabelSourceLayer('transportation')).toBe(false);
    expect(isLabelSourceLayer('building')).toBe(false);
    expect(isLabelSourceLayer('housenumber')).toBe(false);
    expect(toLabelFeature({ ...poi(), sourceLayer: 'building' }, TAP)).toBeNull();
  });

  test('the four kinds are decided by source-layer, never by the name', () => {
    expect(labelKindOf('poi')).toBe('poi');
    expect(labelKindOf('aerodrome_label')).toBe('poi');
    expect(labelKindOf('transportation_name')).toBe('road');
    expect(labelKindOf('water_name')).toBe('water');
    expect(labelKindOf('waterway')).toBe('water');
    expect(labelKindOf('place')).toBe('area');
    expect(labelKindOf('park')).toBe('area');
    expect(labelKindOf('landuse')).toBeNull();
  });

  test('the tiles category and rank travel verbatim; nothing is translated', () => {
    const label = toLabelFeature(poi(), TAP);
    expect(label?.category).toBe('bar');
    expect(label?.subcategory).toBe('bar');
    expect(label?.rank).toBe(12);
  });
});

describe('the NaN gate, which every derived coordinate crosses', () => {
  test('a non-finite geometry falls back to where the user tapped', () => {
    const label = toLabelFeature(poi({ coordinate: { latitude: Number.NaN, longitude: Number.NaN } }), TAP);
    expect(label?.coordinate).toEqual(TAP);
    // …and says so, so a caller can tell "this IS here" from "you pointed here".
    expect(label?.anchored).toBe(false);
  });

  test('a label placed over a polygon has no point, and uses the tap', () => {
    const label = toLabelFeature({ ...poi(), sourceLayer: 'park', coordinate: null }, TAP);
    expect(label?.kind).toBe('area');
    expect(label?.coordinate).toEqual(TAP);
    expect(label?.anchored).toBe(false);
  });

  test('when the TAP is unusable too, nothing is produced at all', () => {
    // The last line of defence: a label whose coordinate is NaN becomes a
    // marker and a camera target, and MapLibre THROWS on one of those
    // (`Invalid LngLat object: (NaN, NaN)`) into the screen's error boundary.
    expect(toLabelFeature(poi({ coordinate: null }), { latitude: Number.NaN, longitude: 2 })).toBeNull();
  });

  test('latitude beyond the poles is refused, as the engine refuses it', () => {
    expect(toLabelFeature(poi({ coordinate: { latitude: 91, longitude: 2 } }), TAP)?.anchored).toBe(false);
  });

  test('a path of garbage does not become an anchor', () => {
    const bad = street('Carrer', []);
    expect(anchorFor(bad, TAP)).toBeNull();
    expect(anchorFor({ ...bad, path: [{ latitude: Number.NaN, longitude: 2 }] }, TAP)).toBeNull();
  });
});

describe('a street is anchored where you pointed at it, not at a vertex', () => {
  test('the nearest point ON the segment, not the nearest end of it', () => {
    // A long straight avenue running east–west, tapped in the middle. The
    // nearest VERTEX is far away at either end; the nearest point on the line
    // is directly under the finger.
    const avenue = street('Avinguda', [
      [TAP.latitude + 0.01, TAP.longitude - 0.5],
      [TAP.latitude + 0.01, TAP.longitude + 0.5],
    ]);
    const anchor = anchorFor(avenue, TAP);
    expect(anchor).not.toBeNull();
    expect(anchor!.longitude).toBeCloseTo(TAP.longitude, 4);
    expect(anchor!.latitude).toBeCloseTo(TAP.latitude + 0.01, 6);
  });

  test('a tap beyond the end of a street clamps to the end, not past it', () => {
    const stub = street('Carreró', [
      [TAP.latitude, TAP.longitude + 0.01],
      [TAP.latitude, TAP.longitude + 0.02],
    ]);
    const anchor = anchorFor(stub, TAP);
    expect(anchor!.longitude).toBeCloseTo(TAP.longitude + 0.01, 6);
  });

  test('the anchored street reports a real position, not the tap', () => {
    const avenue = street('Avinguda', [
      [TAP.latitude + 0.01, TAP.longitude - 0.5],
      [TAP.latitude + 0.01, TAP.longitude + 0.5],
    ]);
    const [label] = labelCandidatesOf([avenue], TAP);
    expect(label.kind).toBe('road');
    expect(label.anchored).toBe(true);
    expect(label.coordinate.latitude).toBeCloseTo(TAP.latitude + 0.01, 6);
  });
});

describe('hit priority inside the box', () => {
  test('a POI beats the city and the district sharing its spot', () => {
    // The real shape of a tap at z16: three layers answer from the same point,
    // and Apple and Google both open the shop. This is where the KIND rule
    // decides — distance cannot, because all three are under the finger.
    const shop = poi({ name: 'Bar Marsella', coordinate: TAP });
    expect(pick([place('Barcelona'), shop, place('el Raval')])?.name).toBe('Bar Marsella');
    expect(pick([shop, place('Barcelona')])?.kind).toBe('poi');
  });

  test('a street beats the district it runs through, at the same spot', () => {
    const through = street('Carrer de Montcada', [
      [TAP.latitude, TAP.longitude - 0.01],
      [TAP.latitude, TAP.longitude + 0.01],
    ]);
    expect(pick([place('el Born'), through])?.name).toBe('Carrer de Montcada');
  });

  test('an area is the answer only when nothing smaller was hit', () => {
    expect(pick([place('Barcelona')])?.name).toBe('Barcelona');
  });

  test('a street name is the answer when the street is what you pointed at', () => {
    // The shop is 40 px away; the street runs under the finger.
    const far = poi({
      name: 'Bar Marsella',
      coordinate: { latitude: TAP.latitude - 0.04, longitude: TAP.longitude },
    });
    const under = street('Carrer de Montcada', [
      [TAP.latitude, TAP.longitude - 0.01],
      [TAP.latitude, TAP.longitude + 0.01],
    ]);
    expect(pick([far, under])?.name).toBe('Carrer de Montcada');
  });

  test('…and the shop wins when the shop is what you pointed at', () => {
    const under = poi({ name: 'Bar Marsella', coordinate: TAP });
    const nearby = street('Carrer de Montcada', [
      [TAP.latitude - 0.005, TAP.longitude - 0.01],
      [TAP.latitude - 0.005, TAP.longitude + 0.01],
    ]);
    expect(pick([under, nearby])?.name).toBe('Bar Marsella');
  });

  test('a park, which has no anchor, loses to anything genuinely nearer', () => {
    const park: QueriedLabel = {
      featureId: 5,
      sourceLayer: 'park',
      properties: { name: 'Parc', 'name:latin': 'Parc' },
      coordinate: null,
    };
    const near = poi({
      name: 'Kiosk',
      coordinate: { latitude: TAP.latitude - 0.005, longitude: TAP.longitude },
    });
    expect(pick([park, near])?.name).toBe('Kiosk');
    // …and wins when it is the only thing in the box.
    expect(pick([park])?.name).toBe('Parc');
  });

  test('within a tier the NEAREST wins, and arrival order does not matter', () => {
    const near = poi({ name: 'Nearer', featureId: 1, coordinate: { latitude: TAP.latitude - 0.002, longitude: TAP.longitude } });
    const far = poi({ name: 'Further', featureId: 2, coordinate: { latitude: TAP.latitude - 0.05, longitude: TAP.longitude } });
    expect(pick([far, near])?.name).toBe('Nearer');
    expect(pick([near, far])?.name).toBe('Nearer');
  });

  test('an equal distance is broken by the tiles own rank, then by id', () => {
    const important = poi({ name: 'Important', featureId: 2, coordinate: TAP });
    important.properties = { ...important.properties, rank: 1 };
    const minor = poi({ name: 'Minor', featureId: 1, coordinate: TAP });
    minor.properties = { ...minor.properties, rank: 400 };
    expect(pick([minor, important])?.name).toBe('Important');
  });

  test('an unprojectable anchor is ranked as unanchored rather than dropped', () => {
    const one = poi({ name: 'Unprojectable', featureId: 9, coordinate: TAP });
    const labels = labelCandidatesOf([one], TAP);
    expect(pickLabelFeature(labels, AT, () => null)?.name).toBe('Unprojectable');
  });

  test('an empty box is a tap on bare map', () => {
    expect(pick([])).toBeNull();
  });

  test('the hit pad is the measured dot-to-label gap plus finger slop', () => {
    // 10 px was measured as the minimum that reaches both the dot at the anchor
    // and the label drawn 12–20 px below it. A pad of 2 is the bug this
    // replaced; do not "tidy" this number without repeating the measurement.
    expect(LABEL_HIT_PAD_PX).toBeGreaterThanOrEqual(10);
  });
});

describe('the viewport report that feeds de-confliction', () => {
  test('one POI drawn by a dot layer AND a label layer is reported once', () => {
    expect(collectLabelFeatures([poi(), poi()], TAP)).toHaveLength(1);
  });

  test('features with no tile id are still keyable, by their point', () => {
    const a = poi({ featureId: null, coordinate: { latitude: 41.1, longitude: 2.1 } });
    const b = poi({ featureId: null, coordinate: { latitude: 41.2, longitude: 2.2 } });
    expect(collectLabelFeatures([a, b], TAP)).toHaveLength(2);
  });

  test('the report is capped, because it crosses into React state', () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      poi({ featureId: index, coordinate: { latitude: 41 + index / 1000, longitude: 2 } }),
    );
    expect(collectLabelFeatures(many, TAP, 10)).toHaveLength(10);
  });

  test('two reports of the same labels are the same set, so markers do not churn', () => {
    const first = collectLabelFeatures([poi(), place('Barcelona')], TAP);
    const second = collectLabelFeatures([poi(), place('Barcelona')], TAP);
    expect(first).not.toBe(second);
    expect(sameLabelSet(first, second)).toBe(true);
    expect(sameLabelSet(first, collectLabelFeatures([poi()], TAP))).toBe(false);
    expect(sameLabelSet(first, [])).toBe(false);
  });
});

describe('the layer ids native queries, since it cannot read its style', () => {
  test('every id is one the published style contract can emit', () => {
    const published = new Set(GOWAY_STYLE_LAYER_ID_LIST);
    expect(TAP_LAYER_IDS.length).toBeGreaterThan(0);
    for (const id of TAP_LAYER_IDS) expect(published.has(id)).toBe(true);
  });

  test('the tap list carries the POI dots and the label list does not', () => {
    // The distinction is the whole of why there are two lists: `poi-dot` is a
    // CIRCLE layer, which has no collision detection at all, so it renders
    // whether or not its label won a collision. A dot is therefore not evidence
    // that the basemap is showing the user a NAME.
    expect(TAP_LAYER_IDS).toContain('poi-dot');
    expect(LABEL_LAYER_IDS).not.toContain('poi-dot');
    expect(LABEL_LAYER_IDS).not.toContain('poi-transit-dot');
  });

  test('every text the style draws is queried, streets and water included', () => {
    for (const id of ['label-poi', 'label-place-city', 'label-road-local', 'label-water-point', 'label-waterway']) {
      expect(LABEL_LAYER_IDS).toContain(id);
      expect(TAP_LAYER_IDS).toContain(id);
    }
  });

  test('the one-way ARROW is not a label and is never queried', () => {
    for (const ids of [TAP_LAYER_IDS, LABEL_LAYER_IDS]) expect(ids).not.toContain('road-oneway');
  });

  test('the two forks read the same source-layers', () => {
    // Web derives its layer list from the loaded style by source-layer; native
    // names the ids. This is the assertion that the two describe one contract.
    expect([...LABEL_SOURCE_LAYERS].sort()).toEqual(
      ['aerodrome_label', 'mountain_peak', 'park', 'place', 'poi', 'transportation_name', 'water_name', 'waterway'].sort(),
    );
  });
});

describe('the reported shape is provider-neutral', () => {
  test('nothing MapLibre-shaped survives the crossing', () => {
    const label = toLabelFeature(poi(), TAP) as MapLabelFeature;
    // The engine's own vocabulary — `layer`, `source`, `sourceLayer`, `state`,
    // `geometry` — must not appear on what feature code receives.
    expect(Object.keys(label).sort()).toEqual(
      ['anchored', 'category', 'coordinate', 'id', 'kind', 'name', 'rank', 'subcategory'].sort(),
    );
  });
});
