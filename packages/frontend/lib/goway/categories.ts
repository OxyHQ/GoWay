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
 * `Place.categories` holds keys of GoWay's category taxonomy, most specific
 * first. The taxonomy itself — keys, parents, labels in every language GoWay
 * holds, glyph keys, status — lives in GoWay's database and reaches the app
 * through `GET /categories` (`useCategoryTaxonomy`), so every function here
 * takes the {@link CategoryTaxonomy} it was fetched as. What lives here is
 * only what is this APP's to decide: which Bloom drawing each glyph key is, and
 * at which zoom a category earns a marker. A category a moderator adds after
 * this build still draws — under its root's zoom, or as a generic pin — rather
 * than vanishing from the map, and so does every place while the taxonomy is
 * still loading or failed to load: `undefined` reads as "nothing is known yet",
 * never as an error.
 */
import {
  categoryRoot,
  localizedLabel,
  type CategoryIcon,
  type CategoryTaxonomy,
  type Labels,
} from '@goway.to/sdk';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiAncientGateLine } from '@oxy.so/bloom/icons/RiAncientGateLine';
import { RiAncientPavilionLine } from '@oxy.so/bloom/icons/RiAncientPavilionLine';
import { RiBankLine } from '@oxy.so/bloom/icons/RiBankLine';
import { RiBearSmileLine } from '@oxy.so/bloom/icons/RiBearSmileLine';
import { RiBikeLine } from '@oxy.so/bloom/icons/RiBikeLine';
import { RiBookOpenLine } from '@oxy.so/bloom/icons/RiBookOpenLine';
import { RiBriefcase4Line } from '@oxy.so/bloom/icons/RiBriefcase4Line';
import { RiBusLine } from '@oxy.so/bloom/icons/RiBusLine';
import { RiCake2Line } from '@oxy.so/bloom/icons/RiCake2Line';
import { RiCapsuleFill } from '@oxy.so/bloom/icons/RiCapsuleFill';
import { RiCarLine } from '@oxy.so/bloom/icons/RiCarLine';
import { RiCommunityLine } from '@oxy.so/bloom/icons/RiCommunityLine';
import { RiDropLine } from '@oxy.so/bloom/icons/RiDropLine';
import { RiFilmLine } from '@oxy.so/bloom/icons/RiFilmLine';
import { RiGamepadLine } from '@oxy.so/bloom/icons/RiGamepadLine';
import { RiGiftLine } from '@oxy.so/bloom/icons/RiGiftLine';
import { RiGolfBallLine } from '@oxy.so/bloom/icons/RiGolfBallLine';
import { RiHammerLine } from '@oxy.so/bloom/icons/RiHammerLine';
import { RiHospitalLine } from '@oxy.so/bloom/icons/RiHospitalLine';
import { RiHotelLine } from '@oxy.so/bloom/icons/RiHotelLine';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { RiLeafLine } from '@oxy.so/bloom/icons/RiLeafLine';
import { RiMailLine } from '@oxy.so/bloom/icons/RiMailLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiMedalLine } from '@oxy.so/bloom/icons/RiMedalLine';
import { RiMenLine } from '@oxy.so/bloom/icons/RiMenLine';
import { RiMusic2Line } from '@oxy.so/bloom/icons/RiMusic2Line';
import { RiPaintBrushLine } from '@oxy.so/bloom/icons/RiPaintBrushLine';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiParkingBoxLine } from '@oxy.so/bloom/icons/RiParkingBoxLine';
import { RiPlugLine } from '@oxy.so/bloom/icons/RiPlugLine';
import { RiRestaurantLine } from '@oxy.so/bloom/icons/RiRestaurantLine';
import { RiSchoolLine } from '@oxy.so/bloom/icons/RiSchoolLine';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { RiShip2Line } from '@oxy.so/bloom/icons/RiShip2Line';
import { RiShoppingBasketLine } from '@oxy.so/bloom/icons/RiShoppingBasketLine';
import { RiSmartphoneLine } from '@oxy.so/bloom/icons/RiSmartphoneLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiStethoscopeLine } from '@oxy.so/bloom/icons/RiStethoscopeLine';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { RiSubwayLine } from '@oxy.so/bloom/icons/RiSubwayLine';
import { RiTentLine } from '@oxy.so/bloom/icons/RiTentLine';
import { RiTicketLine } from '@oxy.so/bloom/icons/RiTicketLine';
import { RiToolsLine } from '@oxy.so/bloom/icons/RiToolsLine';
import { RiTrainLine } from '@oxy.so/bloom/icons/RiTrainLine';
import { RiTreeLine } from '@oxy.so/bloom/icons/RiTreeLine';
import { RiTShirtAirLine } from '@oxy.so/bloom/icons/RiTShirtAirLine';

import { deviceLocale } from '@/lib/i18n';

export interface CategoryPresentation {
  /** The taxonomy key as GoWay publishes it, or `place` for the generic pin. */
  key: string;
  /** Human label in the reader's language, from the taxonomy. */
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

/**
 * The Bloom drawing for every glyph key the taxonomy can name.
 *
 * TOTAL over `CategoryIcon`, so a glyph the contract adds fails this file to
 * compile until somebody picks a drawing — rather than drawing a blank. Bloom's
 * vendored Remix subset has no cup or glass, so a café and a bar share the
 * restaurant mark, as the map sprite already does.
 */
const ICONS: Readonly<Record<CategoryIcon, BloomIconComponent>> = {
  place: RiMapPin2Line,
  restaurant: RiRestaurantLine,
  cafe: RiRestaurantLine,
  bar: RiRestaurantLine,
  nightlife: RiMusic2Line,
  bakery: RiCake2Line,
  grocery: RiShoppingBasketLine,
  shop: RiStore2Line,
  clothing: RiTShirtAirLine,
  book: RiBookOpenLine,
  gift: RiGiftLine,
  beauty: RiSparklingLine,
  electronics: RiSmartphoneLine,
  hardware: RiHammerLine,
  laundry: RiTShirtAirLine,
  pet: RiBearSmileLine,
  hotel: RiHotelLine,
  camping: RiTentLine,
  park: RiTreeLine,
  nature: RiLeafLine,
  water: RiDropLine,
  entertainment: RiGamepadLine,
  sport: RiMedalLine,
  golf: RiGolfBallLine,
  museum: RiPaletteLine,
  art: RiPaintBrushLine,
  theatre: RiTicketLine,
  cinema: RiFilmLine,
  music: RiMusic2Line,
  landmark: RiAncientGateLine,
  information: RiInformationLine,
  bus: RiBusLine,
  train: RiTrainLine,
  subway: RiSubwayLine,
  ferry: RiShip2Line,
  bike: RiBikeLine,
  car: RiCarLine,
  fuel: RiCarLine,
  parking: RiParkingBoxLine,
  charging: RiPlugLine,
  hospital: RiHospitalLine,
  health: RiStethoscopeLine,
  pharmacy: RiCapsuleFill,
  school: RiSchoolLine,
  civic: RiCommunityLine,
  police: RiShieldLine,
  mail: RiMailLine,
  toilets: RiMenLine,
  bank: RiBankLine,
  worship: RiAncientPavilionLine,
  office: RiBriefcase4Line,
  tools: RiToolsLine,
};

/** Street level: only once a block fills the screen. Every root not named below. */
const STREET_ZOOM = 15;

/** A root's zoom when the category itself names none: errands at 14, browsing at 15. */
const ZOOM_BY_ROOT: Readonly<Record<string, number>> = {
  lodging: 14,
  leisure: 14,
  sport: 14,
  culture: 13,
  transport: 14,
  health: 14,
  education: 14,
  civic: 14,
  finance: 14,
  worship: 14,
};

/** Categories that orient a whole city, or answer an errand, earlier than their root. */
const ZOOM_BY_KEY: Readonly<Record<string, number>> = {
  'leisure.park': 12,
  'culture.museum': 12,
  'health.hospital': 12,
  'transport.rail_station': 12,
  'civic.townhall': 12,
  'food.restaurant': 14,
  'shop.supermarket': 14,
  'health.pharmacy': 14,
  'finance.bank': 14,
  'transport.bicycle_rental': 14,
  'office.coworking': 14,
};

/** The generic pin's label, in every label language the registry is written in. */
const PLACE_LABELS: Labels = {
  en: 'Place',
  ar: 'مكان',
  bn: 'জায়গা',
  ca: 'Lloc',
  de: 'Ort',
  es: 'Lugar',
  fr: 'Lieu',
  hi: 'जगह',
  ja: 'スポット',
  'pt-BR': 'Local',
  ru: 'Место',
  'zh-Hans': '地点',
};

function generic(locale: string): CategoryPresentation {
  // An unknown category is drawn at the "local detail" tier rather than hidden:
  // GoWay adding a category server-side must not silently empty the map.
  return {
    key: 'place',
    label: localizedLabel(PLACE_LABELS, locale),
    icon: RiMapPin2Line,
    minZoom: 14,
  };
}

/**
 * The presentation for a place, from its category list.
 *
 * "Most specific first" is honoured literally: the first key the taxonomy
 * holds wins, so a place tagged `['food.bakery', 'culture.attraction']` draws
 * as a bakery. With no taxonomy yet every place is the generic pin.
 */
export function resolveCategory(
  categories: readonly string[] | undefined,
  taxonomy: CategoryTaxonomy | undefined,
  locale: string = deviceLocale(),
): CategoryPresentation {
  if (!taxonomy) return generic(locale);
  for (const key of categories ?? []) {
    const category = taxonomy.of(key);
    if (!category) continue;
    return {
      key,
      label: taxonomy.label(key, locale),
      // A glyph newer than this build draws as a pin rather than as nothing.
      icon: (ICONS as Readonly<Record<string, BloomIconComponent>>)[category.icon] ?? RiMapPin2Line,
      minZoom: ZOOM_BY_KEY[key] ?? ZOOM_BY_ROOT[categoryRoot(key)] ?? STREET_ZOOM,
    };
  }
  return generic(locale);
}

/** Whether a place of these categories earns a marker at this zoom. */
export function isVisibleAtZoom(
  categories: readonly string[] | undefined,
  zoom: number,
  taxonomy: CategoryTaxonomy | undefined,
): boolean {
  return zoom >= resolveCategory(categories, taxonomy).minZoom;
}

/**
 * A one-tap category filter.
 *
 * `categories` is passed straight through to the SDK's `categories` filter —
 * the shortcut is a saved QUERY, not a client-side predicate, so it keeps
 * working when the visible set is a page of a much larger one. Each names a
 * taxonomy ROOT, which the API expands to every category below it.
 */
export interface CategoryShortcut {
  id: string;
  label: string;
  icon: BloomIconComponent;
  categories: readonly string[];
}

/**
 * Which roots get a chip, and with which drawing. App presentation, so it is
 * fixed here; what each root is CALLED, and whether it still exists, is the
 * taxonomy's.
 */
const SHORTCUT_ROOTS: readonly { id: string; root: string; icon: BloomIconComponent }[] = [
  { id: 'eat', root: 'food', icon: RiRestaurantLine },
  { id: 'shop', root: 'shop', icon: RiStore2Line },
  { id: 'stay', root: 'lodging', icon: RiHotelLine },
  { id: 'outdoors', root: 'leisure', icon: RiTreeLine },
  { id: 'culture', root: 'culture', icon: RiPaletteLine },
  { id: 'transit', root: 'transport', icon: RiSubwayLine },
];

/**
 * The shortcuts, labelled in the reader's language by the taxonomy.
 *
 * A root the taxonomy does not hold, or holds as `deprecated`, gets no chip: a
 * filter on a key the API refuses, or on one nothing new is filed under, is a
 * chip that answers with an error or an emptying map. With no taxonomy yet
 * there are no chips at all — a row of icons with no words, relabelled a
 * moment later, is the jankier of the two, and the list is cached for every
 * later launch of the screen.
 */
export function categoryShortcuts(
  taxonomy: CategoryTaxonomy | undefined,
  locale: string = deviceLocale(),
): readonly CategoryShortcut[] {
  if (!taxonomy) return [];
  return SHORTCUT_ROOTS.flatMap(({ id, root, icon }) =>
    taxonomy.of(root)?.status === 'active'
      ? [{ id, label: taxonomy.label(root, locale), icon, categories: [root] }]
      : [],
  );
}

/**
 * The filter a shortcut stands for, by id — `undefined` for none or an unknown
 * id. Needs no taxonomy: the API expands the root, and a chip can only have
 * been pressed once the taxonomy drew it.
 */
export function shortcutCategories(id: string | null): readonly string[] | undefined {
  const shortcut = SHORTCUT_ROOTS.find((entry) => entry.id === id);
  return shortcut ? [shortcut.root] : undefined;
}
