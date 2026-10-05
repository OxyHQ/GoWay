/**
 * Category presentation from a FETCHED taxonomy.
 *
 * The taxonomy is GoWay's database's, reached through `GET /categories`, so
 * every rule here is held against a list the test hands in — never against a
 * copy of the taxonomy, which no longer exists in the app.
 *
 * Bloom's icons are stubbed (`stubCategoryIcons`) so the real module loads.
 */
import { describe, expect, test } from 'bun:test';
import { categoryTaxonomy, type Category } from '@goway.to/sdk';

import { stubCategoryIcons } from './stubCategoryIcons';

stubCategoryIcons();

const { categoryShortcuts, isVisibleAtZoom, resolveCategory, shortcutCategories } = await import(
  '@/lib/goway/categories'
);

function category(key: string, icon: string, en: string, es: string, status: Category['status'] = 'active'): Category {
  const separator = key.lastIndexOf('.');
  return { key, parent: separator < 0 ? null : key.slice(0, separator), icon, status, label: en, labels: { en, es } };
}

const TAXONOMY = categoryTaxonomy([
  category('food', 'restaurant', 'Food & drink', 'Comida y bebida'),
  category('food.cafe', 'cafe', 'Café', 'Cafetería'),
  category('food.space_diner', 'rocket', 'Space diner', 'Cafetería espacial'),
  category('shop', 'shop', 'Shops', 'Tiendas', 'deprecated'),
  category('leisure', 'park', 'Leisure', 'Ocio'),
  category('leisure.park', 'park', 'Park', 'Parque'),
]);

const nameOf = (component: unknown) => (component as { displayName?: string }).displayName;

describe('resolveCategory', () => {
  test('a key the taxonomy holds draws as itself, labelled in the reader language', () => {
    const cafe = resolveCategory(['food.cafe'], TAXONOMY, 'es-MX');
    expect(cafe.key).toBe('food.cafe');
    expect(cafe.label).toBe('Cafetería');
    expect(nameOf(cafe.icon)).toBe('RiRestaurantLine');
    expect(resolveCategory(['food.cafe'], TAXONOMY, 'ja').label).toBe('Café');
  });

  test('the first key the taxonomy holds wins, and an unknown key is skipped', () => {
    expect(resolveCategory(['food.unheard_of', 'leisure.park'], TAXONOMY, 'en').key).toBe('leisure.park');
  });

  test('a place with no known key, or no taxonomy yet, is the generic pin', () => {
    const unknown = resolveCategory(['food.unheard_of'], TAXONOMY, 'en');
    expect(unknown.key).toBe('place');
    expect(nameOf(unknown.icon)).toBe('RiMapPin2Line');
    expect(resolveCategory(['food.cafe'], undefined, 'es').label).toBe('Lugar');
  });

  test('a glyph newer than this build draws as a pin, still labelled', () => {
    const diner = resolveCategory(['food.space_diner'], TAXONOMY, 'en');
    expect(diner.label).toBe('Space diner');
    expect(nameOf(diner.icon)).toBe('RiMapPin2Line');
  });

  test('zoom tiers come from the key, then its root', () => {
    expect(isVisibleAtZoom(['leisure.park'], 12, TAXONOMY)).toBe(true);
    expect(isVisibleAtZoom(['food.cafe'], 14, TAXONOMY)).toBe(false);
    expect(isVisibleAtZoom(['food.cafe'], 15, TAXONOMY)).toBe(true);
  });
});

describe('categoryShortcuts', () => {
  test('one chip per active root the taxonomy holds, labelled by it', () => {
    const shortcuts = categoryShortcuts(TAXONOMY, 'es');
    // `shop` is deprecated, and lodging, culture and transport are not in this list.
    expect(shortcuts.map((shortcut) => [shortcut.id, shortcut.label, shortcut.categories])).toEqual([
      ['eat', 'Comida y bebida', ['food']],
      ['outdoors', 'Ocio', ['leisure']],
    ]);
  });

  test('no chips before the taxonomy arrives', () => {
    expect(categoryShortcuts(undefined, 'en')).toEqual([]);
  });

  test('a shortcut id is its root filter, whatever the taxonomy says', () => {
    expect(shortcutCategories('transit')).toEqual(['transport']);
    expect(shortcutCategories(null)).toBeUndefined();
    expect(shortcutCategories('nope')).toBeUndefined();
  });
});
