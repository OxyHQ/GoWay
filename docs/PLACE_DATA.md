# Place data: categories, capabilities and hours

*Design note for Phase 2a of the place-data plan. The contracts are
`packages/contracts/src/category.ts`, `capability-registry.ts` and `hours.ts`;
the tables are in `packages/backend/src/db/schema/places.ts`; the importer's
mapping is `packages/backend/src/import/osm/` (`fields.ts`, `poiTags.ts`,
`capabilityTags.ts`, `openingHours.ts`).*

GoWay used to know a place's name, address, phone and a flat list of category
strings. This note is how it now knows what the place IS, what it offers, and
when it is open — and why each fact lives where it does.

## 1. The category taxonomy

### One closed tree of dotted keys

`food.cafe`, `shop.books`, `transport.rail_station`. A key's parent is the key
minus its last segment, so the tree is spelled by the keys and cannot disagree
with a separate parent column. Every ROOT is a browsing group (`food`, `shop`,
`lodging`, `leisure`, `sport`, `culture`, `transport`, `vehicle`, `health`,
`education`, `civic`, `finance`, `worship`, `services`, `office`, `craft`);
every child is something a place is.

Each registry entry carries its glyph key (`CATEGORY_ICONS` — provider-neutral;
each client maps it to its own drawing), its label in every label language
(English and Spanish, both required — `labels.ts`), and its OpenStreetMap
mapping as `key=value` tags, with `key=*` as a key-wide fallback.

### Closed at three layers

| layer | how |
|---|---|
| table | `places_categories_taxonomy_check`: `categories <@ ARRAY[CATEGORY_KEYS]`, built from the registry (`closedSetArray`, the array sibling of `closedSet`) |
| writes | `categoryKeySchema` (`z.enum(CATEGORY_KEYS)`) on `POST`/`PATCH /places` — a 422 naming `categories.N` |
| filters | the same schema on `?categories=` for places and search |

Responses are deliberately LOOSER (`publishedCategoryKeySchema`, any dotted
key): a category GoWay adds must not make an older SDK reject the places that
carry it. Adding a category is one registry entry plus the generated migration
that widens the CHECK.

### Stored most-specific, filtered by subtree

A place stores its most specific keys; it does not also store `food` beside
`food.cafe`. `?categories=food` is expanded server-side by
`categoryDescendants` and answered by `&&` against `places_categories_gin`.
Storing ancestors would make every key a second write and a second thing to
keep consistent.

### What the importer files a place under

`osmCategories` (`poiTags.ts`) walks every qualifying tag in `POI_MAPPING_KEYS`
precedence, so the first key is always the one that classified the element;
each tag maps through the registry (`key=value`, else `key=*`); an ancestor of
another key is dropped; at most three. Every open key (`amenity`, `shop`,
`tourism`, `leisure`, `historic`, `office`, `craft`, `sport`) has a `key=*`
fallback and every listed value has its own entry, which `poiTags.test.ts`
holds to: nothing the import admits goes uncategorised.

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
`0012_goway_category_taxonomy` (post) then adds the CHECK. (`0008` is the
additive half and `0010` business moderation's `brand_id` drop: every `pre`
migration precedes every `post` one, see `packages/backend/drizzle/README.md`.)

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
`price.level:2` — for enum, enum-set and price keys only. It is answered by jsonb
containment over the same `DISTINCT ON` pass, with `bool_or` per filter;
`placeMatchesCapabilityFilter` is the same rule client-side.

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
`business_asserted` only. A claimed place is not closed to outside reports. A
single-place read embeds the exceptions that have not ended; lists omit them.

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
  (`mergePlaceColumns`, unchanged in rule, now one loop over the table).
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
- Labels exist in English and Spanish only; the app's own chrome is English.
