/**
 * Place revisions — the append-only history of every change to a place.
 *
 * Every write the API or moderation makes to a place records ONE revision in
 * the same transaction as the write: a place that changed has a revision saying
 * how, and a revision never describes a write that rolled back.
 *
 * ## What the public history publishes, and what it never does
 *
 * `GET /places/{placeId}/revisions` answers anybody, signed in or not, because
 * the facts it describes — a name, opening hours, a capability — are already
 * public on the place. It publishes WHAT changed, WHEN, and through which door
 * (`source`). It never publishes WHO:
 *
 *  - no account id and no human actor, for any action. A history of who edited
 *    which shop is a map of people's movements and affiliations, and the place
 *    itself never names its contributors either;
 *  - no action {@link PLACE_REVISION_VISIBILITY} classifies `moderation`.
 *    Claims are a business relationship GoWay shows only to the parties
 *    involved, reports and duplicate reviews are moderation state, and a public
 *    history that listed them would publish exactly what `GET /places/{placeId}`
 *    withholds.
 *
 * Operators read the full history, actors included, through
 * `GET /moderation/places/{placeId}/revisions`.
 */

import { z } from 'zod';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import { placeIdSchema } from './place';
import { instantSchema } from './time';

/**
 * What a revision records.
 *
 * One value per KIND of write, not per field: the field-level detail is in
 * {@link PlaceRevision.changes}. `place_merged` is written on the place that
 * was absorbed and `place_absorbed` on the one that survived, so each side's
 * history explains itself.
 */
export const PLACE_REVISION_ACTIONS = [
  'place_created',
  'place_updated',
  'capability_asserted',
  'capability_withdrawn',
  'claim_requested',
  'claim_approved',
  'claim_rejected',
  'claim_revoked',
  'place_merged',
  'place_absorbed',
  'duplicate_rejected',
  'report_resolved',
  'hours_exception_created',
  'hours_exception_replaced',
  'hours_exception_withdrawn',
  'media_added',
  'media_removed',
  'media_reordered',
  'media_hidden',
  'media_restored',
  'review_published',
  'review_updated',
  'review_withdrawn',
  'review_replied',
  'review_reply_withdrawn',
  'review_hidden',
  'review_restored',
] as const;
export type PlaceRevisionAction = (typeof PLACE_REVISION_ACTIONS)[number];

/** Who may read a revision of each action. */
export type PlaceRevisionVisibility = 'public' | 'moderation';

/**
 * Every action, classified.
 *
 * TOTAL over {@link PlaceRevisionAction} on purpose: an action added to the
 * tuple fails this package to compile until somebody decides whether the world
 * may read it. Defaulting a new action to public is the mistake this record
 * exists to make impossible.
 */
export const PLACE_REVISION_VISIBILITY = {
  place_created: 'public',
  place_updated: 'public',
  capability_asserted: 'public',
  capability_withdrawn: 'public',
  claim_requested: 'moderation',
  claim_approved: 'moderation',
  claim_rejected: 'moderation',
  claim_revoked: 'moderation',
  place_merged: 'public',
  place_absorbed: 'public',
  duplicate_rejected: 'moderation',
  report_resolved: 'moderation',
  // An exception is published on the place and by its own public list, so its
  // history is public too; the revision still never says who wrote it.
  hours_exception_created: 'public',
  hours_exception_replaced: 'public',
  hours_exception_withdrawn: 'public',
  // The gallery is published on the place, so what was added, removed or
  // reordered is history — never the file, never who. An operator hiding or
  // restoring an item is moderation state.
  media_added: 'public',
  media_removed: 'public',
  media_reordered: 'public',
  media_hidden: 'moderation',
  media_restored: 'moderation',
  // A review is the reviewer's statement, not a fact about the place: its
  // history is moderation's, and never holds its text.
  review_published: 'moderation',
  review_updated: 'moderation',
  review_withdrawn: 'moderation',
  review_replied: 'moderation',
  review_reply_withdrawn: 'moderation',
  review_hidden: 'moderation',
  review_restored: 'moderation',
} as const satisfies Record<PlaceRevisionAction, PlaceRevisionVisibility>;

/** The actions the public history lists. */
export const PUBLIC_PLACE_REVISION_ACTIONS: readonly PlaceRevisionAction[] = PLACE_REVISION_ACTIONS.filter(
  (action) => PLACE_REVISION_VISIBILITY[action] === 'public',
);

/**
 * Which door a write came through.
 *
 * - `api` — a signed-in caller through the public API: a contributor, or a
 *   business acting on its claim.
 * - `moderation` — a GoWay operator.
 */
export const PLACE_REVISION_SOURCES = ['api', 'moderation'] as const;
export type PlaceRevisionSource = (typeof PLACE_REVISION_SOURCES)[number];

/** A JSON value, as a revision records one side of a change. */
export const revisionValueSchema = z.json();
export type RevisionValue = z.infer<typeof revisionValueSchema>;

/**
 * One field that changed.
 *
 * `field` is a dotted path into the published `Place` shape — `name`,
 * `address.city`, `openingHours`, `timezone`, `names.es`,
 * `capabilities.payments.faircoin.accepted`, `hoursExceptions.<id>`,
 * `description`, `descriptions.es`, `media.<id>`, `logo`, `cover` — or, for a
 * moderation-only action, into the record it moved (`claims.<id>`,
 * `reports.<id>`, `duplicates.<id>`, `reviews.<id>`). `before` is absent when
 * the field had no value, `after` when the write cleared or withdrew it.
 *
 * Two things never appear in a change: an Oxy file id (a gallery item is
 * `{ kind, position, verification }`, and `logo`/`cover` name the gallery
 * item), and the words of a review or a reply (a review is
 * `{ rating, status, locale? }`). History is append-only, so a photo an
 * operator hid and a review its author withdrew must not live on in it.
 *
 * A capability's value is its assertion AT ONE TIER — `{ value, verification,
 * observedAt }` — because tiers coexist and a write touches exactly one. An
 * hours exception's is the exception itself, tier included and id excluded:
 * `{ startsOn, endsOn, closed, intervals, note?, verification, observedAt }`.
 */
export const placeRevisionChangeSchema = z.object({
  field: z.string().min(1),
  before: revisionValueSchema.optional(),
  after: revisionValueSchema.optional(),
});
export type PlaceRevisionChange = z.infer<typeof placeRevisionChangeSchema>;

/** One revision, as the public history publishes it: no account and no actor. */
export const placeRevisionSchema = z.object({
  id: z.string().min(1),
  placeId: placeIdSchema,
  action: z.enum(PLACE_REVISION_ACTIONS),
  source: z.enum(PLACE_REVISION_SOURCES),
  /** Every field the write changed. Empty when the write restated what was already there. */
  changes: z.array(placeRevisionChangeSchema),
  /** ISO 8601. */
  createdAt: instantSchema,
});
export type PlaceRevision = z.infer<typeof placeRevisionSchema>;

/** One revision as an operator reads it: the public shape plus who made it. */
export const moderationPlaceRevisionSchema = placeRevisionSchema.extend({
  /** The Oxy account the write was made AS — an organization, when a person acted as one. */
  oxyAccountId: z.string().min(1),
  /** The person who made it. Absent when Oxy did not report one. */
  operatedByOxyUserId: z.string().min(1).optional(),
});
export type ModerationPlaceRevision = z.infer<typeof moderationPlaceRevisionSchema>;

export const placeRevisionPageSchema = pageSchema(placeRevisionSchema);
export type PlaceRevisionPage = z.infer<typeof placeRevisionPageSchema>;

export const moderationPlaceRevisionPageSchema = pageSchema(moderationPlaceRevisionSchema);
export type ModerationPlaceRevisionPage = z.infer<typeof moderationPlaceRevisionPageSchema>;

/** The most revisions one page returns. */
export const MAX_REVISION_LIST_LIMIT = 100;
export const DEFAULT_REVISION_LIST_LIMIT = 25;

/** `GET /places/{placeId}/revisions` — newest first, keyset-paged by time. */
export const revisionListQuerySchema = z
  .object({
    limit: limitSchema(MAX_REVISION_LIST_LIMIT, DEFAULT_REVISION_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type RevisionListQuery = z.input<typeof revisionListQuerySchema>;
