/**
 * Saved place lists — a person's own lists of places ("Saved", "Want to go").
 *
 * ## A list is personal data, owned by the Oxy user
 *
 * A list belongs to the PERSON behind the session (`ownerOxyUserId` in the
 * database, never published: the only reader of a list is its owner, so no
 * response names anybody). Nothing is public and nothing is shared yet:
 * {@link SAVED_LIST_VISIBILITIES} has the single member `private`, and widening
 * it is a deliberate, reviewed change to this tuple rather than a flag.
 *
 * A list holds PLACE IDs and the owner's own note about each — never a copy of
 * a place, never a coordinate, never where the owner was when they saved it.
 * Names, photos and hours are read from the place itself (`GET /places?ids=`),
 * so a saved place is always as fresh as the place. Saving writes no place
 * revision and appears in no public history: a list is the owner's, the place
 * is everyone's.
 *
 * ## Limits
 *
 * {@link MAX_SAVED_LISTS_PER_USER} lists per person and
 * {@link MAX_SAVED_LIST_ITEMS} places per list; reaching one is a `conflict`
 * whose `details.reason` is a {@link SAVED_LIST_CONFLICT_REASONS} member.
 * A place appears at most once per list; adding it again answers the existing
 * item. Two lists of one person never share a name (compared case-blind).
 *
 * ## The default list
 *
 * "Saved" is the list a one-tap save lands in. It is created lazily by
 * `PUT /lists/default` on the first save, and the server — not the client —
 * guarantees there is at most one, so two devices saving at once cannot create
 * two. It is an ordinary list afterwards: it may be renamed or deleted, and
 * the next `PUT /lists/default` makes a new one.
 *
 * ## Order
 *
 * Items are served in the owner's order. `position` is an ordering key, not an
 * index: it rises from the first item to the last, but removing an item leaves
 * a gap, and only a reorder renumbers.
 */

import { z } from 'zod';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import { placeIdSchema } from './place';
import { instantSchema } from './time';

/**
 * Who can see a list. `private` only: the owner. Not `shared` or `public`
 * until sharing is designed — see the module note.
 */
export const SAVED_LIST_VISIBILITIES = ['private'] as const;
export type SavedListVisibility = (typeof SAVED_LIST_VISIBILITIES)[number];

/** Lists one person may hold. */
export const MAX_SAVED_LISTS_PER_USER = 100;
/** Places one list may hold. */
export const MAX_SAVED_LIST_ITEMS = 500;
export const MAX_SAVED_LIST_NAME_LENGTH = 80;
export const MAX_SAVED_ITEM_NOTE_LENGTH = 500;
/** How many places' ids a list summary carries for its cover. */
export const SAVED_LIST_COVER_PLACES = 4;
/** The most places one `GET /saved-places` lookup names. */
export const MAX_SAVED_PLACES_LOOKUP = 50;

export const MAX_SAVED_LIST_PAGE_LIMIT = 100;
export const DEFAULT_SAVED_LIST_PAGE_LIMIT = 50;
export const MAX_SAVED_ITEM_PAGE_LIMIT = 100;
export const DEFAULT_SAVED_ITEM_PAGE_LIMIT = 50;

/** The `details` key of a saved-list `conflict`, holding one of {@link SAVED_LIST_CONFLICT_REASONS}. */
export const SAVED_LIST_CONFLICT_DETAIL = 'reason';

/**
 * Why a saved-list write answered `conflict`.
 *
 * - `name_taken` — the person already has a list of that name.
 * - `list_limit_reached` — they hold {@link MAX_SAVED_LISTS_PER_USER} lists.
 * - `item_limit_reached` — the list holds {@link MAX_SAVED_LIST_ITEMS} places.
 */
export const SAVED_LIST_CONFLICT_REASONS = [
  'name_taken',
  'list_limit_reached',
  'item_limit_reached',
] as const;
export type SavedListConflictReason = (typeof SAVED_LIST_CONFLICT_REASONS)[number];

const idSchema = z.string().min(1).max(128);

const listNameSchema = z.string().trim().min(1).max(MAX_SAVED_LIST_NAME_LENGTH);
const itemNoteSchema = z.string().trim().min(1).max(MAX_SAVED_ITEM_NOTE_LENGTH);

/** A list as its owner reads it. */
export const savedListSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  visibility: z.enum(SAVED_LIST_VISIBILITIES),
  /** Whether this is the list a one-tap save lands in. */
  isDefault: z.boolean(),
  /** How many places it holds. */
  itemCount: z.number().int().min(0).max(MAX_SAVED_LIST_ITEMS),
  /** The first places in the list, in order, for a cover. Read each place with `GET /places?ids=`. */
  coverPlaceIds: z.array(placeIdSchema).max(SAVED_LIST_COVER_PLACES),
  createdAt: instantSchema,
  /** When the list was last renamed or its places changed. */
  updatedAt: instantSchema,
});
export type SavedList = z.infer<typeof savedListSchema>;

export const savedListPageSchema = pageSchema(savedListSchema);
export type SavedListPage = z.infer<typeof savedListPageSchema>;

/** One place in a list, with the owner's note about it. */
export const savedListItemSchema = z.object({
  id: idSchema,
  listId: idSchema,
  /** A GoWay Place ID. Read the place itself for its name, photos and hours. */
  placeId: placeIdSchema,
  /** The owner's own line about the place. */
  note: z.string().optional(),
  /** Where it stands in the list: an ordering key, not an index. */
  position: z.number().int().min(0),
  addedAt: instantSchema,
});
export type SavedListItem = z.infer<typeof savedListItemSchema>;

export const savedListItemPageSchema = pageSchema(savedListItemSchema);
export type SavedListItemPage = z.infer<typeof savedListItemPageSchema>;

/** The body of `POST /lists`. */
export const savedListInputSchema = z.object({ name: listNameSchema }).strict();
export type SavedListInput = z.input<typeof savedListInputSchema>;

/**
 * The body of `PUT /lists/default`: the name the default list is created with
 * when the person has none. Ignored when they already have one — the client
 * localizes it, the server never renames an existing list.
 */
export const savedDefaultListInputSchema = z.object({ name: listNameSchema }).strict();
export type SavedDefaultListInput = z.input<typeof savedDefaultListInputSchema>;

/** The body of `PATCH /lists/{listId}`: rename. */
export const savedListUpdateInputSchema = z.object({ name: listNameSchema }).strict();
export type SavedListUpdateInput = z.input<typeof savedListUpdateInputSchema>;

/** The body of `POST /lists/{listId}/items`. */
export const savedListItemInputSchema = z
  .object({
    placeId: placeIdSchema,
    note: itemNoteSchema.optional(),
  })
  .strict();
export type SavedListItemInput = z.input<typeof savedListItemInputSchema>;

/**
 * The body of `PATCH /lists/{listId}/items/{itemId}`: set the note, or clear
 * it with `null`. The note is always named, so an empty body is refused rather
 * than read as "no change".
 */
export const savedListItemUpdateInputSchema = z
  .object({ note: itemNoteSchema.nullable() })
  .strict();
export type SavedListItemUpdateInput = z.input<typeof savedListItemUpdateInputSchema>;

/**
 * The body of `PUT /lists/{listId}/items/order`: item ids in their new order.
 *
 * The named items move to the front in this order; the list's other items keep
 * their relative order after them, so a caller holding only some of the pages
 * cannot lose the rest. An id that is not an item of this list is
 * `validation_failed`.
 */
export const savedListItemOrderInputSchema = z
  .object({
    itemIds: z
      .array(idSchema)
      .min(1)
      .max(MAX_SAVED_LIST_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length, 'each item may be named once'),
  })
  .strict();
export type SavedListItemOrderInput = z.input<typeof savedListItemOrderInputSchema>;

/** `GET /lists` — the caller's lists, oldest first. */
export const savedListQuerySchema = z
  .object({
    limit: limitSchema(MAX_SAVED_LIST_PAGE_LIMIT, DEFAULT_SAVED_LIST_PAGE_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type SavedListQuery = z.input<typeof savedListQuerySchema>;

/** `GET /lists/{listId}/items` — the list's places, in the owner's order. */
export const savedListItemQuerySchema = z
  .object({
    limit: limitSchema(MAX_SAVED_ITEM_PAGE_LIMIT, DEFAULT_SAVED_ITEM_PAGE_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type SavedListItemQuery = z.input<typeof savedListItemQuerySchema>;

/** `GET /saved-places` — which of the caller's lists hold these places. */
export const savedPlacesQuerySchema = z
  .object({
    /** Comma-joined in the query. Repeats collapse. At most {@link MAX_SAVED_PLACES_LOOKUP}. */
    placeIds: z.array(placeIdSchema).min(1).max(MAX_SAVED_PLACES_LOOKUP),
  })
  .strict();
export type SavedPlacesQuery = z.input<typeof savedPlacesQuerySchema>;

/** One of the caller's lists that holds a place, and the item that holds it there. */
export const savedPlaceHoldSchema = z.object({ listId: idSchema, itemId: idSchema });
export type SavedPlaceHold = z.infer<typeof savedPlaceHoldSchema>;

/** A place the caller has saved, and where. */
export const savedPlaceSchema = z.object({
  placeId: placeIdSchema,
  /** Every list of the caller's that holds it, oldest list first. */
  lists: z.array(savedPlaceHoldSchema).min(1).max(MAX_SAVED_LISTS_PER_USER),
});
export type SavedPlace = z.infer<typeof savedPlaceSchema>;

/**
 * The answer to `GET /saved-places`: the asked-for places the caller has saved
 * (an unsaved place is simply absent), in the order they were asked for.
 *
 * Not a page: the request bounds it, so there is no next one and no cursor —
 * the same shape as `GET /places?ids=`.
 */
export const savedPlacesSchema = z.object({ items: z.array(savedPlaceSchema) });
export type SavedPlaces = z.infer<typeof savedPlacesSchema>;
