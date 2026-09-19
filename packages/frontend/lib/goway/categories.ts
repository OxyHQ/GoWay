/**
 * Category presentation and the zoom rules that keep the map from becoming an
 * icon cloud.
 *
 * Issue #7 → Map markers: "Do not render every possible POI at every zoom
 * level." The rule needs a place to live that is neither the renderer (which
 * must stay provider-neutral) nor a screen (which would make it unreviewable),
 * so it lives here as DATA: one row per category GoWay knows how to draw, and
 * one number per row saying the zoom at which it earns a marker.
 *
 * `Place.categories` is "normalized category keys, most specific first"
 * (`@goway/shared-types`), and the set is OPEN — a category GoWay adds
 * server-side must not vanish from the map because this table has not caught up
 * — so {@link resolveCategory} walks the list and falls back to a generic pin
 * rather than dropping the place.
 */
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiBankLine } from '@oxy.so/bloom/icons/RiBankLine';
import { RiBikeLine } from '@oxy.so/bloom/icons/RiBikeLine';
import { RiBookOpenLine } from '@oxy.so/bloom/icons/RiBookOpenLine';
import { RiBriefcase4Line } from '@oxy.so/bloom/icons/RiBriefcase4Line';
import { RiCake2Line } from '@oxy.so/bloom/icons/RiCake2Line';
import { RiCommunityLine } from '@oxy.so/bloom/icons/RiCommunityLine';
import { RiHospitalLine } from '@oxy.so/bloom/icons/RiHospitalLine';
import { RiHotelLine } from '@oxy.so/bloom/icons/RiHotelLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiRestaurantLine } from '@oxy.so/bloom/icons/RiRestaurantLine';
import { RiShoppingBasketLine } from '@oxy.so/bloom/icons/RiShoppingBasketLine';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { RiSubwayLine } from '@oxy.so/bloom/icons/RiSubwayLine';
import { RiTreeLine } from '@oxy.so/bloom/icons/RiTreeLine';

export interface CategoryPresentation {
  /** The normalized key as GoWay publishes it. */
  key: string;
  /** Human label, already sentence-cased. */
  label: string;
  icon: BloomIconComponent;
  /**
   * The zoom at or above which a place of this category is drawn.
   *
   * Landmarks (a park, a museum, a hospital) orient someone looking at a whole
   * city and are legible at 12. A bakery at 12 is one of four thousand and
   * carries no information, so it waits until the camera is close enough for
   * the answer to be useful.
   */
  minZoom: number;
}

const GENERIC: CategoryPresentation = {
  key: 'place',
  label: 'Place',
  icon: RiMapPin2Line,
  // An unknown category is drawn at the "local detail" tier rather than hidden:
  // GoWay adding a category server-side must not silently empty the map.
  minZoom: 14,
};

/** Every category this build knows how to draw, keyed by its normalized key. */
const CATEGORIES: readonly CategoryPresentation[] = [
  // Landmarks — legible at city scale.
  { key: 'park', label: 'Park', icon: RiTreeLine, minZoom: 12 },
  { key: 'museum', label: 'Museum', icon: RiPaletteLine, minZoom: 12 },
  { key: 'hospital', label: 'Hospital', icon: RiHospitalLine, minZoom: 12 },
  { key: 'transit_station', label: 'Transit', icon: RiSubwayLine, minZoom: 12 },
  { key: 'civic', label: 'Civic', icon: RiCommunityLine, minZoom: 12 },

  // Errands — what someone zoomed to a neighbourhood is looking for.
  { key: 'hotel', label: 'Hotel', icon: RiHotelLine, minZoom: 14 },
  { key: 'restaurant', label: 'Restaurant', icon: RiRestaurantLine, minZoom: 14 },
  { key: 'grocery', label: 'Grocery', icon: RiShoppingBasketLine, minZoom: 14 },
  { key: 'pharmacy', label: 'Pharmacy', icon: RiHospitalLine, minZoom: 14 },
  { key: 'bank', label: 'Bank', icon: RiBankLine, minZoom: 14 },
  { key: 'coworking', label: 'Coworking', icon: RiBriefcase4Line, minZoom: 14 },
  { key: 'bicycle_rental', label: 'Bike hire', icon: RiBikeLine, minZoom: 14 },

  // Street level — only once a block fills the screen.
  { key: 'cafe', label: 'Café', icon: RiRestaurantLine, minZoom: 15 },
  { key: 'bar', label: 'Bar', icon: RiRestaurantLine, minZoom: 15 },
  { key: 'bakery', label: 'Bakery', icon: RiCake2Line, minZoom: 15 },
  { key: 'bookshop', label: 'Bookshop', icon: RiBookOpenLine, minZoom: 15 },
  { key: 'shop', label: 'Shop', icon: RiStore2Line, minZoom: 15 },
];

const BY_KEY = new Map(CATEGORIES.map((entry) => [entry.key, entry]));

/**
 * The presentation for a place, from its category list.
 *
 * "Most specific first" is honoured literally: the first key this build
 * recognises wins, so a place tagged `['bakery', 'shop']` draws as a bakery on
 * a build that knows both and as a shop on one that knows only the second.
 */
export function resolveCategory(categories: readonly string[] | undefined): CategoryPresentation {
  if (!categories) return GENERIC;
  for (const key of categories) {
    const found = BY_KEY.get(key);
    if (found) return found;
  }
  return GENERIC;
}

/** Whether a place of these categories earns a marker at this zoom. */
export function isVisibleAtZoom(categories: readonly string[] | undefined, zoom: number): boolean {
  return zoom >= resolveCategory(categories).minZoom;
}

/**
 * A one-tap category filter.
 *
 * `categories` is passed straight through to the SDK's `categories` filter —
 * the shortcut is a saved QUERY, not a client-side predicate, so it keeps
 * working when the visible set is a page of a much larger one.
 */
export interface CategoryShortcut {
  id: string;
  label: string;
  icon: BloomIconComponent;
  categories: readonly string[];
}

export const CATEGORY_SHORTCUTS: readonly CategoryShortcut[] = [
  { id: 'eat', label: 'Eat & drink', icon: RiRestaurantLine, categories: ['restaurant', 'cafe', 'bar', 'bakery'] },
  { id: 'shop', label: 'Shops', icon: RiStore2Line, categories: ['shop', 'grocery', 'bookshop'] },
  { id: 'stay', label: 'Stay', icon: RiHotelLine, categories: ['hotel'] },
  { id: 'outdoors', label: 'Outdoors', icon: RiTreeLine, categories: ['park'] },
  { id: 'culture', label: 'Culture', icon: RiPaletteLine, categories: ['museum'] },
  { id: 'transit', label: 'Transit', icon: RiSubwayLine, categories: ['transit_station', 'bicycle_rental'] },
];
