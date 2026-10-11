/**
 * The place category taxonomy, as data a moderator edits.
 *
 * Until `0015` the taxonomy was a registry in `@goway/contracts` and
 * `places.categories` was CHECKed against an array literal built from it, so a
 * new category, a corrected label or a third language was a release. Now:
 *
 *  - `place_categories`        — one row per key: its parent, glyph, position
 *                                among its siblings and status.
 *  - `place_category_labels`   — one row per key per language. English is
 *                                REQUIRED (a deferred constraint trigger
 *                                refuses a category without one at commit);
 *                                every other language is optional, so a
 *                                translation lands a row at a time.
 *  - `place_category_osm_tags` — the importer's mapping, one row per
 *                                OpenStreetMap tag, keyed by the TAG so one tag
 *                                files under exactly one category.
 *  - `place_category_events`   — the append-only audit every moderation write
 *                                records in its own transaction.
 *
 * ## What enforces `places.categories` now
 *
 * A row-level trigger on `places`, created by `0016`, refuses any key that is
 * not an ACTIVE category on an INSERT, or on an UPDATE that ADDS it; a key the
 * row already carried may stay, so a deprecated category never makes a place
 * uneditable. A junction table would have made it a foreign key — and meant
 * rewriting all ~13M places and every read that hydrates them; see
 * `docs/PLACE_DATA.md`.
 *
 * The functions and triggers are in `0016_goway_category_seed.sql` because
 * drizzle-kit does not model either; that file is the one place they are
 * defined, and `categoryTables.realdb.test.ts` holds them to their contract.
 *
 * ## Keys are immutable
 *
 * A key is the identity every place, filter, cache and SDK holds. A trigger
 * refuses any UPDATE of it and any DELETE of a key a place carries; a rename is
 * a new key, the old one `deprecated`, and `bun run categories:move` moving the
 * places across in batches.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import {
  CATEGORY_ICONS,
  CATEGORY_KEY_SQL_PATTERN,
  CATEGORY_STATUSES,
  LANGUAGE_TAG_SQL_PATTERN,
  MAX_CATEGORY_KEY_LENGTH,
  MAX_CATEGORY_LABEL_LENGTH,
  MAX_CATEGORY_POSITION,
  OSM_TAG_SQL_PATTERN,
  type PlaceRevisionChange,
} from '@goway/contracts';
import { closedSet, foreignServiceId } from './columns';
import { CATEGORY_EVENT_ACTIONS } from './valueSets';

/**
 * One category.
 *
 * `parent_key` is redundant with the key on purpose: the CHECK below holds it
 * to the key minus its last segment, and the foreign key then makes a child
 * without its parent unrepresentable — which the key alone cannot.
 */
export const placeCategories = pgTable(
  'place_categories',
  {
    key: text().primaryKey(),
    /** `null` for a root; otherwise the key minus its last segment, CHECKed. */
    parentKey: text(),
    /** A glyph key from `CATEGORY_ICONS`; every client has a drawing for each. */
    icon: text().notNull(),
    /** Order among siblings, ascending, ties by key. Seeded in tens. */
    position: integer().notNull().default(0),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * Table-level, not `.references()` on the column: a column-level
     * self-reference has been silently dropped from both the migration and
     * the snapshot (`~/Oxy/docs/postgres-and-drizzle.md`). `restrict`: a
     * parent with children is never deleted out from under them.
     */
    foreignKey({
      name: 'place_categories_parent_fk',
      columns: [table.parentKey],
      foreignColumns: [table.key],
    }).onDelete('restrict'),
    check(
      'place_categories_key_check',
      sql`${table.key} ~ '${sql.raw(CATEGORY_KEY_SQL_PATTERN)}' and char_length(${table.key}) <= ${sql.raw(String(MAX_CATEGORY_KEY_LENGTH))}`,
    ),
    check(
      'place_categories_parent_check',
      sql`${table.parentKey} is not distinct from nullif(regexp_replace(${table.key}, '[.]?[^.]+$', ''), '')`,
    ),
    closedSet('place_categories_icon_check', table.icon, CATEGORY_ICONS),
    closedSet('place_categories_status_check', table.status, CATEGORY_STATUSES),
    check(
      'place_categories_position_check',
      sql`${table.position} between 0 and ${sql.raw(String(MAX_CATEGORY_POSITION))}`,
    ),
    index('place_categories_parent_idx').on(table.parentKey),
  ],
);

/**
 * A category's label in one language.
 *
 * `language` is canonical BCP 47 — the `places_names` CHECK, from the same
 * contract pattern — so `es`, `ES` and `es_ES` cannot be three rows.
 * `cascade`: a label is part of its category.
 */
export const placeCategoryLabels = pgTable(
  'place_category_labels',
  {
    categoryKey: text()
      .notNull()
      .references(() => placeCategories.key, { onDelete: 'cascade' }),
    language: text().notNull(),
    label: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      name: 'place_category_labels_pkey',
      columns: [table.categoryKey, table.language],
    }),
    check(
      'place_category_labels_language_check',
      sql`${table.language} ~ '${sql.raw(LANGUAGE_TAG_SQL_PATTERN)}'`,
    ),
    /**
     * Trimmed, non-empty, NFC and bounded: one label is one string, so `Café`
     * composed and `Café` decomposed are never two spellings of one label.
     */
    check(
      'place_category_labels_label_check',
      sql`${table.label} <> '' and ${table.label} = btrim(${table.label}) and ${table.label} is nfc normalized and char_length(${table.label}) <= ${sql.raw(String(MAX_CATEGORY_LABEL_LENGTH))}`,
    ),
  ],
);

/**
 * One OpenStreetMap tag the importer files under a category: `amenity=cafe`,
 * or `shop=*` for the key's values nothing more specific claims.
 *
 * A table rather than a `text[]` on the category, for the primary key: one tag
 * names ONE category. Two categories claiming `amenity=cafe` would make the
 * import's answer depend on which row it happened to read last.
 */
export const placeCategoryOsmTags = pgTable(
  'place_category_osm_tags',
  {
    tag: text().primaryKey(),
    categoryKey: text()
      .notNull()
      .references(() => placeCategories.key, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'place_category_osm_tags_tag_check',
      sql`${table.tag} ~ '${sql.raw(OSM_TAG_SQL_PATTERN)}'`,
    ),
    index('place_category_osm_tags_category_idx').on(table.categoryKey),
  ],
);

/**
 * The audit of every moderation write to the taxonomy, one row per write, in
 * the write's own transaction — `place_revisions`' rule, in a table of its
 * own: that one is keyed by a place, CHECKs place actions and is published per
 * place, and a category is none of those.
 *
 * `changes` is the revision diff shape (`{ field, before?, after? }`):
 * `icon`, `position`, `status`, `osmTags`, `labels.<language>`. The seed in
 * `0016` is a migration, not a moderator's write, and records none.
 */
export const placeCategoryEvents = pgTable(
  'place_category_events',
  {
    id: generatedId(),
    /** `restrict`: the history of a category outlives any attempt to delete it. */
    categoryKey: text()
      .notNull()
      .references(() => placeCategories.key, { onDelete: 'restrict' }),
    action: text().notNull(),
    /** The account the write was made as. An Oxy id: no FK. */
    oxyAccountId: foreignServiceId().notNull(),
    /** The operator, when Oxy reported the person. An Oxy user id: no FK. */
    operatedByOxyUserId: foreignServiceId(),
    changes: jsonb().notNull().$type<PlaceRevisionChange[]>(),
    createdAt: createdAt(),
  },
  (table) => [
    closedSet('place_category_events_action_check', table.action, CATEGORY_EVENT_ACTIONS),
    check(
      'place_category_events_changes_array_check',
      sql`jsonb_typeof(${table.changes}) = 'array'`,
    ),
    index('place_category_events_category_created_idx').on(
      table.categoryKey,
      table.createdAt,
      table.id,
    ),
  ],
);
