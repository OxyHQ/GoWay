/**
 * The place category taxonomy — one tree of dotted keys, held as data.
 *
 * `food.cafe`, `shop.books`, `transport.rail_station`. A key's PARENT is the
 * key minus its last segment, so the tree is spelled by the keys themselves:
 * the database's `parent_key` is CHECKed against it and can never disagree.
 * Every root is a browseable group ("Food & drink"); every child is something
 * a place IS.
 *
 * ## The taxonomy is in the database, not in this package
 *
 * `place_categories` holds every key, its glyph, its position among its
 * siblings, its status and its OpenStreetMap mapping;
 * `place_category_labels` holds a label per key per language, English
 * required as the fallback and any other language optional. GoWay moderators
 * edit them through `/moderation/categories`, and every client reads them from
 * `GET /categories`. What stays here is what is a CONTRACT rather than data:
 * the key's shape, the closed set of glyphs ({@link CATEGORY_ICONS}), the
 * statuses, the published shapes, and {@link categoryTaxonomy} — the one way
 * any reader (the server, the SDK's consumers, the app) indexes a list it
 * fetched.
 *
 * ## Closed, and enforced by the database
 *
 * `places.categories` holds taxonomy keys and nothing else. A trigger on
 * `places` refuses a key that is not an ACTIVE category on every write that
 * adds it; the API refuses one first, as a 422 naming `categories.N`, and the
 * list filters refuse a key that is not a category at all. A key is never
 * renamed and a key in use is never deleted: a rename is a new key and the
 * old one `deprecated`, which refuses NEW writes while every place already
 * carrying it still reads it.
 *
 * Responses only check a key's SHAPE: a category GoWay adds after an SDK was
 * built is not a parse failure in it.
 *
 * ## Filtering a parent means its descendants
 *
 * A place stores its most specific keys; `?categories=food` matches
 * `food.cafe` and `food.bakery` through {@link CategoryTaxonomy.descendants}.
 * Storing ancestors as well would make every key a second write and a second
 * thing to keep consistent.
 *
 * The OpenStreetMap mapping is NOT part of the published {@link Category}:
 * OpenStreetMap is one source among the ones GoWay reconciles, never the
 * definition of a category. Moderators read and write it
 * ({@link ModerationCategory}); the importer reads it from the database.
 */

import { z } from 'zod';
import { localizedLabel, localizedLabelsSchema, type LocalizedLabels } from './labels';
import { languageTagSchema, normalizeLanguageTag } from './language';
import { pageSchema } from './pagination';
import { instantSchema } from './time';

/**
 * The glyph a category is drawn with, as a provider-neutral key.
 *
 * Each client maps these to its own drawings (the GoWay app to Bloom icons);
 * the key travels instead of an icon file so a client is never asked to fetch
 * artwork to render a pin. Closed, and a CHECK on `place_categories.icon`: a
 * glyph a client has no drawing for would be a category drawn as nothing.
 */
export const CATEGORY_ICONS = [
  'place',
  'restaurant',
  'cafe',
  'bar',
  'nightlife',
  'bakery',
  'grocery',
  'shop',
  'clothing',
  'book',
  'gift',
  'beauty',
  'electronics',
  'hardware',
  'laundry',
  'pet',
  'hotel',
  'camping',
  'park',
  'nature',
  'water',
  'entertainment',
  'sport',
  'golf',
  'museum',
  'art',
  'theatre',
  'cinema',
  'music',
  'landmark',
  'information',
  'bus',
  'train',
  'subway',
  'ferry',
  'bike',
  'car',
  'fuel',
  'parking',
  'charging',
  'hospital',
  'health',
  'pharmacy',
  'school',
  'civic',
  'police',
  'mail',
  'toilets',
  'bank',
  'worship',
  'office',
  'tools',
] as const;
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

/**
 * Where a category is in its life.
 *
 * `active` is filed under, offered, filtered by. `deprecated` is refused on
 * every write that would ADD it to a place, and the importer files nothing
 * under it — but a place that already carries it still reads it, and a filter
 * on it still finds those places. There is no third status and no delete: a
 * key that was ever published must keep meaning what it meant.
 */
export const CATEGORY_STATUSES = ['active', 'deprecated'] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

/** The longest key GoWay stores. The 0.3.0 taxonomy's longest is 27 characters. */
export const MAX_CATEGORY_KEY_LENGTH = 64;

/** A dotted key of lower-case segments: `food`, `food.cafe`, `transport.rail_station`. */
export const CATEGORY_KEY_PATTERN = /^[a-z0-9_]+(?:[.][a-z0-9_]+)*$/;

/** The same pattern for the `place_categories_key_check` CHECK. */
export const CATEGORY_KEY_SQL_PATTERN = '^[a-z0-9_]+([.][a-z0-9_]+)*$';

/** The largest sibling position. Seeded in tens, so a category fits between two without renumbering. */
export const MAX_CATEGORY_POSITION = 1_000_000;

/** The longest label, in any language. A label is a chip, a pin caption, a menu row. */
export const MAX_CATEGORY_LABEL_LENGTH = 80;

/**
 * One OpenStreetMap tag a category files elements under: `amenity=cafe`, or
 * `shop=*` for every `shop` value no more specific category claims.
 */
export const OSM_TAG_PATTERN = /^[a-z][a-z0-9_:]*=(?:\*|[a-z0-9][a-z0-9_:.-]*)$/;

/** The same pattern for the `place_category_osm_tags_tag_check` CHECK. */
export const OSM_TAG_SQL_PATTERN = '^[a-z][a-z0-9_:]*=(\\*|[a-z0-9][a-z0-9_:.-]*)$';

/** The most OpenStreetMap tags one category maps. The 0.3.0 taxonomy's most is seven. */
export const MAX_CATEGORY_OSM_TAGS = 64;

/** The parent key, or `null` for a root. Derived from the key itself. */
export function categoryParent(key: string): string | null {
  const separator = key.lastIndexOf('.');
  return separator < 0 ? null : key.slice(0, separator);
}

/** The root a key belongs to: `food.cafe` → `food`. */
export function categoryRoot(key: string): string {
  const separator = key.indexOf('.');
  return separator < 0 ? key : key.slice(0, separator);
}

// ── The published shapes ────────────────────────────────────────────────────

/**
 * A category key, in a request or a response: any well-formed dotted key.
 *
 * Membership is the DATABASE's question, not this schema's — the taxonomy
 * changes without a release. A request naming a key that is not a category is
 * refused by the API (`validation_failed`); a response is read whatever key it
 * carries, so a category GoWay adds does not break an SDK built before it.
 */
export const categoryKeySchema = z
  .string()
  .max(MAX_CATEGORY_KEY_LENGTH)
  .regex(CATEGORY_KEY_PATTERN);

/** One category as `GET /categories` publishes it. */
export const categorySchema = z.object({
  key: categoryKeySchema,
  /** The enclosing category, `null` for a root. */
  parent: categoryKeySchema.nullable(),
  /** A provider-neutral glyph key ({@link CATEGORY_ICONS}); each client draws it its own way. */
  icon: z.string().min(1),
  status: z.enum(CATEGORY_STATUSES),
  /**
   * The label for the `locale` the list was asked for — the best match among
   * `labels` (`localizedLabel`, the rule every GoWay label follows: `pt-PT`
   * reads `pt-BR`, `zh-SG` reads `zh-Hans`), English when none was asked for
   * or none serves.
   */
  label: z.string().min(1),
  /** English always; every other language GoWay holds the category in, by canonical tag. */
  labels: localizedLabelsSchema,
});
export type Category = z.infer<typeof categorySchema>;

export const categoryPageSchema = pageSchema(categorySchema);
export type CategoryPage = z.infer<typeof categoryPageSchema>;

/**
 * `GET /categories` — one page, always: the taxonomy is a few hundred entries,
 * so `nextCursor` is `null` and there is no `limit`.
 */
export const categoryListQuerySchema = z
  .object({
    /** BCP 47 tag to resolve each `label` against. Every language stays in `labels`. */
    locale: languageTagSchema.optional(),
  })
  .strict();
export type CategoryListQuery = z.input<typeof categoryListQuerySchema>;

// ── Moderation ──────────────────────────────────────────────────────────────

/** An OpenStreetMap `key=value` (or `key=*`) tag, as a moderator writes one. */
export const osmTagSchema = z
  .string()
  .regex(OSM_TAG_PATTERN, 'must be an OpenStreetMap key=value or key=* tag');

/**
 * One category as a moderator reads it: the published shape, plus its position
 * among its siblings and its OpenStreetMap mapping, in tag order.
 */
export const moderationCategorySchema = categorySchema.extend({
  /** Order among siblings, ascending; the list is a depth-first walk in this order. */
  position: z.number().int().min(0),
  /** The `key=value` and `key=*` OpenStreetMap tags the importer files under this category, sorted. */
  osmTags: z.array(z.string()),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type ModerationCategory = z.infer<typeof moderationCategorySchema>;

export const moderationCategoryPageSchema = pageSchema(moderationCategorySchema);
export type ModerationCategoryPage = z.infer<typeof moderationCategoryPageSchema>;

/** A label as stored: trimmed, NFC, one to {@link MAX_CATEGORY_LABEL_LENGTH} characters. */
const categoryLabelTextSchema = z
  .string()
  .min(1)
  .max(MAX_CATEGORY_LABEL_LENGTH)
  .transform((label) => label.normalize('NFC').trim())
  .pipe(z.string().min(1).max(MAX_CATEGORY_LABEL_LENGTH));

/**
 * Labels as a moderator writes them: English required, any other language by
 * BCP 47 tag. Tags are normalized (`ES` → `es`, `pt_br` → `pt-BR`); two that
 * normalize to one tag are refused rather than one silently winning.
 */
export const categoryLabelsInputSchema = z
  .object({ en: categoryLabelTextSchema })
  .catchall(categoryLabelTextSchema)
  .transform((labels, context) => {
    const normalized: Record<string, string> = {};
    for (const [tag, label] of Object.entries(labels)) {
      const language = normalizeLanguageTag(tag);
      if (language === undefined) {
        context.addIssue({ code: 'custom', path: [tag], message: 'must be a BCP 47 language tag' });
        continue;
      }
      if (language in normalized) {
        context.addIssue({ code: 'custom', path: [tag], message: `names ${language} twice` });
        continue;
      }
      normalized[language] = label;
    }
    return normalized as LocalizedLabels;
  });

/** The OpenStreetMap mapping as a moderator writes it. Repeats collapse. */
const osmTagsInputSchema = z
  .array(osmTagSchema)
  .max(MAX_CATEGORY_OSM_TAGS)
  .transform((tags) => [...new Set(tags)]);

/**
 * `POST /moderation/categories` — a new category.
 *
 * There is no `parent`: the key spells it (`food.cafe` is under `food`), and a
 * second statement of the same fact is one that could disagree. The parent
 * must exist and be active.
 */
export const categoryCreateInputSchema = z
  .object({
    key: categoryKeySchema,
    icon: z.enum(CATEGORY_ICONS),
    /** Among its siblings; after the last of them when absent. */
    position: z.number().int().min(0).max(MAX_CATEGORY_POSITION).optional(),
    osmTags: osmTagsInputSchema.default([]),
    labels: categoryLabelsInputSchema,
  })
  .strict();
export type CategoryCreateInput = z.input<typeof categoryCreateInputSchema>;

/**
 * `PATCH /moderation/categories/{key}` — what a moderator may change. The key
 * is not here: it is the category's identity, and a rename is a new key plus
 * this one `deprecated`. `osmTags` replaces the mapping whole.
 */
export const categoryUpdateInputSchema = z
  .object({
    icon: z.enum(CATEGORY_ICONS).optional(),
    position: z.number().int().min(0).max(MAX_CATEGORY_POSITION).optional(),
    osmTags: osmTagsInputSchema.optional(),
    status: z.enum(CATEGORY_STATUSES).optional(),
  })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'must change at least one field',
  });
export type CategoryUpdateInput = z.input<typeof categoryUpdateInputSchema>;

/** `PUT /moderation/categories/{key}/labels/{language}` */
export const categoryLabelInputSchema = z.object({ label: categoryLabelTextSchema }).strict();
export type CategoryLabelInput = z.input<typeof categoryLabelInputSchema>;

// ── Reading a list ──────────────────────────────────────────────────────────

/**
 * A list of categories, indexed: the tree every reader walks.
 *
 * Built from whatever list the reader holds — `GET /categories` for a client,
 * the database for the server — and never from a copy of the taxonomy, so
 * there is no second table for a moderator's edit to miss.
 */
export interface CategoryTaxonomy<C extends Category = Category> {
  /** Every category, in the list's order: depth-first, siblings by position. */
  readonly categories: readonly C[];
  /** One category, or `undefined` for a key this list does not hold. */
  of(key: string): C | undefined;
  /**
   * The label for a key in a locale, falling back to English; the key itself
   * for a key this list does not hold, so an unknown category is identifiable
   * rather than blank.
   */
  label(key: string, locale?: string | null): string;
  /**
   * A key and every key below it, in list order — what `?categories=food`
   * matches. A key this list does not hold expands to nothing.
   */
  descendants(key: string): string[];
}

/** Index a category list. */
export function categoryTaxonomy<C extends Category>(
  categories: readonly C[],
): CategoryTaxonomy<C> {
  const byKey: ReadonlyMap<string, C> = new Map(
    categories.map((category) => [category.key, category]),
  );
  return {
    categories,
    of: (key) => byKey.get(key),
    label: (key, locale) => {
      const category = byKey.get(key);
      return category ? localizedLabel(category.labels, locale) : key;
    },
    descendants: (key) => {
      if (!byKey.has(key)) return [];
      const prefix = `${key}.`;
      return categories
        .filter((category) => category.key === key || category.key.startsWith(prefix))
        .map((category) => category.key);
    },
  };
}
