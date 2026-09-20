/**
 * The three-way merge: what a re-import may change, and what it must not.
 *
 * `places_names` gets this guarantee from its key. `places` cannot, so every
 * case below is the guarantee written out — and a regression here is a
 * moderator's correction silently reverted by a nightly job, which nothing
 * would report.
 */

import { describe, expect, test } from 'bun:test';
import { incomingColumns, mergePlaceColumns, type MergeablePlaceColumns } from '../merge';
import { sourceDataOf, toImportedPlace } from '../placeRecord';

function element(overrides: Record<string, string> = {}) {
  const place = toImportedPlace(
    'node',
    1,
    41.385,
    2.173,
    new Map(Object.entries({ amenity: 'cafe', name: 'Bar Pepe', ...overrides })),
  );
  if (!place) throw new Error('fixture is not a POI');
  return place;
}

function held(overrides: Partial<MergeablePlaceColumns> = {}): MergeablePlaceColumns {
  return { ...incomingColumns(element()), ...overrides };
}

describe('mergePlaceColumns', () => {
  test('changes nothing when the source repeats itself', () => {
    const place = element();
    expect(mergePlaceColumns(held(), sourceDataOf(place), incomingColumns(place))).toBeNull();
  });

  test('takes a new value when the column still holds what the source last said', () => {
    const before = element();
    const after = element({ name: 'Bar Pepe i Fills' });
    const changes = mergePlaceColumns(held(), sourceDataOf(before), incomingColumns(after));
    expect(changes).toEqual({ name: 'Bar Pepe i Fills' });
  });

  test('keeps a GoWay correction the source would otherwise flatten', () => {
    const before = element();
    const after = element({ name: 'BAR PEPE!!!' });
    const corrected = held({ name: 'Bar Pepe' === before.name ? 'Bar Pepe (corrected)' : '' });
    // The column no longer equals what the source said last time, so somebody
    // changed it on purpose. The import may not undo that.
    expect(mergePlaceColumns(corrected, sourceDataOf(before), incomingColumns(after))).toBeNull();
  });

  test('still fills a gap on a place somebody else has edited', () => {
    const before = element();
    const after = element({ 'addr:street': 'Carrer Nou' });
    const corrected = held({ name: 'Bar Pepe (corrected)', addressStreet: null });
    expect(mergePlaceColumns(corrected, sourceDataOf(before), incomingColumns(after))).toEqual({
      addressStreet: 'Carrer Nou',
    });
  });

  test('with no record of what the source said, fills gaps and changes nothing else', () => {
    const after = element({ name: 'Something Else', 'addr:city': 'Barcelona' });
    const current = held({ addressCity: null });
    expect(mergePlaceColumns(current, null, incomingColumns(after))).toEqual({
      addressCity: 'Barcelona',
    });
  });

  test('moves a place that the source moved, and not one somebody repositioned', () => {
    const before = element();
    const after = element();
    after.latitude = 41.386;
    expect(mergePlaceColumns(held(), sourceDataOf(before), incomingColumns(after))).toEqual({
      latitude: 41.386,
    });

    const repositioned = held({ latitude: 41.4 });
    expect(mergePlaceColumns(repositioned, sourceDataOf(before), incomingColumns(after))).toBeNull();
  });

  test('refreshes categories, and leaves a curated list alone', () => {
    const before = element();
    const after = element({ amenity: 'restaurant' });
    expect(mergePlaceColumns(held(), sourceDataOf(before), incomingColumns(after))).toEqual({
      categories: ['restaurant', 'food_drink'],
    });

    const curated = held({ categories: ['tapas', 'restaurant', 'food_drink'] });
    expect(mergePlaceColumns(curated, sourceDataOf(before), incomingColumns(after))).toBeNull();
  });

  test('fills an empty category list, which is a gap rather than a decision', () => {
    const after = element();
    expect(mergePlaceColumns(held({ categories: [] }), null, incomingColumns(after))).toEqual({
      categories: ['cafe', 'food_drink'],
    });
  });

  test('reads a source_data written by an older importer without failing', () => {
    const after = element({ 'addr:city': 'Barcelona' });
    const ancient = { name: 'Bar Pepe' } as Record<string, unknown>;
    const changes = mergePlaceColumns(held({ addressCity: null }), ancient, incomingColumns(after));
    expect(changes).toEqual({ addressCity: 'Barcelona' });
  });
});
