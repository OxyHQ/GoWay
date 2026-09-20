/**
 * Dereferencing provenance — with issue #58 itself as the fixture.
 *
 * `way/34633854` really is the Empire State Building, and it really was
 * recorded as Museu Picasso's provenance. The first test here is that exact
 * pairing, and it must fail the check.
 */

import { describe, expect, test } from 'bun:test';
import { toImportedPlace } from '../placeRecord';
import { provenanceHolds, sampleEvenly, verifyProvenance } from '../verifyProvenance';

function place(sourceId: string, name: string, translations: Record<string, string> = {}) {
  const [type, id] = sourceId.split('/');
  const built = toImportedPlace(
    (type ?? 'node') as 'node' | 'way' | 'relation',
    Number(id),
    41.385,
    2.18,
    new Map(
      Object.entries({
        tourism: 'museum',
        name,
        ...Object.fromEntries(
          Object.entries(translations).map(([language, value]) => [`name:${language}`, value]),
        ),
      }),
    ),
  );
  if (!built) throw new Error('fixture is not a POI');
  return built;
}

const EMPIRE_STATE = {
  name: 'Empire State Building',
  'name:es': 'Edificio Empire State',
  building: 'yes',
};

const MUSEU_PICASSO = { name: 'Museu Picasso', 'name:es': 'Museo Picasso', tourism: 'museum' };

describe('verifyProvenance', () => {
  test('catches issue #58: an id that resolves to the wrong building', async () => {
    const report = await verifyProvenance([place('way/34633854', 'Museu Picasso')], async () =>
      EMPIRE_STATE,
    );
    expect(report.nameDiffers).toBe(1);
    expect(report.checked[0]?.actual).toBe('Empire State Building');
    expect(provenanceHolds(report)).toBe(false);
  });

  test('passes when the element really is the one that was meant', async () => {
    const report = await verifyProvenance([place('way/188938001', 'Museu Picasso')], async () =>
      MUSEU_PICASSO,
    );
    expect(report.matched).toBe(1);
    expect(provenanceHolds(report)).toBe(true);
  });

  test('accepts a match on any language, because the extract is a snapshot', async () => {
    const report = await verifyProvenance(
      [place('way/188938001', 'Museo Picasso', { ca: 'Museu Picasso' })],
      async () => MUSEU_PICASSO,
    );
    expect(report.matched).toBe(1);
  });

  test('an identifier that denotes nothing fails on its own', async () => {
    const report = await verifyProvenance([place('node/1', 'Ghost')], async () => null);
    expect(report.missing).toBe(1);
    expect(provenanceHolds(report)).toBe(false);
  });

  test('tolerates a minority of names edited since the extract was cut', async () => {
    const sample = Array.from({ length: 20 }, (_, index) =>
      place(`node/${index + 1}`, index === 0 ? 'Renamed Since' : 'Stable'),
    );
    const report = await verifyProvenance(sample, async (sourceId) =>
      sourceId === 'node/1' ? { name: 'Something Else' } : { name: 'Stable' },
    );
    expect(report.nameDiffers).toBe(1);
    expect(provenanceHolds(report)).toBe(true);
  });

  test('fails once the disagreement is the ids rather than the edits', async () => {
    const sample = Array.from({ length: 10 }, (_, index) => place(`node/${index + 1}`, 'Ours'));
    const report = await verifyProvenance(sample, async () => ({ name: 'Theirs' }));
    expect(provenanceHolds(report)).toBe(false);
  });
});

describe('sampleEvenly', () => {
  test('spreads across the run rather than taking the first n', () => {
    const items = Array.from({ length: 100 }, (_, index) => index);
    expect(sampleEvenly(items, 5)).toEqual([0, 20, 40, 60, 80]);
  });

  test('returns everything when there is less than a sample', () => {
    expect(sampleEvenly([1, 2], 5)).toEqual([1, 2]);
  });
});
