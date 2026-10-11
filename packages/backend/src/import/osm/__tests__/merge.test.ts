/**
 * The three-way merge: what a re-import may change, and what it must not.
 *
 * `places_names` gets this guarantee from its key. `places` cannot, so every
 * case below is the guarantee written out — and a regression here is a
 * moderator's correction silently reverted by a nightly job, which nothing
 * would report.
 */

import { describe, expect, test } from 'bun:test';
import { SEEDED_CATALOG } from '../../../__tests__/categoryFixtures';
import { previousColumns, type ImportedColumns } from '../fields';
import { mergePlaceColumns } from '../merge';
import { sourceDataOf, toImportedPlace, type ImportedPlace } from '../placeRecord';

function element(overrides: Record<string, string> = {}, latitude = 41.385) {
  const place = toImportedPlace(
    'node',
    1,
    latitude,
    2.173,
    new Map(Object.entries({ amenity: 'cafe', name: 'Bar Pepe', ...overrides })),
    SEEDED_CATALOG,
  );
  if (!place) throw new Error('fixture is not a POI');
  return place;
}

function held(overrides: Partial<ImportedColumns> = {}): ImportedColumns {
  return { ...element().columns, ...overrides };
}

/** What the last run recorded, read back the way the write path reads it. */
function stated(place: ImportedPlace): Partial<ImportedColumns> {
  return previousColumns(sourceDataOf(place).normalized);
}

const incomingColumns = (place: ImportedPlace) => place.columns;

describe('mergePlaceColumns', () => {
  test('changes nothing when the source repeats itself', () => {
    const place = element();
    expect(mergePlaceColumns(held(), stated(place), incomingColumns(place))).toBeNull();
  });

  test('takes a new value when the column still holds what the source last said', () => {
    const before = element();
    const after = element({ name: 'Bar Pepe i Fills' });
    const changes = mergePlaceColumns(held(), stated(before), incomingColumns(after));
    expect(changes).toEqual({ name: 'Bar Pepe i Fills' });
  });

  test('keeps a GoWay correction the source would otherwise flatten', () => {
    const before = element();
    const after = element({ name: 'BAR PEPE!!!' });
    const corrected = held({
      name: 'Bar Pepe' === before.columns.name ? 'Bar Pepe (corrected)' : '',
    });
    // The column no longer equals what the source said last time, so somebody
    // changed it on purpose. The import may not undo that.
    expect(mergePlaceColumns(corrected, stated(before), incomingColumns(after))).toBeNull();
  });

  test('still fills a gap on a place somebody else has edited', () => {
    const before = element();
    const after = element({ 'addr:street': 'Carrer Nou' });
    const corrected = held({ name: 'Bar Pepe (corrected)', addressStreet: null });
    expect(mergePlaceColumns(corrected, stated(before), incomingColumns(after))).toEqual({
      addressStreet: 'Carrer Nou',
    });
  });

  test('keeps a field somebody cleared empty while the source repeats the value it cleared', () => {
    const place = element({ phone: '+34 930 000 000', 'addr:street': 'Carrer Vell' });
    const cleared = { ...place.columns, contactPhone: null, addressStreet: null };
    expect(mergePlaceColumns(cleared, stated(place), incomingColumns(place))).toBeNull();
  });

  test('refills a cleared field once the source says something new', () => {
    const before = element({ phone: '+34 930 000 000', 'addr:street': 'Carrer Vell' });
    const after = element({ phone: '+34 930 111 111', 'addr:street': 'Carrer Vell' });
    const cleared = { ...before.columns, contactPhone: null, addressStreet: null };
    expect(mergePlaceColumns(cleared, stated(before), incomingColumns(after))).toEqual({
      contactPhone: '+34 930 111 111',
    });
  });

  test('keeps cleared opening hours and categories the way it keeps a cleared phone', () => {
    const place = element({ opening_hours: 'Mo-Fr 09:00-20:00' });
    const cleared = { ...place.columns, openingHours: null, categories: [] };
    expect(mergePlaceColumns(cleared, stated(place), incomingColumns(place))).toBeNull();
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
    const after = element({}, 41.386);
    expect(mergePlaceColumns(held(), stated(before), incomingColumns(after))).toEqual({
      latitude: 41.386,
    });

    const repositioned = held({ latitude: 41.4 });
    expect(mergePlaceColumns(repositioned, stated(before), incomingColumns(after))).toBeNull();
  });

  test('refreshes categories, and leaves a curated list alone', () => {
    const before = element();
    const after = element({ amenity: 'restaurant' });
    expect(mergePlaceColumns(held(), stated(before), incomingColumns(after))).toEqual({
      categories: ['food.restaurant'],
    });

    const curated = held({ categories: ['food.bar', 'food.restaurant'] });
    expect(mergePlaceColumns(curated, stated(before), incomingColumns(after))).toBeNull();
  });

  test('fills an empty category list, which is a gap rather than a decision', () => {
    const after = element();
    expect(mergePlaceColumns(held({ categories: [] }), null, incomingColumns(after))).toEqual({
      categories: ['food.cafe'],
    });
  });

  test('reads a record that predates a column, or holds one in a shape no longer read, as silence', () => {
    const after = element({ 'addr:city': 'Barcelona', name: 'Bar Pepe Nou' });
    // `addressCity` was never recorded; `name` was recorded as something this
    // release cannot read. Neither may be taken as "untouched".
    const record = previousColumns({ name: 42, latitude: 41.385 });
    expect(record).toEqual({ latitude: 41.385 });
    const changes = mergePlaceColumns(held({ addressCity: null }), record, incomingColumns(after));
    expect(changes).toEqual({ addressCity: 'Barcelona' });
  });

  test('refreshes opening hours the source changed, and keeps a schedule somebody corrected', () => {
    const before = element({ opening_hours: 'Mo-Fr 09:00-20:00' });
    const after = element({ opening_hours: 'Mo-Sa 09:00-20:00' });
    const changes = mergePlaceColumns(before.columns, stated(before), incomingColumns(after));
    expect(changes?.openingHours?.intervals).toHaveLength(6);

    const corrected = { ...before.columns, openingHours: { intervals: [], raw: 'by appointment' } };
    expect(mergePlaceColumns(corrected, stated(before), incomingColumns(after))).toBeNull();
  });

  test('compares a schedule by what it says, not by the key order jsonb returns it in', () => {
    const place = element({ opening_hours: 'Mo 09:00-14:00' });
    // jsonb sorts keys shortest first; the importer writes them in contract order.
    const reordered = {
      ...place.columns,
      openingHours: {
        raw: 'Mo 09:00-14:00',
        intervals: [{ closes: '14:00', day: 1 as const, opens: '09:00' }],
      },
    };
    expect(mergePlaceColumns(reordered, stated(place), incomingColumns(place))).toBeNull();
  });
});
