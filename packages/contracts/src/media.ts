/**
 * Place media — the photos, logos, covers and menus a place's gallery holds.
 *
 * ## The bytes are Oxy's, and GoWay never touches them
 *
 * A media item is a REFERENCE to an Oxy file: the client uploads the image to
 * Oxy itself (`oxy.assets.upload(file, { visibility: 'public' })`), then hands
 * GoWay the file id. GoWay checks with Oxy — on the caller's own session — that
 * the file exists, is an image, is public and belongs to the caller, links it
 * to the place (`app: 'goway'`, `entityType: 'place'`) so Oxy keeps it alive,
 * and stores the id. A client renders it from Oxy's CDN
 * (`oxy.assets.publicUrl(fileId, variant)`). GoWay never fetches, proxies,
 * resizes or stores an image, and an Oxy outage is a `503`, never a guess.
 *
 * ## What a gallery item says, and what it never says
 *
 * Who contributed an item is recorded and never published: a place never names
 * its contributors, and a gallery that did would be a map of where people have
 * stood. An item carries the verification tier its contributor's standing
 * earned — `business_asserted` for whoever acts for an approved claim,
 * `community_reported` otherwise — the same tiers a capability carries.
 * Imported media (Wikimedia Commons, say) is `external_source` and carries its
 * `attribution` and `license`, which a client must display.
 */

import { z } from 'zod';
import { CAPABILITY_VERIFICATIONS } from './capability-registry';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import { oxyFileIdSchema, placeIdSchema } from './place';
import { instantSchema } from './time';

/**
 * What a media item shows. Closed: a kind outside it is `validation_failed`.
 *
 * `logo` and `cover` are the business's own imagery; on a claimed place only
 * whoever acts for an approved claim may add them, exactly as only they may
 * edit the place. Every other kind is open to any signed-in contributor.
 */
export const PLACE_MEDIA_KINDS = ['photo', 'logo', 'cover', 'menu', 'interior', 'exterior'] as const;
export type PlaceMediaKind = (typeof PLACE_MEDIA_KINDS)[number];

/** The kinds only a claimant may add to a claimed place. */
export const BUSINESS_MEDIA_KINDS = ['logo', 'cover'] as const satisfies readonly PlaceMediaKind[];

/**
 * Where an item stands.
 *
 * - `visible` — in the public gallery.
 * - `hidden` — withdrawn by a GoWay operator; reversible by one.
 * - `removed` — withdrawn by its contributor or the business. Terminal: the
 *   Oxy link is dropped and the item is never published again.
 */
export const PLACE_MEDIA_STATES = ['visible', 'hidden', 'removed'] as const;
export type PlaceMediaState = (typeof PLACE_MEDIA_STATES)[number];

/** The states an operator may move an item between. `removed` is its contributor's or the business's act. */
export const MODERATED_PLACE_MEDIA_STATES = ['visible', 'hidden'] as const satisfies readonly PlaceMediaState[];
export type ModeratedPlaceMediaState = (typeof MODERATED_PLACE_MEDIA_STATES)[number];

/**
 * The image types a gallery accepts — what every client can render. Checked
 * against Oxy's own record of the file, never against the caller's word.
 */
export const PLACE_MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'] as const;

/** The longest caption, in characters. */
export const MAX_MEDIA_CAPTION_LENGTH = 280;

/** A media item as the public gallery publishes it. */
export const placeMediaSchema = z.object({
  id: z.string().min(1),
  placeId: placeIdSchema,
  /** The Oxy file. Render with `oxy.assets.publicUrl(fileId, variant)`. */
  fileId: oxyFileIdSchema,
  kind: z.enum(PLACE_MEDIA_KINDS),
  /** How much the contributor's standing vouches for it, as for a capability. */
  verification: z.enum(CAPABILITY_VERIFICATIONS),
  /** The gallery order, ascending. The business sets it. */
  position: z.number().int().min(0),
  caption: z.string().optional(),
  /** Who made it, for imported media — display it beside the image. */
  attribution: z.string().optional(),
  /** Its licence, for imported media (an SPDX id or the source's own wording). */
  license: z.string().optional(),
  /** Intrinsic size in pixels, when Oxy knows it. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  createdAt: instantSchema,
});
export type PlaceMedia = z.infer<typeof placeMediaSchema>;

export const placeMediaPageSchema = pageSchema(placeMediaSchema);
export type PlaceMediaPage = z.infer<typeof placeMediaPageSchema>;

/** A media item as an operator reads it: the public shape plus its state and contributor. */
export const moderationPlaceMediaSchema = placeMediaSchema.extend({
  state: z.enum(PLACE_MEDIA_STATES),
  /** The Oxy account it was added as. Never published. */
  contributorOxyAccountId: z.string().min(1).optional(),
});
export type ModerationPlaceMedia = z.infer<typeof moderationPlaceMediaSchema>;

export const moderationPlaceMediaPageSchema = pageSchema(moderationPlaceMediaSchema);
export type ModerationPlaceMediaPage = z.infer<typeof moderationPlaceMediaPageSchema>;

/**
 * The body of `POST /places/{placeId}/media`.
 *
 * The file must already be in Oxy, uploaded by the caller as `public`. There is
 * no verification, attribution, licence or position here: the tier is derived
 * from who is asking, a contributed image is the contributor's own, and a new
 * item joins the end of the gallery.
 */
export const placeMediaInputSchema = z
  .object({
    fileId: oxyFileIdSchema,
    kind: z.enum(PLACE_MEDIA_KINDS),
    caption: z.string().trim().min(1).max(MAX_MEDIA_CAPTION_LENGTH).optional(),
  })
  .strict();
export type PlaceMediaInput = z.input<typeof placeMediaInputSchema>;

/** The most items one reorder may name. */
export const MAX_MEDIA_ORDER_LENGTH = 200;

/**
 * The body of `PUT /places/{placeId}/media/order`.
 *
 * The named visible items move to the front of the gallery in this order; the
 * rest keep their relative order after them. An id that is not a visible item
 * of this place is `validation_failed`.
 */
export const placeMediaOrderInputSchema = z
  .object({
    mediaIds: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(MAX_MEDIA_ORDER_LENGTH)
      .refine((ids) => new Set(ids).size === ids.length, 'each item may be named once'),
  })
  .strict();
export type PlaceMediaOrderInput = z.input<typeof placeMediaOrderInputSchema>;

/** The body of `PATCH /moderation/places/{placeId}/media/{mediaId}`. */
export const moderationMediaInputSchema = z.object({ state: z.enum(MODERATED_PLACE_MEDIA_STATES) }).strict();
export type ModerationMediaInput = z.input<typeof moderationMediaInputSchema>;

/** The most items one page returns. */
export const MAX_MEDIA_LIST_LIMIT = 100;
export const DEFAULT_MEDIA_LIST_LIMIT = 30;

/** `GET /places/{placeId}/media` — the visible gallery, in its order. */
export const mediaListQuerySchema = z
  .object({
    /** Only items of these kinds. Absent: every kind. */
    kinds: z.array(z.enum(PLACE_MEDIA_KINDS)).max(PLACE_MEDIA_KINDS.length).optional(),
    limit: limitSchema(MAX_MEDIA_LIST_LIMIT, DEFAULT_MEDIA_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type MediaListQuery = z.input<typeof mediaListQuerySchema>;

/** `GET /moderation/places/{placeId}/media` — every item in one state, or in every state. */
export const moderationMediaListQuerySchema = z
  .object({
    state: z.enum(PLACE_MEDIA_STATES).optional(),
    limit: limitSchema(MAX_MEDIA_LIST_LIMIT, DEFAULT_MEDIA_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type ModerationMediaListQuery = z.input<typeof moderationMediaListQuerySchema>;
