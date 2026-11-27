/**
 * The `kind` a GoWay place carries into a search result.
 *
 * A reconciled place REPRESENTS its group, so this is the kind a geocoder's
 * city candidate ends up with once it reconciles to a GoWay gazetteer row — and
 * a locality that came back as `poi` would read as a bug to every consumer that
 * groups results by kind.
 */

import { describe, expect, test } from 'bun:test';
import { searchResultFromPlace } from '../merge';
import { buildPlace } from './fixtures';

describe('searchResultFromPlace kind', () => {
  test('a place leading with `locality` is a locality', () => {
    expect(searchResultFromPlace(buildPlace({ categories: ['locality'] })).kind).toBe('locality');
  });

  test('a place leading with `region` is a region', () => {
    expect(searchResultFromPlace(buildPlace({ categories: ['region'] })).kind).toBe('region');
  });

  test('a categorised POI is still a poi', () => {
    expect(searchResultFromPlace(buildPlace({ categories: ['cafe', 'food_drink'] })).kind).toBe(
      'poi',
    );
  });

  test('a place with no category is a plain place', () => {
    expect(searchResultFromPlace(buildPlace({ categories: [] })).kind).toBe('place');
  });
});
