/**
 * The category taxonomy: the read every catalog is built from, and the
 * moderation writes.
 *
 * Each write is ONE transaction with the `place_category_events` row that
 * records it, and locks the rows its rules read before reading them:
 *
 *  - a category is created under its parent locked `FOR SHARE`, and is
 *    deprecated with itself locked `FOR UPDATE` — so "an active category's
 *    parent is active" cannot be broken by a child created while its parent is
 *    being deprecated: one waits for the other and then sees it;
 *  - an OpenStreetMap tag names one category by primary key, so two writes
 *    claiming one tag cannot both commit, and the loser is a `conflict` naming
 *    the category that holds it.
 *
 * English is required by a deferred constraint trigger and the key's
 * immutability by another (`0016`); the checks here refuse the same writes
 * first, with an error that names the field.
 *
 * Nothing here invalidates a catalog: the route does, after the commit
 * (`categories/catalog`).
 */

import { and, asc, eq, inArray, max, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { constraintNameOf, isUniqueViolation } from '@oxy.so/db';
import {
  categoryParent,
  type CategoryIcon,
  type LocalizedLabels,
  type CategoryStatus,
  type ModerationCategory,
  type PlaceRevisionChange,
  type RevisionValue,
  type categoryCreateInputSchema,
  type categoryUpdateInputSchema,
} from '@goway/contracts';
import { ApiError } from '../../http/apiError';
import { changesBetween, type FieldValues, type RevisionAuthor } from '../places/revisions';
import type { Database, DatabaseOrTransaction } from '../postgres';
import { placeCategories, placeCategoryEvents, placeCategoryLabels, placeCategoryOsmTags } from '../schema';
import type { CategoryEventAction } from '../schema/valueSets';

export type CategoryCreate = z.output<typeof categoryCreateInputSchema>;
export type CategoryUpdate = z.output<typeof categoryUpdateInputSchema>;

/** The gap the seed leaves between siblings, and what a new last sibling is placed after. */
const POSITION_STEP = 10;

/**
 * One category with its labels and tags, in ONE statement: three reads could
 * straddle a moderator's commit and see a category without the labels it was
 * created with.
 */
const CATEGORY_COLUMNS = {
  key: placeCategories.key,
  parentKey: placeCategories.parentKey,
  icon: placeCategories.icon,
  position: placeCategories.position,
  status: placeCategories.status,
  labels: sql<Record<string, string> | null>`(
    select jsonb_object_agg(${placeCategoryLabels.language}, ${placeCategoryLabels.label})
    from ${placeCategoryLabels} where ${placeCategoryLabels.categoryKey} = ${placeCategories.key})`,
  osmTags: sql<string[] | null>`(
    select array_agg(${placeCategoryOsmTags.tag} order by ${placeCategoryOsmTags.tag})
    from ${placeCategoryOsmTags} where ${placeCategoryOsmTags.categoryKey} = ${placeCategories.key})`,
  createdAt: placeCategories.createdAt,
  updatedAt: placeCategories.updatedAt,
} as const;

type CategoryRow = {
  key: string;
  parentKey: string | null;
  icon: string;
  position: number;
  status: string;
  labels: Record<string, string> | null;
  osmTags: string[] | null;
  createdAt: Date;
  updatedAt: Date;
};

/** One row as a moderator reads it. `label` is English; a catalog resolves it per request. */
function toCategory(row: CategoryRow): ModerationCategory {
  // English is required by a constraint trigger, so a row without one is a
  // database that skipped its migrations: fail loudly rather than label blankly.
  if (row.labels?.en === undefined) throw new Error(`place category ${row.key} has no English label`);
  return {
    key: row.key,
    parent: row.parentKey,
    icon: row.icon,
    status: row.status as CategoryStatus,
    label: row.labels.en,
    labels: row.labels as LocalizedLabels,
    position: row.position,
    osmTags: row.osmTags ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The whole taxonomy, deprecated categories included, depth-first with
 * siblings by position and then key — the order a browse menu reads in.
 */
export async function loadCategories(db: DatabaseOrTransaction): Promise<ModerationCategory[]> {
  const rows = await db
    .select(CATEGORY_COLUMNS)
    .from(placeCategories)
    .orderBy(asc(placeCategories.position), asc(placeCategories.key));
  const childrenOf = new Map<string | null, CategoryRow[]>();
  for (const row of rows) childrenOf.set(row.parentKey, [...(childrenOf.get(row.parentKey) ?? []), row]);
  const ordered: ModerationCategory[] = [];
  const visit = (parent: string | null) => {
    for (const row of childrenOf.get(parent) ?? []) {
      ordered.push(toCategory(row));
      visit(row.key);
    }
  };
  visit(null);
  return ordered;
}

/** One category as a moderator reads it, or `undefined`. */
async function loadCategory(db: DatabaseOrTransaction, key: string): Promise<ModerationCategory | undefined> {
  const [row] = await db.select(CATEGORY_COLUMNS).from(placeCategories).where(eq(placeCategories.key, key));
  return row && toCategory(row);
}

/**
 * A category's status, locked: `FOR UPDATE` by the write that changes it,
 * `FOR SHARE` by one whose rule reads it (a child's parent).
 */
async function lockCategory(
  tx: DatabaseOrTransaction,
  key: string,
  strength: 'update' | 'share',
): Promise<{ status: string } | undefined> {
  const [row] = await tx
    .select({ status: placeCategories.status })
    .from(placeCategories)
    .where(eq(placeCategories.key, key))
    .for(strength);
  return row;
}

/** The fields an event diffs, for one category. */
function fieldValues(category: {
  icon: string;
  position: number;
  status: string;
  osmTags: readonly string[];
  labels?: Readonly<Record<string, string>>;
}): FieldValues {
  const values: Record<string, RevisionValue | undefined> = {
    icon: category.icon,
    position: category.position,
    status: category.status,
    osmTags: [...category.osmTags].sort(),
  };
  for (const [language, label] of Object.entries(category.labels ?? {})) values[`labels.${language}`] = label;
  return values;
}

async function recordEvent(
  tx: DatabaseOrTransaction,
  event: { categoryKey: string; action: CategoryEventAction; author: RevisionAuthor; changes: readonly PlaceRevisionChange[] },
): Promise<void> {
  await tx.insert(placeCategoryEvents).values({
    categoryKey: event.categoryKey,
    action: event.action,
    oxyAccountId: event.author.oxyAccountId,
    operatedByOxyUserId: event.author.operatedByOxyUserId,
    changes: [...event.changes],
  });
}

/**
 * Refuse tags another category already maps, naming the first. Read under the
 * write's locks; the tag's primary key is what makes it hold against a write
 * committing in between ({@link claimedTagConflict}).
 */
async function assertTagsUnclaimed(tx: DatabaseOrTransaction, key: string, tags: readonly string[]): Promise<void> {
  if (tags.length === 0) return;
  const [claimed] = await tx
    .select({ tag: placeCategoryOsmTags.tag, categoryKey: placeCategoryOsmTags.categoryKey })
    .from(placeCategoryOsmTags)
    .where(and(inArray(placeCategoryOsmTags.tag, [...tags]), ne(placeCategoryOsmTags.categoryKey, key)))
    .limit(1);
  if (claimed) {
    throw new ApiError('conflict', 'That OpenStreetMap tag already files under another category.', {
      tag: claimed.tag,
      category: claimed.categoryKey,
    });
  }
}

/** The `conflict` for a tag or key a concurrent write took first. `null` for any other error. */
function claimedTagConflict(error: unknown): ApiError | null {
  if (!isUniqueViolation(error)) return null;
  return constraintNameOf(error) === 'place_category_osm_tags_pkey'
    ? new ApiError('conflict', 'That OpenStreetMap tag already files under another category.')
    : new ApiError('conflict', 'A category with that key already exists.');
}

/**
 * A new category. `conflict` when the key exists, the parent is deprecated or
 * a tag is another category's; `validation_failed` naming `key` when the parent
 * does not exist.
 */
export async function createCategory(
  db: Database,
  input: CategoryCreate,
  author: RevisionAuthor,
): Promise<ModerationCategory> {
  try {
    return await db.transaction(async (tx) => {
      const parentKey = categoryParent(input.key);
      if (parentKey !== null) {
        const parent = await lockCategory(tx, parentKey, 'share');
        if (!parent) {
          throw new ApiError('validation_failed', 'The request body is not acceptable: key names no parent category.', {
            field: 'key',
            issue: 'unknown_parent',
            issueCount: 1,
          });
        }
        if (parent.status !== 'active') {
          throw new ApiError('conflict', 'A category cannot be added under a deprecated one.', { parent: parentKey });
        }
      }
      if (await lockCategory(tx, input.key, 'share')) {
        throw new ApiError('conflict', 'A category with that key already exists.', { key: input.key });
      }
      await assertTagsUnclaimed(tx, input.key, input.osmTags);

      const position = input.position ?? (await nextSiblingPosition(tx, parentKey));
      await tx.insert(placeCategories).values({ key: input.key, parentKey, icon: input.icon, position });
      await tx
        .insert(placeCategoryLabels)
        .values(Object.entries(input.labels).map(([language, label]) => ({ categoryKey: input.key, language, label })));
      if (input.osmTags.length > 0) {
        await tx.insert(placeCategoryOsmTags).values(input.osmTags.map((tag) => ({ tag, categoryKey: input.key })));
      }

      const created = await loadCategory(tx, input.key);
      if (!created) throw new ApiError('internal_error', 'The category could not be created.');
      await recordEvent(tx, {
        categoryKey: input.key,
        action: 'created',
        author,
        changes: changesBetween({}, fieldValues(created)),
      });
      return created;
    });
  } catch (error) {
    throw claimedTagConflict(error) ?? error;
  }
}

/** After the last of a parent's children, or 0 for the first. */
async function nextSiblingPosition(tx: DatabaseOrTransaction, parentKey: string | null): Promise<number> {
  const [last] = await tx
    .select({ position: max(placeCategories.position) })
    .from(placeCategories)
    .where(parentKey === null ? sql`${placeCategories.parentKey} is null` : eq(placeCategories.parentKey, parentKey));
  return last?.position === null || last?.position === undefined ? 0 : last.position + POSITION_STEP;
}

/**
 * Change a category's glyph, position, mapping or status. `null` when no
 * category has the key; `conflict` when deprecating one with an active child,
 * reactivating one under a deprecated parent, or mapping a tag another
 * category holds.
 */
export async function updateCategory(
  db: Database,
  key: string,
  input: CategoryUpdate,
  author: RevisionAuthor,
): Promise<ModerationCategory | null> {
  try {
    return await db.transaction(async (tx) => {
      if (!(await lockCategory(tx, key, 'update'))) return null;
      const before = await loadCategory(tx, key);
      if (!before) return null;

      if (input.status === 'deprecated' && before.status !== 'deprecated') {
        const [child] = await tx
          .select({ key: placeCategories.key })
          .from(placeCategories)
          .where(and(eq(placeCategories.parentKey, key), eq(placeCategories.status, 'active')))
          .limit(1);
        if (child) {
          throw new ApiError('conflict', 'Deprecate every active category below this one first.', { child: child.key });
        }
      }
      if (input.status === 'active' && before.parent !== null) {
        const parent = await lockCategory(tx, before.parent, 'share');
        if (parent?.status !== 'active') {
          throw new ApiError('conflict', 'A category under a deprecated one cannot be reactivated.', {
            parent: before.parent,
          });
        }
      }

      const columns: { icon?: CategoryIcon; position?: number; status?: CategoryStatus } = {};
      if (input.icon !== undefined) columns.icon = input.icon;
      if (input.position !== undefined) columns.position = input.position;
      if (input.status !== undefined) columns.status = input.status;
      await tx
        .update(placeCategories)
        .set({ ...columns, updatedAt: new Date() })
        .where(eq(placeCategories.key, key));

      if (input.osmTags !== undefined) {
        await assertTagsUnclaimed(tx, key, input.osmTags);
        await tx.delete(placeCategoryOsmTags).where(eq(placeCategoryOsmTags.categoryKey, key));
        if (input.osmTags.length > 0) {
          await tx.insert(placeCategoryOsmTags).values(input.osmTags.map((tag) => ({ tag, categoryKey: key })));
        }
      }

      const after = await loadCategory(tx, key);
      if (!after) return null;
      await recordEvent(tx, {
        categoryKey: key,
        action: 'updated',
        author,
        changes: changesBetween(fieldValues({ ...before, labels: {} }), fieldValues({ ...after, labels: {} })),
      });
      return after;
    });
  } catch (error) {
    throw claimedTagConflict(error) ?? error;
  }
}

/** Set one label. `null` when no category has the key. */
export async function setCategoryLabel(
  db: Database,
  key: string,
  language: string,
  label: string,
  author: RevisionAuthor,
): Promise<ModerationCategory | null> {
  return db.transaction(async (tx) => {
    if (!(await lockCategory(tx, key, 'update'))) return null;
    const [previous] = await tx
      .select({ label: placeCategoryLabels.label })
      .from(placeCategoryLabels)
      .where(and(eq(placeCategoryLabels.categoryKey, key), eq(placeCategoryLabels.language, language)));
    await tx
      .insert(placeCategoryLabels)
      .values({ categoryKey: key, language, label })
      .onConflictDoUpdate({
        target: [placeCategoryLabels.categoryKey, placeCategoryLabels.language],
        set: { label, updatedAt: new Date() },
      });
    await tx.update(placeCategories).set({ updatedAt: new Date() }).where(eq(placeCategories.key, key));
    await recordEvent(tx, {
      categoryKey: key,
      action: 'label_set',
      author,
      changes: changesBetween({ [`labels.${language}`]: previous?.label }, { [`labels.${language}`]: label }),
    });
    return (await loadCategory(tx, key)) ?? null;
  });
}

/**
 * Remove one label. `null` when no category has the key, `false` when it has
 * no label in that language; `conflict` for English, the fallback every other
 * language falls back to.
 */
export async function removeCategoryLabel(
  db: Database,
  key: string,
  language: string,
  author: RevisionAuthor,
): Promise<boolean | null> {
  if (language === 'en') {
    throw new ApiError('conflict', 'English is every category\'s fallback label and cannot be removed.');
  }
  return db.transaction(async (tx) => {
    if (!(await lockCategory(tx, key, 'update'))) return null;
    const [removed] = await tx
      .delete(placeCategoryLabels)
      .where(and(eq(placeCategoryLabels.categoryKey, key), eq(placeCategoryLabels.language, language)))
      .returning({ label: placeCategoryLabels.label });
    if (!removed) return false;
    await tx.update(placeCategories).set({ updatedAt: new Date() }).where(eq(placeCategories.key, key));
    await recordEvent(tx, {
      categoryKey: key,
      action: 'label_removed',
      author,
      changes: changesBetween({ [`labels.${language}`]: removed.label }, {}),
    });
    return true;
  });
}
