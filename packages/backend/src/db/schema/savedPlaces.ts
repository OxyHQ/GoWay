/**
 * Saved place lists — a person's private lists of places (`docs/SAVED_PLACES.md`).
 *
 * ## Personal data, owned by an Oxy user, and nothing else
 *
 * `saved_place_lists.owner_oxy_user_id` is the person's Oxy user id: no foreign
 * key and no `users` table, because Oxy owns identity. Every read and write is
 * scoped by it in the SAME statement that touches the row, so there is no
 * code path that loads another person's list and checks afterwards.
 *
 * A list holds place ids and the owner's note. It holds no coordinate, no copy
 * of a place, and nothing about where the owner was — and it is never joined
 * into `place_revisions`, the public history or any place read.
 *
 * ## Why the items reference `places` with a real foreign key
 *
 * A place is this database's own table, unlike an Oxy id. `ON DELETE CASCADE`
 * lets an operator's hard delete of a place sweep the saves with it; a merge
 * moves them to the survivor (`savedPlacesRepository#moveSavedItemsToSurvivor`)
 * rather than leaving them on a retired id.
 *
 * Deleting a list deletes its items (`ON DELETE CASCADE`), and
 * `deleteSavedDataOf` removes everything a person owns in one statement.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import {
  MAX_SAVED_ITEM_NOTE_LENGTH,
  MAX_SAVED_LIST_NAME_LENGTH,
  SAVED_LIST_VISIBILITIES,
} from '@goway/contracts';
import { closedSet, foreignServiceId } from './columns';
import { places } from './places';

/** One saved list. */
export const savedPlaceLists = pgTable(
  'saved_place_lists',
  {
    id: generatedId(),
    /** The person. An Oxy user id: no foreign key. Never published. */
    ownerOxyUserId: foreignServiceId().notNull(),
    name: text().notNull(),
    /** `lower(btrim(name))`, GENERATED: what "the same name" means within one person's lists. */
    nameNormalized: text().generatedAlwaysAs(() => sql.raw('lower(btrim(name))')),
    visibility: text().notNull().default('private'),
    /** The list a one-tap save lands in. At most one per person. */
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('saved_place_lists_visibility_check', table.visibility, SAVED_LIST_VISIBILITIES),
    check(
      'saved_place_lists_name_check',
      sql`btrim(${table.name}) <> '' and char_length(${table.name}) <= ${sql.raw(String(MAX_SAVED_LIST_NAME_LENGTH))}`,
    ),
    /** One name per person, case-blind. */
    uniqueIndex('saved_place_lists_owner_name_key').on(table.ownerOxyUserId, table.nameNormalized),
    /** At most one default list per person: what makes a lazy create race-free. */
    uniqueIndex('saved_place_lists_owner_default_key')
      .on(table.ownerOxyUserId)
      .where(sql`${table.isDefault}`),
    /** The owner's lists, oldest first. */
    index('saved_place_lists_owner_created_idx').on(
      table.ownerOxyUserId,
      table.createdAt,
      table.id,
    ),
  ],
);

/** One place in a list. */
export const savedPlaceListItems = pgTable(
  'saved_place_list_items',
  {
    id: generatedId(),
    listId: text()
      .notNull()
      .references(() => savedPlaceLists.id, { onDelete: 'cascade' }),
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    /** The owner's own line about the place. */
    note: text(),
    /** An ordering key within the list: rises from first to last, gaps allowed. */
    position: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('saved_place_list_items_position_check', sql`${table.position} >= 0`),
    check(
      'saved_place_list_items_note_check',
      sql`${table.note} is null or (btrim(${table.note}) <> '' and char_length(${table.note}) <= ${sql.raw(String(MAX_SAVED_ITEM_NOTE_LENGTH))})`,
    ),
    /** A place is in a list once. */
    uniqueIndex('saved_place_list_items_list_place_key').on(table.listId, table.placeId),
    /** The list in the owner's order. */
    index('saved_place_list_items_list_position_idx').on(table.listId, table.position, table.id),
    /** Which lists hold a place, and the merge that moves them. */
    index('saved_place_list_items_place_idx').on(table.placeId),
  ],
);
