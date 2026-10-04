# Place media, reviews and descriptions

*Design note for Phase 2b of the place-data plan. The contracts are
`packages/contracts/src/media.ts`, `review.ts` and the profile fields in
`place.ts`; the tables are in `packages/backend/src/db/schema/places.ts`
(`place_media`, `place_reviews`, `place_review_aggregates`,
`places_descriptions`); the Oxy boundary is `packages/backend/src/oxy/placeFiles.ts`.*

A place now carries what people made of it — photos, a description, reviews —
beside the facts GoWay reconciles. Each of these is somebody's statement, so
each keeps who made it (privately), how much their standing vouches for it, and
a moderation state an operator can reverse.

## 1. A gallery item is an Oxy file

### GoWay never touches an image

The client uploads the image to Oxy with the Oxy SDK it already uses
(`oxy.assets.upload(file, { visibility: 'public' })`) and hands GoWay the file
id. A client renders an item from Oxy's CDN (`oxy.assets.publicUrl(fileId,
variant)`, through Bloom's image resolver in the app). GoWay stores the id and
nothing else: no bytes, no proxy, no thumbnail, no fetch.

### What GoWay checks, and how

`POST /places/{placeId}/media` asks Oxy three questions on a client built for
the request with the **caller's own bearer** and disposed after it — the
`oxy/accountRoles` shape, because what is being established is about this
caller:

1. `GET /assets/:id` — the file exists, is `active`, is one of
   `PLACE_MEDIA_MIME_TYPES`, and its `ownerUserId` is the session's account or
   the person operating it. Oxy answers this route for any signed-in caller and
   checks no ownership itself, so **the owner comparison is GoWay's and is the
   whole of the check**: without it anybody could publish a file id they saw.
2. `POST /assets/batch-access` — the file's `visibility` is `public`. The
   record above does not carry visibility.
3. `POST /assets/:id/links` with `{ app: 'goway', entityType: 'place',
   entityId: placeId }` and `visibility: 'public'` restated. Oxy's link call
   SETS the visibility it is given, and infers `private` for a non-avatar entity
   when given none — so restating what (2) established is what keeps linking
   from changing it.

A missing, foreign, trashed, non-image or non-public file is refused
(`validation_failed` or `forbidden`, naming `fileId`, never quoting Oxy's
record). A `401` from Oxy is `unauthorized`. **Anything else fails closed with
`503`** and records nothing. The row is written after the link; if writing it
fails the link is dropped again. A file already live in the gallery is a `409`
naming the item, and its link is left alone.

The app re-encodes a picked photo before uploading it
(`features/explore/placePhoto.ts`): a phone photo's EXIF block carries where it
was taken, and a gallery is public.

### Unlinking, and why a merge does not re-link

Withdrawing an item drops its Oxy link after the withdrawal commits, best
effort — a link Oxy still holds costs the owner nothing but the file staying
alive. `place_media.oxy_link_place_id` remembers which place id the link
names, because a merge MOVES the item but leaves its link: re-linking would
call Oxy's link route, which rewrites the file's visibility, on an operator's
session, on a file that is somebody else's. The absorbed id is a permanent
alias of the survivor, so the stale entity id misleads nobody.

### Who may do what

| act | who |
|---|---|
| add a `photo`, `menu`, `interior`, `exterior` | any signed-in person, at the tier their standing earns |
| add a `logo` or `cover` | anybody on an unclaimed place; on a claimed place, whoever acts for an approved claim |
| withdraw an item | its contributor (the account or the person who added it), or the business |
| order the gallery | the business only |
| hide or restore an item | an operator (`/moderation/places/{placeId}/media/{mediaId}`) |
| report an item | any signed-in person, into the place report queue |

A claimed place is not closed to customers' photos, for the reason it is not
closed to their capability reports: an item at `community_reported` sits beside
the business's own and cannot displace it.

States are `visible` (published), `hidden` (an operator's, reversible) and
`removed` (the contributor's or the business's, terminal — the row stays so the
history naming it resolves). The unique index on `(place, file)` is partial on
everything but `removed`, so a withdrawn image can be added again.

### Logo and cover

`places.logo_media_id` / `cover_media_id` point at gallery ITEMS; the API reads
and writes them as `logoFileId` / `coverFileId`. A write must name a visible
item of the place of the matching kind (`logo` / `cover`), else `422
not_in_gallery`. Withdrawing or hiding the item clears the pointer in the same
transaction, and a read publishes a pointer only while its item is visible.
Restoring an item does not set it back — that is the business's call.

## 2. Reviews

### A review is a person's

The author is the PERSON from Oxy's actor chain, published as
`authorOxyUserId` for a client to resolve to their public Oxy profile; nothing
else about them is stored, and never a location. A session switched into an
organization is refused: an organization has no experience of a place.

**A business may not review itself.** Anybody AFFILIATED with an approved
claimant is refused (`places/claimAuthority#affiliatedWithAny`): the claimant
account itself, or anybody Oxy reports in ANY active role in it — wider than
the roles that may act for the claim, because the question here is conflict of
interest, not authority, and an employee reviewing their employer's shop is the
case it exists for. Oxy is asked only when the place is claimed; an Oxy failure
is `503`.

One PUBLISHED review per person per place (a partial unique index). `PUT
/places/{placeId}/reviews/mine` writes or rewrites it whole; an operator's hide
survives a rewrite. `DELETE …/mine` withdraws it: `removed`, with its title,
body and reply ERASED (a CHECK holds that), and writing again revives the row as
a new review.

### The business's reply

One per review, in columns on the review, written by whoever acts for an
approved claim. Published as `reply: { body, repliedAt, editedAt? }` — "from the
business" — never naming the account or person, which are recorded. An operator
can remove a reply.

### The rating is derived

`place_review_aggregates` holds the count, the mean and the 1–5 distribution of
the PUBLISHED reviews. Every write that can change which reviews are published
— write, rewrite, withdraw, hide, restore, merge — recomputes it with one query
over `place_reviews` inside its own transaction, after locking the place row
first, so concurrent review writes to a place are serialized and the summary
cannot drift from its rows. Nothing increments (Mercaria's
`review-aggregate.service` rule). `Place.rating` publishes `{ average (one
decimal), count }`, absent until the first published review; the realdb suite
compares the stored row to a fresh computation after each kind of write.

### Lists

`GET /places/{placeId}/reviews` is public and reads no session. `sort` is
`newest` (default; keyset `(createdAt, id)`), `highest` or `lowest` (keyset
`(rating, createdAt, id)`, newest first within a rating). The cursor is bound to
the sort, so one order's cursor is `400` on another.

## 3. Descriptions

`places.description` is the default-language description — what `name` is to
`places_names`. `places_descriptions` holds per-language wording at the
`places_names` grain, `(place, language, source)`: the API writes `goway` rows,
and an importer will only ever be able to address its own. `description: null`
clears the default; a `descriptions` entry with `description: null` withdraws
GoWay's row for that language alone. A single-place read publishes
`description`, `descriptions` and `localizedDescription`, resolved for `locale`
by the same chain as names (`places/placeNames`); lists publish none of them.

## 4. History never holds a file or a word

Every write above records one `place_revisions` row in its own transaction.

| action | visibility |
|---|---|
| `media_added`, `media_removed`, `media_reordered` | public |
| `media_hidden`, `media_restored` | moderation |
| `review_published`, `review_updated`, `review_withdrawn`, `review_replied`, `review_reply_withdrawn`, `review_hidden`, `review_restored` | moderation |

A gallery item is recorded as `media.<id>: { kind, position, verification,
state }` and a logo or cover change as `logo` / `cover` naming the ITEM — never
an Oxy file id. A review is recorded as `reviews.<id>: { rating, status,
locale?, replied }` — never its title, body or reply. History is append-only and
the public one is readable by anybody; a file id or a sentence written there
would outlive an operator's hide and an author's withdrawal.

Reviews are moderation-only history because a review is the reviewer's
statement, not a fact about the place.

## 5. Merges

Inside the merge transaction (`moderationRepository#mergePlaces`):

- descriptions move where the survivor holds none for the same language and
  source;
- gallery items move where the survivor's gallery does not already hold the
  same file, joining the end of it; the absorbed copy of a shared file stays
  behind rather than being destroyed;
- EVERY review moves. Where one person has a published review on both places,
  the one they wrote more recently stays published and the other is set aside
  as `hidden` (with its own `review_hidden` revision) — never destroyed; both
  ratings are recomputed;
- the survivor's public `place_absorbed` revision lists the moved gallery items
  and descriptions, and no review.

## 6. Reports

`place_reports.media_id` / `review_id` name the item a report is about; neither
means the place itself. One open report per person per SUBJECT. A content report
takes a reason from `CONTENT_REPORT_REASONS` (`spam`, `offensive`, `privacy`,
`not_this_place`, `conflict_of_interest`).

## Deliberate debt

- **Oxy's link webhooks are not consumed.** Oxy POSTs `visibility_changed` and
  `deleted` to a link's `webhookUrl`, but the call is unsigned and Oxy offers no
  verification helper, and the only way to re-check a file's visibility is a
  user session. A receiver would let anybody hide any photo by posting a fake
  event. Until Oxy signs them, a file its owner made private or deleted 404s at
  the CDN and the app drops the tile; an operator can hide the item.
- No importer writes media or descriptions yet (Wikimedia Commons is the
  intended source of `external_source` media, which must carry attribution and
  licence — a CHECK holds that).
- Reviews have no per-aspect ratings and no "helpful" votes.
