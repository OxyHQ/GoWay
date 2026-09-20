/**
 * Hit priority, and the rules that decide which label a tap meant.
 *
 * These are the pure half of "the map's own labels are tappable". The other
 * half — that `queryRenderedFeatures` answers at all, that it answers with
 * PLACED symbols rather than with everything the tiles contain, and that a
 * padded box is genuinely necessary — cannot be asserted here, because it is a
 * property of MapLibre and of the real style. It was measured instead, by
 * driving headless Chromium against `https://goway.to/map/goway-light.json` and
 * real tiles over Barcelona; the numbers are recorded in `labels.ts`, and the
 * ones this file depends on are:
 *
 *  - a query at a POI's exact anchor returns the dot ALONE, and six pixels away
 *    returns nothing — hence a box, hence {@link LABEL_HIT_PAD_PX};
 *  - the label glyph sits 12–20 px BELOW the anchor (`text-anchor: top`), so
 *    the pixel the user aims at and the point the engine indexes are not the
 *    same pixel;
 *  - 16 labels were returned where the loaded source held 3185 POI features, so
 *    a collided-away label is not reported and cannot suppress a chip.
 */
import { describe, expect, test } from 'bun:test';

import {
  collectLabelFeatures,
  LABEL_HIT_PAD_PX,
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
 * A POI as the tiles really carry one — the property bag is copied verbatim
 * from a decoded `poi` feature over Barcelona, `name:latin` and all.
 */
function poi(overrides: Partial<QueriedLabel> & { name?: string } = {}): QueriedLabel {
  const { name = 'Bar Marsella', ...rest } = overrides;
  return {
    featureId: 52689361761,
    sourceLayer: 'poi',
    properties: {
      name,
      'name:latin': name,
      name_int: name,
      class: 'bar',
      subclass: 'bar',
      rank: 12,
    },
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

/** Projection stub: every degree is 1000 px, which is enough to order things. */
const project = (c: { latitude: number; longitude: number }) => ({
  x: (c.longitude - TAP.longitude) * 1000 + AT.x,
  y: (TAP.latitude - c.latitude) * 1000 + AT.y,
});

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

  test('a source-layer GoWay does not read is refused outright', () => {
    expect(isLabelSourceLayer('poi')).toBe(true);
    expect(isLabelSourceLayer('place')).toBe(true);
    // Streets and rivers are deliberately not tappable — a line with an extent
    // wants a different interaction from a point with a door.
    expect(isLabelSourceLayer('transportation_name')).toBe(false);
    expect(isLabelSourceLayer('water_name')).toBe(false);
    expect(isLabelSourceLayer('building')).toBe(false);
    expect(toLabelFeature({ ...poi(), sourceLayer: 'building' }, TAP)).toBeNull();
  });

  test('poi and area are told apart by source-layer, not by guesswork', () => {
    expect(labelKindOf('poi')).toBe('poi');
    expect(labelKindOf('aerodrome_label')).toBe('poi');
    expect(labelKindOf('place')).toBe('area');
    expect(labelKindOf('park')).toBe('area');
    expect(labelKindOf('landuse')).toBeNull();
  });

  test('the tiles category and rank travel verbatim; nothing is translated', () => {
    const label = toLabelFeature(poi(), TAP);
    expect(label).not.toBeNull();
    expect(label?.category).toBe('bar');
    expect(label?.subcategory).toBe('bar');
    expect(label?.rank).toBe(12);
  });
});

describe('the NaN gate, which every derived coordinate crosses', () => {
  test('a non-finite geometry falls back to where the user tapped', () => {
    const label = toLabelFeature(
      poi({ coordinate: { latitude: Number.NaN, longitude: Number.NaN } }),
      TAP,
    );
    // Not dropped — the engine drew it, and the tap is a real point inside it.
    expect(label?.coordinate).toEqual(TAP);
  });

  test('a label placed over a polygon has no point, and uses the tap', () => {
    const label = toLabelFeature({ ...poi(), sourceLayer: 'park', coordinate: null }, TAP);
    expect(label?.kind).toBe('area');
    expect(label?.coordinate).toEqual(TAP);
  });

  test('when the TAP is unusable too, nothing is produced at all', () => {
    // The last line of defence: a label whose coordinate is NaN becomes a
    // marker and a camera target, and MapLibre THROWS on one of those
    // (`Invalid LngLat object: (NaN, NaN)`) out of the effect that positions
    // it — into the screen's error boundary. No label is the correct outcome.
    expect(
      toLabelFeature(poi({ coordinate: null }), { latitude: Number.NaN, longitude: 2 }),
    ).toBeNull();
  });

  test('latitude beyond the poles is refused, as the engine refuses it', () => {
    expect(
      toLabelFeature(poi({ coordinate: { latitude: 91, longitude: 2 } }), TAP)?.coordinate,
    ).toEqual(TAP);
  });
});

describe('hit priority inside the box', () => {
  test('a POI beats the city and the district it sits in', () => {
    // The real shape of a tap at z16: three layers answer, and Apple and Google
    // both open the shop.
    const picked = pickLabelFeature(
      [place('Barcelona'), poi({ name: 'Bar Marsella' }), place('el Raval')],
      { coordinate: TAP, point: AT },
      project,
    );
    expect(picked?.name).toBe('Bar Marsella');
    expect(picked?.kind).toBe('poi');
  });

  test('an area is the answer only when nothing smaller was hit', () => {
    const picked = pickLabelFeature([place('Barcelona')], { coordinate: TAP, point: AT }, project);
    expect(picked?.name).toBe('Barcelona');
  });

  test('within a tier the NEAREST wins, so two shops resolve by pixels', () => {
    const near = poi({
      name: 'Nearer',
      featureId: 1,
      coordinate: { latitude: TAP.latitude - 0.002, longitude: TAP.longitude },
    });
    const far = poi({
      name: 'Further',
      featureId: 2,
      coordinate: { latitude: TAP.latitude - 0.05, longitude: TAP.longitude },
    });
    expect(pickLabelFeature([far, near], { coordinate: TAP, point: AT }, project)?.name).toBe(
      'Nearer',
    );
    // Order of arrival must not change the answer.
    expect(pickLabelFeature([near, far], { coordinate: TAP, point: AT }, project)?.name).toBe(
      'Nearer',
    );
  });

  test('an equal distance is broken by the tiles own rank, then by id', () => {
    const base = { latitude: TAP.latitude, longitude: TAP.longitude };
    const important = poi({ name: 'Important', featureId: 2, coordinate: base });
    important.properties = { ...important.properties, rank: 1 };
    const minor = poi({ name: 'Minor', featureId: 1, coordinate: base });
    minor.properties = { ...minor.properties, rank: 400 };
    expect(pickLabelFeature([minor, important], { coordinate: TAP, point: AT }, project)?.name).toBe(
      'Important',
    );
  });

  test('an unprojectable anchor ranks last in its tier rather than dropping', () => {
    const unprojectable = poi({ name: 'Unprojectable', featureId: 9 });
    const ordinary = poi({
      name: 'Ordinary',
      featureId: 8,
      coordinate: { latitude: TAP.latitude - 0.04, longitude: TAP.longitude },
    });
    const picked = pickLabelFeature([unprojectable, ordinary], { coordinate: TAP, point: AT }, (c) =>
      c === unprojectable.coordinate ? null : project(c),
    );
    expect(picked?.name).toBe('Ordinary');
    // …and it is still the answer when it is the only thing there.
    expect(
      pickLabelFeature([unprojectable], { coordinate: TAP, point: AT }, () => null)?.name,
    ).toBe('Unprojectable');
  });

  test('an empty box is a tap on bare map', () => {
    expect(pickLabelFeature([], { coordinate: TAP, point: AT }, project)).toBeNull();
  });

  test('the hit pad is big enough for the measured dot-to-label gap', () => {
    // 10 px was the measured minimum that reaches both the dot at the anchor
    // and the label drawn below it; the rest is finger slop. A pad of 2 is the
    // bug this replaced.
    expect(LABEL_HIT_PAD_PX).toBeGreaterThanOrEqual(10);
  });
});

describe('the viewport report that feeds suppression', () => {
  test('one POI drawn by a dot layer AND a label layer is reported once', () => {
    const labels = collectLabelFeatures([poi(), poi()], TAP);
    expect(labels).toHaveLength(1);
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
    // The distinction is the whole of why there are two lists: `poi-dot`
    // renders from z15 whether or not its label won a collision, so a dot is
    // not evidence that the basemap is showing the user a NAME.
    expect(TAP_LAYER_IDS).toContain('poi-dot');
    expect(LABEL_LAYER_IDS).not.toContain('poi-dot');
    expect(LABEL_LAYER_IDS).toContain('label-poi');
    expect(LABEL_LAYER_IDS).toContain('label-place-city');
  });

  test('roads and water are excluded on both lists', () => {
    for (const ids of [TAP_LAYER_IDS, LABEL_LAYER_IDS]) {
      expect(ids.some((id) => id.startsWith('label-road'))).toBe(false);
      expect(ids.some((id) => id.includes('water'))).toBe(false);
    }
  });
});

describe('the reported shape is provider-neutral', () => {
  test('nothing MapLibre-shaped survives the crossing', () => {
    const label = toLabelFeature(poi(), TAP) as MapLabelFeature;
    // The engine's own vocabulary — `layer`, `source`, `sourceLayer`, `state`,
    // `geometry` — must not appear on what feature code receives.
    expect(Object.keys(label).sort()).toEqual(
      ['category', 'coordinate', 'id', 'kind', 'name', 'rank', 'subcategory'].sort(),
    );
  });
});
