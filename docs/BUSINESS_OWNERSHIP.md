# Business ownership, place history and moderation

A business is an **Oxy organization**. GoWay stores the organization's account
id on a claim and asks Oxy who may act for it; it keeps no member list, no
business table and no brand id. This note records the rules and why each one is
the shape it is. The code is the authority: `places/claimAuthority.ts`,
`oxy/accountRoles.ts`, `db/places/revisions.ts`,
`db/places/moderationRepository.ts`, and `packages/contracts/src/revision.ts`
and `moderation.ts`.

## Who may act for a claim

A claim (`places_claims`) names an Oxy account, usually `kind=organization`. A
caller acts for it when either:

1. **the session is that account** — a person's own account, or a session that
   switched into the organization (`oxy.accounts.actAs`), whose token subject is
   then the organization; or
2. **the person is a member** Oxy reports as `owner`, `admin` or `editor`.

`developer`, `billing` and `viewer` are not enough: none of them is a role in
which a person speaks for the business on a public map. The table is total over
Oxy's `AccountRole` (`ACCOUNT_ROLE_AUTHORITY`), so a role Oxy adds stops the
build until somebody classifies it.

Acting for an approved claim lets a caller edit the claimed place, assert
capabilities and hours exceptions at `business_asserted`, withdraw that tier,
and read the place's claims. **Filing** a new claim in an organization's name is narrower — `owner`
or `admin` — because it is a statement about who the business is.

A chain is an organization claiming each of its locations in the `brand` role.
`places_claims.brand_id` was dropped (post-phase migration `0010`).

### How GoWay asks Oxy

`GET /accounts/:id` with the **caller's own bearer**, which Oxy answers with
`callerMembership` resolved for the PERSON behind the session (a switched
session keeps its operator's role). There is no service-token endpoint for
membership, and a service token could not prove the person asked.

- A fresh `@oxy.so/core` client per question, disposed after it, no retries and
  a 5 s timeout: the shared process client must never carry a caller's token.
- `403`/`404` from Oxy mean "no role". `401` is the caller's session failing at
  Oxy. Anything else is an outage: **GoWay fails closed with
  `503 service_unavailable`**.
- Answers are cached 30 s per **person and account** — never per effective
  account, which two people switched into the same organization share while
  holding different roles. A session whose person Oxy did not report is not
  cached. Failures are never cached. A removed member keeps access for at most
  the TTL.
- Nothing asks Oxy when nothing depends on it: an unclaimed place, or a session
  that itself holds a claim whose role speaks for the business, costs no call —
  so a business never loses its own place to an Oxy outage over a question that
  was already answered.

The public `GET /places/{id}` embeds claims only for the session's own account
and never asks Oxy: the public read must not wait on, or fail with, another
service. A member reads the claims through `GET /places/{id}/claims`.

### Why another Oxy app can edit a GoWay place

User tokens are `aud=oxy-api` and not app-bound, so a Mercaria dashboard
session calls GoWay's API directly and GoWay authorizes it like any other. The
only thing the calling app needs is its origin on GoWay's credentialed CORS lane
(`CORS_APP_ORIGINS`): `https://mercaria.co` and `https://dashboard.mercaria.co`
in production's runtime template, the Expo dev servers locally.

## Place history

`place_revisions` is **append-only**, and every write path in `db/places`
records exactly one row **in the same transaction** as the write: place create
and update, capability assertion and withdrawal, hours-exception creation,
rewrite and withdrawal, gallery and review writes (`docs/PLACE_MEDIA_REVIEWS.md`),
claim request and decision, and every moderation action. A write that rolled back left no revision; a
revision always describes a write that committed. The realdb suite proves it by
making the revision insert fail and asserting the write did not land.

Each row holds the action (a closed set in contracts), the source (`api` or
`moderation`), the account the write was made AS (`oxy_account_id`), the PERSON
from Oxy's actor chain (`operated_by_oxy_user_id`, null when Oxy did not report
one — recorded as unknown, never guessed), and a field-level diff in the
published shape: `{ field, before?, after? }`, where `field` is `name`,
`address.city`, `timezone`, `names.es`, `capabilities.payments.faircoin.accepted`,
`hoursExceptions.<id>`, … The derived `timezone` is diffed like any other
column, so a move that changes it says so.

### The exposure rule

`GET /places/{id}/revisions` is public — signed out, in the public CORS lane,
identical for every caller — because the facts it describes are already public
on the place. It publishes **what changed and when, never who**:

- No account id and no person, for any action. A history of who edited which
  shop is a map of people's movements and affiliations, and the place itself
  never names its contributors either. The repository does not read those
  columns for the public audience at all.
- Only actions `PLACE_REVISION_VISIBILITY` classifies `public`: place
  creation and updates, capability assertions and withdrawals, hours-exception
  writes (`hours_exception_created`, `_replaced`, `_withdrawn` — an exception is
  published on the place and by its own public list), merges. Claims
  (a business relationship GoWay shows only to the parties), report
  resolutions and duplicate reviews (moderation state) are `moderation`. The
  classification is total, so a new action cannot default to public.

Operators read the full history, actors included, through
`GET /moderation/places/{id}/revisions`.

The OpenStreetMap import writes no revisions yet; its provenance is
`places_sources.observed_at` and the source rows themselves.

## Moderation

Every `/moderation/*` route needs an Oxy session whose **person** is on
`MODERATION_OPERATOR_OXY_USER_IDS` — the same Oxy-id allow-list mechanism as
the Street 3D contribution pilot (`CAPTURE_PILOT_OXY_USER_IDS`), parsed by the
same combinator. Matching the person means switching into an organization
neither grants nor removes operator rights. Empty means nobody.

- **Claims**: a queue by state; `approved`/`rejected` decide a `pending` claim,
  `revoked` withdraws an `approved` one, anything else is `409`. `decidedAt` is
  when the claim's current state was decided.
- **Verification**: `oxy_verified` capabilities are written and withdrawn only
  here, beside every other tier's row, and the value is held to the key's
  registry entry exactly as a public assertion's is (`docs/PLACE_DATA.md`); the place's `verificationState` (with
  `verifiedAt`) and its removal or restoration are one `PATCH`.
- **Reports**: any signed-in person may report a place for a closed reason
  (`PLACE_REPORT_REASONS`), one open report per person per place. Operators see
  the note, never the reporter, and close a report as `actioned` or
  `dismissed`. A report changes nothing by itself.
- **Duplicates**: an operator keeps both places (`reject`) or merges one into
  the other.

### Merges

`merge` names the survivor, which must be one of the pair. In one transaction,
with both places locked in id order:

- **Sources move**, all of them. `(source, sourceId)` is unique across the
  table, so the next import of that OpenStreetMap node updates the survivor
  rather than a place nobody reads.
- **Names, descriptions, capabilities, hours exceptions and claims move**
  wherever the survivor holds no row of its own under the same key — for an
  exception, the same dates at the same tier. The survivor's statement wins
  every collision; the losing row stays on the absorbed place rather than being
  destroyed. Gallery items move where the survivor does not already show the
  same Oxy file; every review moves, one person's older review set aside as
  `hidden` when they reviewed both (`docs/PLACE_MEDIA_REVIEWS.md`).
- **The survivor's own columns are never rewritten.** Its name, position and
  the `timezone` derived from it, `categories`, address, contact and weekly
  hours are its statement, exactly as its children win their collisions; the
  absorbed place's columns stay on the absorbed row. A moved source refreshes
  the survivor at the next import only where the import's own rule allows (a
  column changes only while it still equals what that source last said).
- The absorbed place becomes `merged` with `merged_into_place_id` set (a CHECK
  ties the two together, and the self-referencing foreign key is `restrict`).
  Every place already merged into it is re-pointed at the survivor, so a
  redirect is always **one hop**.

A merged id answers `410 gone` with `details.mergedInto` on every route that
takes a place id, and the SDK exposes it as `GoWayGoneError.mergedInto`. A
removed place's `410` carries no pointer. `410` rather than a redirect because
the API convention is that a withdrawn resource is `gone`, and a pointer in
`details` lets a consumer holding the old id replace it rather than chase it.

## Why moderation is in the SDK

`@goway.to/sdk` reaches the whole route registry, and a unit test holds it to
that. The moderation routes are in a separate `moderation` namespace, documented
as GoWay's operator surface: GoWay's own tools build on the same contract as
everything else, and an integration that calls it gets `GoWayForbiddenError`.
Leaving it out would mean a second, hand-written client for the same contract.
