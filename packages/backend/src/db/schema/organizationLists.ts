import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { places } from './places';

export const organizationLists = pgTable(
  'organization_lists',
  {
    id: generatedId(),
    // External Oxy organization reference: no FK or copied membership.
    oxyAccountId: text().notNull(),
    title: text().notNull(),
    description: text().notNull().default(''),
    revision: integer().notNull().default(0),
    // Audit references only; Oxy owns identities.
    updatedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('organization_lists_account_idx').on(t.oxyAccountId, t.id),
    check('organization_lists_title_check', sql`length(btrim(${t.title})) between 1 and 160`),
    check('organization_lists_revision_check', sql`${t.revision} >= 0`),
  ],
);
export const organizationListEntries = pgTable(
  'organization_list_entries',
  {
    id: generatedId(),
    listId: text()
      .notNull()
      .references(() => organizationLists.id, { onDelete: 'cascade' }),
    placeId: text()
      .notNull()
      .references(() => places.id),
    activity: text().notNull(),
    information: text().notNull().default(''),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    completedAt: timestamp({ withTimezone: true }),
    position: integer().notNull(),
    // External audit identity, not a foreign key.
    updatedByOxyUserId: text().notNull(),
  },
  (t) => [
    index('organization_list_entries_order_idx').on(t.listId, t.position, t.id),
    check('organization_list_entries_schedule_check', sql`${t.endsAt} > ${t.startsAt}`),
    check('organization_list_entries_position_check', sql`${t.position} >= 0`),
    check(
      'organization_list_entries_activity_check',
      sql`length(btrim(${t.activity})) between 1 and 160`,
    ),
  ],
);
