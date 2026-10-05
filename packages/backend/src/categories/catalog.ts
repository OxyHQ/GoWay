/**
 * The category taxonomy as the server reads it: loaded from the database once,
 * held in process, and dropped the moment this process writes it.
 *
 * Categories are read on every hot path — a viewport filter expands a root to
 * its descendants, search matches a category by its labels, the importer files
 * every element through the OpenStreetMap mapping — and the taxonomy changes
 * when a moderator changes it, which is rarely. So {@link categoryCatalog}
 * answers from memory and costs three small SELECTs once per process per
 * {@link CATEGORY_CATALOG_TTL_MS}.
 *
 * ## Fresh here, and soon everywhere
 *
 * A moderation write invalidates THIS process's catalog after it commits
 * (`db/categories/categoryRepository`), so the operator's next read sees it.
 * Another process serving the API learns of it when its own copy expires —
 * at most {@link CATEGORY_CATALOG_TTL_MS} later. Nothing depends on that window
 * being zero: the database is the authority on what a place may carry (the
 * `places_categories_taxonomy_guard` trigger), and a write a stale catalog let
 * through is still refused there, as the same 422 ({@link taxonomyRefusal}).
 * What a stale catalog can do is label with yesterday's wording, or refuse a
 * category created seconds ago — both for one TTL.
 *
 * ## One catalog per database handle
 *
 * Keyed by the handle, not global: every real-database test file runs against
 * its own database in the same process, and a catalog shared between them
 * would read one file's categories into another's assertions.
 */

import { constraintNameOf } from '@oxy.so/db';
import {
  categoryTaxonomy,
  localizedLabel,
  type CategoryPage,
  type CategoryTaxonomy,
  type ModerationCategory,
  type ModerationCategoryPage,
} from '@goway/contracts';
import { loadCategories } from '../db/categories/categoryRepository';
import type { DatabaseOrTransaction } from '../db/postgres';
import { ApiError } from '../http/apiError';

/** How long a process trusts its copy of the taxonomy before reading it again. */
export const CATEGORY_CATALOG_TTL_MS = 60_000;

/** The trigger that holds `places.categories` to the taxonomy (`0016`). */
export const TAXONOMY_GUARD_CONSTRAINT = 'places_categories_taxonomy_guard';

/**
 * What the OpenStreetMap importer files one qualifying tag under — the
 * taxonomy's mapping, read from the database. `key=value` first, then the
 * key-wide `key=*`; ACTIVE categories only, so an import never writes a key
 * the database would refuse.
 */
export interface OsmCategoryMapping {
  osmCategoryOf(key: string, value: string): string | undefined;
}

/** The taxonomy, indexed, as the server reads it. */
export interface CategoryCatalog extends OsmCategoryMapping {
  /**
   * Every category, deprecated ones included, depth-first with siblings by
   * position. Each `label` is the English one; resolve per request.
   */
  readonly taxonomy: CategoryTaxonomy<ModerationCategory>;
  /** `GET /categories` for a locale. */
  page(locale?: string): CategoryPage;
  /** `GET /moderation/categories` for a locale. */
  moderationPage(locale?: string): ModerationCategoryPage;
  /**
   * Every `key=value` / `key=*` tag mapped to these categories or any below
   * them — the OpenStreetMap filter for a category search. Deprecated
   * categories included: filtering by one still finds what carries it.
   */
  osmTagsUnder(keys: readonly string[]): string[];
  /** These keys and every key below them, once each — what a category filter matches. */
  expand(keys: readonly string[]): string[];
}

/** Index a loaded list. Exported for tests that build a catalog without a database. */
export function catalogOf(categories: readonly ModerationCategory[]): CategoryCatalog {
  const taxonomy = categoryTaxonomy(categories);
  const byTag = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const category of categories) {
    if (category.status !== 'active') continue;
    for (const tag of category.osmTags) {
      const [key, value] = tag.split('=') as [string, string];
      if (value === '*') byKey.set(key, category.key);
      else byTag.set(tag, category.key);
    }
  }
  const expand = (keys: readonly string[]) => [...new Set(keys.flatMap((key) => taxonomy.descendants(key)))];
  return {
    taxonomy,
    page: (locale) => ({
      items: categories.map(({ key, parent, icon, status, labels }) => ({
        key,
        parent,
        icon,
        status,
        label: localizedLabel(labels, locale),
        labels,
      })),
      nextCursor: null,
    }),
    moderationPage: (locale) => ({
      items: categories.map((category) => ({ ...category, label: localizedLabel(category.labels, locale) })),
      nextCursor: null,
    }),
    osmCategoryOf: (key, value) => byTag.get(`${key}=${value}`) ?? byKey.get(key),
    osmTagsUnder: (keys) => [
      ...new Set(expand(keys).flatMap((key) => taxonomy.of(key)?.osmTags ?? [])),
    ],
    expand,
  };
}

interface CatalogEntry {
  readonly catalog: Promise<CategoryCatalog>;
  readonly loadedAt: number;
}

export interface CategoryCatalogCache {
  /** The catalog for a database, read from it when this cache holds none or an expired one. */
  get(db: DatabaseOrTransaction): Promise<CategoryCatalog>;
  /** Forget a database's catalog, so the next read sees what was just committed. */
  invalidate(db: DatabaseOrTransaction): void;
}

export function createCategoryCatalogCache(options: {
  ttlMs: number;
  now?: () => number;
}): CategoryCatalogCache {
  const now = options.now ?? Date.now;
  const entries = new WeakMap<DatabaseOrTransaction, CatalogEntry>();
  return {
    get: (db) => {
      const entry = entries.get(db);
      if (entry && now() - entry.loadedAt < options.ttlMs) return entry.catalog;
      // The PROMISE is held, so concurrent readers share one load; a failed
      // load is forgotten rather than served until it expires.
      const catalog = loadCategories(db).then(catalogOf);
      const loaded: CatalogEntry = { catalog, loadedAt: now() };
      entries.set(db, loaded);
      catalog.catch(() => {
        if (entries.get(db) === loaded) entries.delete(db);
      });
      return catalog;
    },
    invalidate: (db) => {
      entries.delete(db);
    },
  };
}

/** The process's cache. */
export const categoryCatalogs: CategoryCatalogCache = createCategoryCatalogCache({ ttlMs: CATEGORY_CATALOG_TTL_MS });

/** The taxonomy as this process currently holds it. */
export function categoryCatalog(db: DatabaseOrTransaction): Promise<CategoryCatalog> {
  return categoryCatalogs.get(db);
}

// ── Holding a request to the taxonomy ───────────────────────────────────────

/**
 * Refuse a category FILTER naming a key that is not a category, as
 * `validation_failed` naming `field.N`. A deprecated key is a category: places
 * still carry it, and asking for them is a fair question.
 */
export function assertCategoryFilter(catalog: CategoryCatalog, keys: readonly string[], field: string): void {
  keys.forEach((key, index) => {
    if (catalog.taxonomy.of(key) === undefined) {
      throw new ApiError('validation_failed', `The request is not acceptable: ${field}.${index} is not a category.`, {
        field: `${field}.${index}`,
        issue: 'unknown_category',
        issueCount: 1,
      });
    }
  });
}

/**
 * Refuse a write that ADDS a key that is not an active category, as
 * `validation_failed` naming `categories.N`. `kept` is what the place carries
 * already: a deprecated key it carries may stay, as the database's trigger
 * allows, so a place is never uneditable because of a key nobody can write.
 */
export function assertWritableCategories(
  catalog: CategoryCatalog,
  keys: readonly string[],
  kept: readonly string[] = [],
): void {
  keys.forEach((key, index) => {
    const category = catalog.taxonomy.of(key);
    if (category?.status === 'active' || (category !== undefined && kept.includes(key))) return;
    const issue = category === undefined ? 'unknown_category' : 'deprecated_category';
    throw new ApiError(
      'validation_failed',
      `The request body is not acceptable: categories.${index} is ${category === undefined ? 'not a category' : 'deprecated'}.`,
      { field: `categories.${index}`, issue, issueCount: 1 },
    );
  });
}

/**
 * The 422 for a write the database's trigger refused — what a catalog older
 * than a moderator's deprecation lets through. `null` for any other error.
 */
export function taxonomyRefusal(error: unknown): ApiError | null {
  if (constraintNameOf(error) !== TAXONOMY_GUARD_CONSTRAINT) return null;
  return new ApiError('validation_failed', 'The request body is not acceptable: categories.', {
    field: 'categories',
    issue: 'inactive_category',
    issueCount: 1,
  });
}
