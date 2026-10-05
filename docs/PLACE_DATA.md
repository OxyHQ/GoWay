# Place data: categories, capabilities and hours

*Design note for Phase 2a of the place-data plan. The contracts are
`packages/contracts/src/category.ts`, `capability-registry.ts` and `hours.ts`;
the tables are in `packages/backend/src/db/schema/places.ts` and
`categories.ts`; the taxonomy's server side is `packages/backend/src/categories/`;
the importer's mapping is `packages/backend/src/import/osm/` (`fields.ts`,
`poiTags.ts`, `capabilityTags.ts`, `openingHours.ts`).*

GoWay used to know a place's name, address, phone and a flat list of category
strings. This note is how it now knows what the place IS, what it offers, and
when it is open — and why each fact lives where it does.

## 1. The category taxonomy

### One tree of dotted keys, held as data

`food.cafe`, `shop.books`, `transport.rail_station`. A key's parent is the key
minus its last segment, so the tree is spelled by the keys. Every ROOT is a
browsing group (`food`, `shop`, `lodging`, `leisure`, `sport`, `culture`,
`transport`, `vehicle`, `health`, `education`, `civic`, `finance`, `worship`,
`services`, `office`, `craft`); every child is something a place is.

The taxonomy is DATA in four tables (`0015`), which GoWay's moderators edit
through `/moderation/categories` without a release:

| table | holds |
|---|---|
| `place_categories` | `key` (PK, immutable), `parent_key` (FK, CHECKed to be the key minus its last segment), `icon` (CHECKed against `CATEGORY_ICONS`), `position` among siblings, `status` (`active` \| `deprecated`), created/updated |
| `place_category_labels` | `(category_key, language)` PK, canonical BCP 47 `language` (the `places_names` CHECK), a trimmed NFC `label`. English is REQUIRED — a deferred constraint trigger refuses a category without one at commit; any other language is optional |
| `place_category_osm_tags` | `tag` PK (`amenity=cafe`, `shop=*`), `category_key`. A table rather than a `text[]` so the primary key says one tag files under ONE category |
| `place_category_events` | the audit: one row per moderation write, in its transaction, with the operator and a `{ field, before?, after? }` diff |

`0016` seeded the 148 categories of the 0.3.0 contract registry — glyphs,
positions in tens, OpenStreetMap tags, and labels in all twelve label
languages (1,776 rows) — generated from the registry and from
`i18n/category-labels.json` (`docs/LABEL_TRANSLATIONS.md`), nothing retyped.
Both sources were then deleted: the database is the one copy. What stays in
`@goway/contracts` is what is a CONTRACT — the key's shape, `CATEGORY_ICONS`,
the statuses, the published shapes and `categoryTaxonomy`, the one way any
reader indexes a list it fetched. The frozen seed survives only as a backend
test fixture (`src/__tests__/fixtures/categoryTaxonomy-0.3.0.json`), which
`categoryTables.realdb.test.ts` holds the migrated database to and the
importer's unit suites classify through.

### Closed by the database

| layer | how |
|---|---|
| table | the `places_categories_taxonomy_guard` trigger (`0016`): an INSERT, or an UPDATE that ADDS a key, is refused unless every added key is an ACTIVE category |
| writes | `POST`/`PATCH /places` check the process's catalog first — a 422 naming `categories.N`, issue `unknown_category` or `deprecated_category` |
| filters | `?categories=` on places and search refuses a key that is not a category (422, `categories.N`); a deprecated key is allowed |

The trigger replaced `0013`'s `places_categories_taxonomy_check`, which `0017`
drops: a CHECK cannot read another table, and one rebuilt from an array literal
made every new category a migration. A key the row already carries may stay —
a deprecated category never makes a place uneditable — and existing rows are
never re-checked, so what `0013` validated stays valid and a deprecated key
stays readable.

A junction table (`place_category_assignments(place_id, category_key)`) would
make membership a foreign key, and was weighed: it means writing ~13M places'
categories as ~15M new rows and rewriting every read that hydrates a place,
every filter (`&&` on `places_categories_gin` becomes a join), the importer's
three-way merge and its recorded `source_data`, on a 2-vCPU instance whose
migration phase is one transaction. The trigger gives the same guarantee for
writes and leaves 12.9M rows untouched. Its cost is a PL/pgSQL call per row
whose categories a write sets, and nothing for any other write (`WHEN`): on the
benchmark machine 100k bare inserts took 4.1 s against the CHECK's 1.6 s, about
25 µs a row — a few milliseconds per 1,000-place import batch, whose rows each
already cost index and source writes.

Responses only check a key's shape: a category a moderator adds after an SDK
was built must not make that SDK reject the places that carry it.

### Moderation

`/moderation/categories` (operator allow-list, `docs/BUSINESS_OWNERSHIP.md`):
list with positions and mappings; create (the key spells the parent, which must
exist and be active; `labels.en` required; position defaults to after the last
sibling); `PATCH` glyph, position, mapping (replaced whole; a tag must be one
the import reads, `isMappableOsmTag`, and no other category's) and status; `PUT`
and `DELETE` one label (never `en`). An active category's parent is active:
deprecating one with an active child, or reactivating one under a deprecated
parent, is `409`, serialized by row locks. A deprecated category is refused on
writes that would add it, mapped by the import to nothing (its tags fall back
to `key=*`), and still listed, labelled and filterable.

**Keys are immutable, and nothing is deleted.** A trigger refuses an UPDATE of
a key and the DELETE of one a place carries. A rename is:

1. create the new key, moving the OpenStreetMap tags to it (remove them from
   the old one first: one tag, one category);
2. deprecate the old key — nothing writes it from here on;
3. `bun run categories:move -- --target-database=<name> --from-category=<old>
   --to-category=<new>` (optionally `--dry-run` first). It rewrites
   `places.categories` AND the import's recorded `categories` by one rule, in
   id-ordered batches through the converter's machinery
   (`places/legacyConversion` — resumable with `--from`, retried on a lock
   timeout), records no revisions (a data move, like `0011`), and moves
   `updated_at`. Do not dispatch the import while it runs. Skipping this step
   loses nothing: the old key keeps reading.

### Read through a cached catalog

`categories/catalog.ts` loads the taxonomy in ONE statement (labels and tags
aggregated per row, so a reader never sees a category without the labels it
was created with) and holds it per database handle for 60 s. A moderation
write drops this process's copy after it commits; another process re-reads
within the TTL. Staleness is harmless where it matters: the trigger refuses
what a stale catalog lets through, and the API answers that refusal as the
same 422 (`issue: inactive_category`).

`GET /categories?locale=` is one page — depth-first, siblings by position, the
deprecated included — with every label and `label` resolved by `localizedLabel`
(`matchLanguageTag`, the BCP 47 matcher every GoWay label uses), cacheable for
5 minutes. Clients index it with `categoryTaxonomy`; the app keeps it in
TanStack Query.

### Stored most-specific, filtered by subtree

A place stores its most specific keys; it does not also store `food` beside
`food.cafe`. `?categories=food` is expanded server-side through the catalog's
tree (`expand`) and answered by `&&` against `places_categories_gin`. Storing
ancestors would make every key a second write and a second thing to keep
consistent.

### What the importer files a place under

The import reads the mapping from the database once per run (a dry run too —
its one read). `osmCategories` (`poiTags.ts`) walks every qualifying tag in
`POI_MAPPING_KEYS` precedence, so the first key is always the one that
classified the element; each tag maps through the catalog (`key=value`, else
`key=*`, active categories only); an ancestor of another key is dropped; at
most three. Every open key (`amenity`, `shop`, `tourism`, `leisure`,
`historic`, `office`, `craft`, `sport`) has a `key=*` fallback in the seed and
every listed value has its own entry, which `poiTags.test.ts` holds the seed
to: nothing the import admits goes uncategorised. A moderator's later mapping
is theirs to keep complete.

The OpenMapTiles class table in `poiTags.ts` stays, for the one job it still
has — deciding clutter the way the basemap does — and no longer names a
category.

### The conversion

`0011_goway_place_data_conversion` (post) rewrites existing rows with one SQL
function applied to `places.categories` AND to the importer's recorded
`categories`: OSM values, OpenMapTiles classes, the ten old groups and the
app's free-text keys all map (and every taxonomy key maps to itself, so a re-run
is a no-op); unmapped keys drop; ancestors of kept keys drop. Converting both
sides with the same function keeps "the column still says what OSM said", so the
next import refreshes the converted value with the real mapping.
`0013_goway_category_taxonomy` (post) then adds the CHECK, `NOT VALID`, and
the operator validates it after the deploy; the next release's `0017` replaces
it with the trigger above. (`0008` is the additive half and
`0012` business moderation's `brand_id` drop: every `pre` migration precedes
every `post` one, see `packages/backend/drizzle/README.md`.) Production's ~13M
rows are converted in batches BEFORE the release by
`bun run places:convert-legacy`, from the same SQL; the runbook is
[`PLACE_DATA_CONVERSION.md`](PLACE_DATA_CONVERSION.md).

## 2. The capability registry

### Attributes are capabilities

Wheelchair access, payment methods, Wi-Fi, cuisine, price level, social links,
a Wikidata brand and the Oxy ecosystem keys are all rows in
`places_capabilities`. Each one is a claim somebody makes with some strength at
some time — which is exactly the row's shape: a value, a verification tier, an
`observed_at`, and the `places_sources` row behind an `external_source` claim.
The unique key includes the tier, so a passer-by's report lands BESIDE the
business's own and never overwrites it, and readers take the strongest. A
column per attribute would have none of that. No new table.

### Every key declares its value

`CAPABILITY_DEFINITIONS` is closed: an unregistered key is refused on every
write (`PUT /places/{id}/capabilities/{key}` answers 400 for the path, a place
body 422 for `capabilities.N.capability`). Each key declares:

| kind | stored as | e.g. |
|---|---|---|
| `boolean` | `true`/`false` | `amenities.wifi` |
| `enum` | one value, with `absent` values | `accessibility.wheelchair`: `yes`/`limited`/`no` |
| `enum_set` | a non-empty array, in registry order | `food.cuisine`, `food.diet` |
| `integer` | a bounded integer | `housing.homiio.listings` |
| `price_level` | 1–4 | `price.level` |
| `url` | a URL on the right host; a handle is accepted and stored as its URL | `social.instagram`: `@cafe` → `https://www.instagram.com/cafe` |
| `text` | bounded, optionally patterned | `brand.wikidata` (`Q123`), `commerce.mercaria.store` (a Mercaria location id) |

plus its label, its enum values' labels, its GROUP (`CAPABILITY_GROUPS`: the
sections a client renders under) and, where OpenStreetMap has one, its tag
mapping. The table's CHECK bounds only the jsonb type (now admitting `array`);
the registry is the authority, applied by `capabilityValueSchemaFor(key)` on the
server and before sending in the SDK — on the moderation route that writes
`oxy_verified` too, so not even an operator can verify a value the registry
refuses.

`payments.faircoin.accepted` keeps the spelling FairCoin integrated against;
the other payment methods join it under `payments.`. The four Mercaria
pickup-location flags map as `stepFreeAccess` → `accessibility.step_free_entrance`,
`accessibleToilet` → `accessibility.toilets_wheelchair`, `parkingOnSite` →
`accessibility.parking_accessible`, `hearingLoop` → `accessibility.hearing_loop`.

### "Has it", and filtering by value

`capabilityHolds(key, value)`: never `false`, `0`, `''` or `[]`, and never an
enum value the key names `absent` (`wheelchair: no` is an assertion that the
place is NOT accessible). The strongest-assertion rule is unchanged:
`?capabilities=key` matches a place whose strongest assertion of the key
holds. A filter may now carry a value — `food.cuisine:italian` (the strongest
cuisine assertion includes it), `accessibility.wheelchair:limited` (is it),
`price.level:2`, `commerce.mercaria.store:<locationId>` (is exactly it) — for
enum, enum-set, price and text keys. A text value is held to the key's own
schema (trimmed, its pattern) and may not contain a comma, which would split a
comma-joined filter list. It is answered by jsonb containment — equality, for a
scalar — over the same `DISTINCT ON` pass, with `bool_or` per filter, so a
weaker assertion of the value never matches a place whose strongest says
otherwise; `placeMatchesCapabilityFilter` is the same rule client-side.

## 3. Hours

### Three facts, kept apart

- **The week** — `places.opening_hours`: local wall-clock intervals per weekday
  plus the source's raw expression. Empty intervals with a `raw` is how a
  schedule GoWay could not read is published.
- **The zone** — `places.timezone`. Derived from the position by
  `places/timezone.ts` on every write that sets one (create, a location
  update, the import), never accepted from a caller. A zone is a property of
  where the place is; a schedule read in a zone somebody typed is wrong in a way
  that looks right. The lookup is `@photostructure/tz-lookup` behind a
  `TimezoneResolver`: no I/O, CC0, tens of kilobytes, sub-millisecond — what an
  importer writing a country needs. It approximates near borders by design.
  It replaced `OpeningHours.timezone`, which a writer could omit and which made
  every such schedule unevaluable; the conversion copies a well-formed one into
  the column. Rows no write has touched since get their zone on the next write
  or import.
- **Exceptions** — `place_hours_exceptions`: a date range, closed or special
  intervals, a note, a source, a verification tier and `observed_at`. Dates, not
  instants — "closed on the 26th" is said in the place's own calendar. Unique on
  `(place, starts_on, ends_on, verification)`, for the reason capabilities are.
  Mercaria's `location_closures` is the same fact.

### One evaluation

`openingStatusAt(place, now)` (contracts) is THE answer to "open now, and until
when", shared by the API, the SDK and the app. It reads each local day from its
strongest exception, else the week; carries a span past midnight; merges
touching spans (`24/7` is open with no change); and answers `unknown` without a
zone, without a schedule for today, or when the runtime cannot evaluate the zone
— never the reader's zone. `nextChange` is an instant plus the place's local
date and time; the instant is off by the shift when a DST change falls between.

### Exception writes follow the capability authority

`POST /places/{id}/hours-exceptions` records at the tier the caller earns
(`business_asserted` for whoever may act for an approved claimant — usually a
member of the business's Oxy organization, see `docs/BUSINESS_OWNERSHIP.md` —
`community_reported` otherwise; a tier in the body is dropped, and `503` when
Oxy cannot answer about the organization). The same dates at the same tier is a
409 naming the exception to rewrite. `PUT …/{exceptionId}` rewrites only an
exception at the caller's own tier; `DELETE` is the approved claimant's, for
`business_asserted` only. A claimed place is not closed to outside reports.
Approving a claim re-tiers the claimant's own pending exceptions as it does
capabilities (`docs/BUSINESS_OWNERSHIP.md`).

Every read that answers with places — by id, the batch read, nearby, a
viewport — embeds the exceptions that have not ended (at most 32 per place, one
query per page), because open-now on a list is wrong on every holiday without
them.

Every exception write records one public revision in its transaction —
`hours_exception_created`, `hours_exception_replaced` (with what it replaced)
and `hours_exception_withdrawn`, as the field `hoursExceptions.<id>` — and, as
for every revision, never says who. A merged place's id answers these routes
with `410` and `mergedInto`; the merge moved its exceptions to the survivor
wherever the survivor held none for the same dates at the same tier.

### Reading OpenStreetMap `opening_hours`

`osmOpeningHoursParser` behind `OpeningHoursParser`: weekday ranges and lists,
split shifts, `off`, `24/7`, hours past midnight, later rules replacing the days
they name. Anything else — months, dates, weeks, `sunrise`, `18:00+`, `||`,
comments — yields no intervals and keeps `raw`. `PH` is dropped from a
selector: a holiday is an exception, not part of a week. opening_hours.js was
not taken: it is an evaluator that needs holiday calendars per country, and
GoWay stores a week.

## 4. The import keeps what it reads

### One field table

`IMPORTED_FIELDS` (`fields.ts`) names every `places` column the import owns,
once, with how to read it, its schema, and what EMPTY and SAME mean for it. The
record type, `source_data.normalized`, the three-way merge, the read-back
selection, the insert and its parameter count are all derived from it — the
seven hand-kept lists are gone. A new importable column is one entry.

### `source_data` is versioned

`{ v: 2, tags, normalized }`: every raw tag (so a mapping added later can read
what is already stored) and what each owned column was given, plus the
capabilities asserted. A reader that meets another version treats the row as
having stated nothing, and the merge then fills gaps only. The conversion
wraps version-1 rows with empty `tags`, which the next import fills.

### What is mapped

Columns: the name, position, address, contact, categories, `opening_hours` and
the derived zone. Capabilities, as `external_source` tied to the element's own
`places_sources` row: `wheelchair`, `toilets:wheelchair`, `hearing_loop`,
`payment:*`, `internet_access`, `outdoor_seating`, `takeaway`, `delivery`,
`reservation`, `drive_through`, `toilets`, `air_conditioning`, `cuisine`,
`diet:*`, `brand:wikidata` and `contact:*`/bare social tags.

### And never overwrites a GoWay or business edit

- A column changes only while it still equals what OpenStreetMap last said
  (`mergePlaceColumns`, one loop over the table), or while it is empty and
  OpenStreetMap never said otherwise.
- A column somebody CLEARED (`PATCH … { "contact": { "phone": null } }`) where
  OpenStreetMap had said something stays empty while OpenStreetMap repeats
  that value, and takes OpenStreetMap's value once it changes: the clear was a
  statement about the old value, and a new one is new evidence. `source_data`
  keeps recording what OpenStreetMap says either way.
- A capability write can address only the `external_source` row, and its
  `setWhere` refuses a row another source asserted and an observation older than
  the stored one; business and community rows are other keys entirely.
- Nothing is deleted; a tag OpenStreetMap dropped leaves its last assertion to
  age, visibly, by `observed_at`.
- A changed capability with no changed column still moves `places.updated_at`.

`osmImport.realdb.test.ts` holds each of these, including a second identical
run writing no place row.

## 5. Photos, reviews and descriptions

Gallery items (Oxy files), reviews with their derived rating, and descriptions
per language are `docs/PLACE_MEDIA_REVIEWS.md`.

## Deliberate debt

- Price level and two accessibility flags (step-free entrance, accessible parking) have no OpenStreetMap mapping; they
  arrive from businesses, the community and Mercaria.
- Public-holiday rules from `opening_hours` are not turned into exceptions;
  that needs a holiday calendar per region.
- The bundled category labels are English and Spanish until the category
  tables publish the other ten; the capability vocabulary is in all twelve
  label languages, and the app's own chrome is English.
