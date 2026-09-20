# Place names, in more than one language

*Design note for OxyHQ/GoWay#61. The code is `places_names` in
`packages/backend/src/db/schema/places.ts`, the resolution chain in
`packages/backend/src/places/placeNames.ts`, and `PlaceName` /
`placeDisplayName` in `packages/shared-types`.*

This landed **before** the OpenStreetMap POI import, deliberately. That import
writes millions of rows, and a single-language `places.name` would have fixed
the map's vocabulary for places to one language for as long as re-importing the
planet is too expensive to contemplate — across a table that by then also holds
GoWay edits, claims and contributions a re-import must not clobber.

It reaches further than a UI concern. Once POIs live in GoWay Places and the
basemap's own `poi-*` layers are switched off, **the language of every shop,
restaurant and museum label on the map comes from this table**. Street, city and
country names stay tile-driven (`name:latin` in `lib/map/style/layers.ts`) and
are a separate problem.

## The shape

One row per `(place, language, source)`:

| column | |
|---|---|
| `language` | canonical BCP 47 — the `xx` of OSM's `name:xx` |
| `name` | the spelling |
| `name_normalized` | `lower(btrim(name))`, GENERATED; reconciliation only |
| `source` | `openstreetmap`, `goway`, … — the same key space as `places_sources.source` |
| `observed_at` | when this source last said it; monotonic |

## The five questions, and the answers

### 1. Does `places.name` stay? **Yes — as the default name.**

Three reasons, in order of weight:

- **`NOT NULL` makes "a place with no name" unrepresentable.** In a
  names-table-only design it is an ordinary consequence of an importer bug, and
  the symptom is unlabelled pins on a public map.
- **The default name has no language tag to be keyed by.** OSM's bare `name` is
  the local-language name and its language is usually recorded nowhere. Putting
  it in `places_names` needs a nullable `language` plus a partial unique index
  to keep one per place — a weaker constraint for a worse reason.
- **`name_normalized` is generated from it and drives duplicate detection.**
  Moving the default name would change every reconciliation rule in the same
  commit as the schema.

Rejected: a `jsonb names` column on `places` (no per-language conflict target
for a re-import to upsert against, no per-language provenance, not indexable per
language), and making `places.name` a view over `places_names` (same
`NOT NULL` loss, plus a generated column over a view).

The consequence is that the change is **purely additive**.

### 2. Reconciliation and duplicates. **Nothing existing changed; a new rule was added under a new reason.**

`places.name_normalized` still compares **default names only**. No pair that was
a `proximity_and_name` candidate stopped being one, and no pair that was not
became one.

The blind spot translations open is real: "Museu Picasso" and "Museo Picasso"
are one museum, they are not equal as default names, and before this table
nothing in the database could see the claim. So there is a second rule —
intersecting *name sets* within the same 75 m — filed under its own reason,
`proximity_and_translated_name`.

Separate rather than folded in, because:

- each value in `DUPLICATE_CANDIDATE_REASONS` is a **rule**, and a reviewer who
  cannot tell which one fired cannot weigh the answer;
- the false-positive profile is **worse** across languages, not better:
  "Farmacia", "Pharmacie", "Pharmacy" and "Apotheke" collide with each other as
  well as with themselves;
- widening the existing value would have retroactively changed what every
  historic `proximity_and_name` row meant.

Still both conditions, always. Still no merge: a candidate is a queue entry.

### 3. Search. **GoWay's own names are ours to search; the gazetteer is not.**

`GET /search` matches typed text against **every** language GoWay holds for a
place, not the resolved one — a search box is where somebody types the name they
know, which is routinely not the language they read the map in. So "Munich"
finds München and the label still reads München for a German locale.

It is matched in memory over the spatially-anchored candidate set, which is
where `placeMatchesText` already worked; `places_names_name_normalized_idx`
makes the eventual SQL query possible, and a trigram index for fuzzy matching is
the search issue's decision — it needs `pg_trgm` in `REQUIRED_EXTENSIONS`, and
an extension added speculatively is one nobody can remove.

Streets, cities and countries stay with the geocoder. Photon already indexes
`name:*` and takes a `lang`; a planet-scale multilingual gazetteer of our own is
exactly what the ownership boundary exists to prevent.

### 4. The SDK contract. **Additive. `@goway.to/sdk@0.1.1`, a PATCH.**

`Place.name` means exactly what it meant in 0.1.0 — the default, local-language
name — and it does **not** move with the new `locale` parameter. A field whose
meaning depended on a query parameter would make one cached `Place` mean
different things to different holders of it, and Homiio is integrating against
0.1.0 right now.

What is new is all optional:

- `Place.names?: PlaceName[]` — every language, with provenance. Published on a
  single-place read and on search results; **absent** from `places.nearby` and
  `places.inBounds`, where 200 pins × every language is a payload nothing
  renders. Absent is not empty, as with `Place.claims`.
- `Place.localizedName?: PlaceName` — the resolved answer, present only when a
  locale was asked for and one exists.
- `placeDisplayName(place)` — `localizedName?.name ?? name`, published so nobody
  restates it and quietly drops the locale they asked for.
- `locale` on the three place reads, and the client-level `locale` now reaching
  them (before 0.1.1 it reached search, geocoding and routing only).

**Cost to Homiio: none.** No field changed meaning, none was removed, and a
0.1.0 client ignores the new ones. Adopting them is `locale` on the client plus
`placeDisplayName` at the render sites.

### 5. Fallback order. **Decided once, server-side.**

1. the exact tag — `es-MX`
2. the bare language — `es`
3. another variety of it — `es-AR`, `es-419`
4. the place's default name

Within each rung: `goway` outranks every other source, then freshest, then the
tag alphabetically.

The issue sketched a fifth rung, "→ anything". **Refused.** An arbitrary other
language is not a better answer than the default: the default is the name on the
shopfront, so a Spanish speaker in Tokyo is better served by 東京都庁 — which
matches the sign, the tile and anyone they ask — than by whichever exonym
happened to be recorded first. Rung 4 is expressed by *omitting*
`localizedName`, so "nothing for your locale" and "here is the default" are one
statement rather than two.

## Provenance, and the re-import

> *"Preserve source provenance and never destructively overwrite a source fact."*

Three properties, all structural rather than conventional:

- **A source can only speak for itself.** The conflict target is
  `(place, language, source)`. An `openstreetmap` refresh has no way to *address*
  the `goway` row for the same language, so a GoWay-owned correction to the
  Spanish name survives the next import because of the key, not because the
  importer remembers.
- **Time only moves forward.** The upsert's `setWhere` refuses an observation
  older than the stored one, so replaying a stale planet export is a no-op
  rather than a regression.
- **Nothing is deleted.** A language absent from one run is not a statement that
  the name is wrong — imports are partial and tags get vandalised and reverted.
  Withdrawing a name is a moderation act that can record who did it, the same
  trade `places_capabilities` already made.

Names written through the HTTP API are always `goway`; a caller cannot label a
row `openstreetmap`, for the reason a caller cannot label a capability
`oxy_verified`. The importer calls `applyPlaceNames` directly and names its own
source.

### On issue #58

`places_sources` currently records Museu Picasso's provenance as
`way/34633854` — the Empire State Building. An identifier that resolves to
*something* looks exactly like one that resolves to the right thing unless
somebody dereferences it.

`places_names.source` is deliberately **a source key, not a reference to a
`places_sources` row**. The question a name row has to answer is "which source
says this spelling", and `openstreetmap` names no foreign record — so there is
nothing here that can point at the wrong continent, and nothing that needs
dereferencing to be trusted. That class of error is not made harder to *find*
here; it is made impossible to *introduce*.

## Deliberate debt

- **Glyphs.** GoWay serves Inter (Latin/Greek/Cyrillic); CJK, Arabic, Devanagari
  and Thai fall through to upstream Noto. A CJK set is tens of thousands of
  glyphs, so this is a real storage decision and a real gap against "nothing
  should come from anywhere else". Recorded as deliberate rather than
  discovered.
- **The app's own UI strings.** `lib/i18n.tsx` still loads only `en`. Ordinary
  i18n work, independent of this.
- **Four BCP 47 regexes.** `shared-types/src/language.ts` is now the canonical
  one and the Places surface uses it; `routes/searchSchemas.ts`,
  `routes/routeSchemas.ts` and the SDK's `LOCALE` each still carry their own,
  and the first two are *intentionally* laxer (they forward a tag verbatim to a
  provider that owns its own language registry). Worth revisiting; not worth
  changing behaviour for in this issue.
- **Switching off the basemap `poi-*` layers.** The reason this table matters,
  and a separate issue: it needs the import to have run first.
