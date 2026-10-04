/**
 * GoWay Places — the canonical GoWay-owned identity and enrichment layer for
 * physical places.
 *
 * ## The ownership boundary this schema encodes
 *
 * OpenStreetMap and friends own base geometry, public labels and source-native
 * POI facts. GoWay owns stable identity, enrichment, claimed business
 * relationships, ecosystem capabilities, verification state and reconciliation
 * metadata. Nothing here is an attempt to hold the OSM planet: a place exists
 * in this database because GoWay knows something about it that the source does
 * not.
 *
 * ## The child tables, and why none of them is a column on `places`
 *
 * Each child table exists because collapsing it into `places` would make a
 * real-world case unrepresentable without a later migration:
 *
 *  - `places_sources`   — a place reconciles against MANY sources, each with
 *                         its own identifier and its own freshness. A single
 *                         `osm_id` column cannot hold a place that is also a
 *                         Wikidata entity and a GoWay submission, and it has
 *                         nowhere to put `observedAt`.
 *  - `places_claims`    — a single `owner_id` column makes chains, franchises,
 *                         shared venues and delegated management impossible.
 *                         A claim carries a ROLE and a STATE precisely so a
 *                         pending claim is not an ownership fact.
 *  - `places_capabilities` — one row per asserted capability in a namespaced
 *                         key space, so adding an Oxy product is an INSERT
 *                         rather than a schema fork. A `accepts_faircoin`
 *                         boolean would be the first of an unbounded family of
 *                         columns, and it would have nowhere to record that the
 *                         claim is a two-year-old community report.
 *  - `places_duplicate_candidates` — reconciliation output that is REVIEWABLE.
 *                         Auto-merging is not reversible from the outside; a
 *                         candidate row is.
 *  - `places_names`     — a place has a name in EVERY language its sources
 *                         record one in, and each of those names has its own
 *                         provenance. A `name_es` column is the first of a
 *                         family with no bound, a `jsonb` map has no per-
 *                         language conflict target for a re-import to upsert
 *                         against, and neither can hold a GoWay correction
 *                         beside the source's own spelling of the same
 *                         language — which is what stops the next import from
 *                         destroying the correction.
 *  - `place_revisions`  — the append-only history of every write, one row per
 *                         write, in the write's own transaction. An
 *                         `updated_by` column remembers only the last writer;
 *                         a history is what lets a vandalised place be read
 *                         back and an operator's decision be traced.
 *  - `place_reports`    — what signed-in people flagged for moderation, one
 *                         open report per reporter per place.
 *  - `place_hours_exceptions` — a closure or special hours is a dated CLAIM
 *                         with a verification tier, and a business's own
 *                         holiday notice must not be overwritten by a
 *                         passer-by's report about the same day.
 *
 * ## Privacy
 *
 * There is no user position anywhere in this file, and there must never be.
 * Public place data and user location data are separate domains: a precise
 * coordinate a user supplies is transient request data, and a "places near me"
 * query persists nothing about the asker. `created_by_oxy_user_id` on `places`
 * is authorship of a CONTRIBUTION — where a user said a shop is, not where the
 * user was — and it is never published through the API.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  CAPABILITY_VERIFICATIONS,
  CATEGORY_KEYS,
  DUPLICATE_CANDIDATE_REASONS,
  DUPLICATE_CANDIDATE_STATES,
  LANGUAGE_TAG_SQL_PATTERN,
  MAX_HOURS_EXCEPTION_DAYS,
  PLACE_CLAIM_ROLES,
  PLACE_CLAIM_STATES,
  PLACE_REPORT_REASONS,
  PLACE_REPORT_RESOLUTIONS,
  PLACE_REVISION_ACTIONS,
  PLACE_REVISION_SOURCES,
  PLACE_STATUSES,
  PLACE_VERIFICATION_STATES,
  type CapabilityValue,
  type GeoGeometry,
  type OpeningHours,
  type PlaceRevisionChange,
  type TimeRange,
} from '@goway/contracts';
import {
  closedSet,
  closedSetArray,
  foreignServiceId,
  generatedGeographyPoint,
  latitude,
  longitude,
} from './columns';

/**
 * A physical place, as GoWay identifies it.
 *
 * The primary key is a GoWay id and nothing else. An OSM node can be deleted,
 * renumbered or replaced without GoWay losing the identity of the real place,
 * a GoWay-created place has an id before it matches anything external, and
 * `https://goway.to/place/<id>` has to keep resolving across all of that — so
 * every provider identifier lives in `places_sources`, never here.
 *
 * The structured address is FLATTENED into columns rather than stored as a
 * blob: `address_country_code` is the first thing a regional query, a
 * per-country moderation rule or a coverage report needs, and a jsonb blob
 * makes each of those a functional index nobody remembers to add. Opening hours
 * and geometry stay jsonb because neither is queried by part — a schedule is
 * evaluated whole, against the place's own timezone.
 */
export const places = pgTable(
  'places',
  {
    id: generatedId(),
    /**
     * The DEFAULT name — OpenStreetMap's bare `name`, which is the LOCAL
     * language and is not the same thing as English.
     *
     * It stays a column on `places`, and `places_names` holds only the
     * language-TAGGED names beside it, for three reasons worth the
     * redundancy:
     *
     *  - NOT NULL here makes "a place with no name at all" unrepresentable. A
     *    names-table-only design makes it an ordinary consequence of an
     *    importer bug, and the symptom is unlabelled pins on a public map.
     *  - The bare `name`'s language is frequently recorded nowhere, so it has
     *    no tag to be keyed by. Storing it in `places_names` would need a
     *    nullable `language` and a partial unique index to keep one per place,
     *    which is a weaker constraint than `not null` for a worse reason.
     *  - `name_normalized` below is generated from it and is what duplicate
     *    detection compares. Moving the default name would change every
     *    reconciliation rule in the same commit as the schema — see
     *    `DUPLICATE_CANDIDATE_REASONS`.
     */
    name: text().notNull(),
    /**
     * `lower(btrim(name))`, GENERATED — the only name form reconciliation is
     * allowed to compare.
     *
     * Generated rather than maintained, because a normalized copy that the
     * application writes drifts the first time a name is updated by a path that
     * forgot it, and a stale normalized name silently changes which places are
     * duplicate candidates. `lower` and `btrim` are both IMMUTABLE, which is
     * what a generated column requires.
     *
     * Equality on this is NEVER on its own a reason to merge — see
     * `DUPLICATE_CANDIDATE_REASONS`.
     *
     * It compares DEFAULT names only, and `places_names` did not change that.
     * "Museo Picasso" and "Picasso Museum" are still not equal here, so no
     * pair that was a `proximity_and_name` candidate stopped being one and no
     * pair that was not became one. Two places recorded under two of their own
     * languages are caught by a SEPARATE rule with its own reason, against
     * `places_names.name_normalized` — never by widening what this column
     * means.
     */
    nameNormalized: text().generatedAlwaysAs(() => sql.raw('lower(btrim(name))')),

    latitude: latitude().notNull(),
    longitude: longitude().notNull(),
    /**
     * The representative point — what a marker sits on — GENERATED from the
     * two ordinates above and never written. See `generatedGeographyPoint`.
     */
    geo: generatedGeographyPoint('longitude', 'latitude'),

    /** Footprint or service area as GeoJSON, when GoWay has one. */
    geometry: jsonb().$type<GeoGeometry>(),

    /**
     * Category taxonomy keys (`food.cafe`), most specific first — constrained
     * to the contract's registry below. Ancestors are not stored: a filter on
     * `food` expands to its descendants instead.
     */
    categories: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    addressHouseNumber: text(),
    addressStreet: text(),
    addressLocality: text(),
    addressCity: text(),
    addressRegion: text(),
    addressPostalCode: text(),
    /** ISO 3166-1 alpha-2, uppercase — constrained below. */
    addressCountryCode: text(),
    addressCountry: text(),
    /** The source's own single-line rendering, when it provides one. */
    addressFormatted: text(),

    contactPhone: text(),
    contactEmail: text(),
    contactWebsite: text(),

    /** The weekly schedule, local wall-clock, read in `timezone`. */
    openingHours: jsonb().$type<OpeningHours>(),
    /**
     * The IANA zone the place's clock reads in — `Europe/Madrid`.
     *
     * DERIVED from the position on every write that sets one (`places/timezone`),
     * never accepted from a caller: a zone is a property of where the place is,
     * and a schedule evaluated in a zone somebody typed is wrong in a way that
     * looks right. Nullable only for a position no zone covers.
     */
    timezone: text(),

    status: text().notNull().default('active'),
    verificationState: text().notNull().default('unverified'),
    verifiedAt: timestamptz(),
    /**
     * The place that absorbed this one, when moderation merged them. Set
     * exactly when `status` is `merged`, and what the `410 gone` for this id
     * points at.
     *
     * Always ONE hop: merging the survivor later re-points every place merged
     * into it, so a consumer holding an old id follows one pointer, never a
     * chain. `restrict` rather than `cascade`: a survivor is never deleted out
     * from under the ids that redirect to it.
     */
    mergedIntoPlaceId: text().references((): AnyPgColumn => places.id, { onDelete: 'restrict' }),

    /**
     * Who submitted this place, for a GoWay-created one. An Oxy user id: Oxy
     * owns identity, so no foreign key and no `users` table.
     *
     * Contribution authorship, NOT a location trace — it records where somebody
     * said a shop is, never where that person was. It is not published through
     * the API.
     */
    createdByOxyUserId: foreignServiceId(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('places_status_check', table.status, PLACE_STATUSES),
    closedSet('places_verification_state_check', table.verificationState, PLACE_VERIFICATION_STATES),
    /**
     * Built from `CATEGORY_KEYS`, so a category added to the contract is a
     * generated migration that widens this, and a free-text category is
     * refused here as well as at the edge.
     */
    closedSetArray('places_categories_taxonomy_check', table.categories, CATEGORY_KEYS),
    /**
     * The ordinates are bounded HERE as well as in the HTTP layer. A latitude
     * of 120 rejected by zod is a 422; a latitude of 120 that reaches the table
     * through a backfill, a script or a future importer is a point PostGIS will
     * happily normalize into some other place on Earth.
     */
    check('places_latitude_range_check', sql`${table.latitude} between -90 and 90`),
    check('places_longitude_range_check', sql`${table.longitude} between -180 and 180`),
    check('places_name_not_blank_check', sql`btrim(${table.name}) <> ''`),
    check(
      'places_country_code_check',
      sql`${table.addressCountryCode} is null or ${table.addressCountryCode} ~ '^[A-Z]{2}$'`,
    ),
    /** A merged place names its survivor, and only a merged place names one. */
    check(
      'places_merged_into_check',
      sql`(${table.status} = 'merged') = (${table.mergedIntoPlaceId} is not null)`,
    ),
    check('places_merged_into_self_check', sql`${table.mergedIntoPlaceId} <> ${table.id}`),
    check(
      'places_timezone_check',
      sql`${table.timezone} is null or ${table.timezone} ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)*$'`,
    ),

    /**
     * The index every spatial read depends on. `ST_DWithin` and `ST_Intersects`
     * on `geography` are index-backed against this; `ST_Distance(...) < r` in a
     * WHERE clause is NOT and degrades to a planet-wide sequential scan, which
     * is why it only ever appears in a SELECT list or an ORDER BY in
     * `db/places/placeGeo.ts`.
     */
    index('places_geo_gist').using('gist', table.geo),
    index('places_categories_gin').using('gin', table.categories),
    index('places_status_idx').on(table.status),
    /** Duplicate-candidate detection reads this beside the spatial index. */
    index('places_name_normalized_idx').on(table.nameNormalized),
    /** What a merge reads to re-point the places already merged into the one it absorbs. */
    index('places_merged_into_idx').on(table.mergedIntoPlaceId),
  ],
);

/**
 * A place's name in ONE language, from ONE source.
 *
 * This table is the map's vocabulary for places. Once POIs live in GoWay
 * Places and the basemap's own `poi-*` layers are switched off, the language of
 * every shop, restaurant and museum label comes from here rather than from the
 * tile — so a single-language column would have been a single-language map,
 * permanently, for the price of one import.
 *
 * ## The grain is `(place, language, source)`, and every part earns its place
 *
 * Not `(place, language)`. OpenStreetMap says `name:es = "Museo Picasso"` and
 * GoWay may hold a correction to the same Spanish name; at that grain the two
 * are one row and the next import overwrites the correction, which is exactly
 * what `AGENTS.md` forbids — *"never destructively overwrite a source fact"*.
 * At this grain they are two rows: the importer's upsert targets
 * `(place, language, 'openstreetmap')` and CANNOT name the `goway` row, so the
 * correction survives the re-import as a property of the schema rather than of
 * whoever writes the importer. Reads prefer `goway`; see `places/placeNames`.
 *
 * ## Provenance here is a SOURCE, not a source RECORD
 *
 * `source` is the same key space as `places_sources.source` — `openstreetmap`,
 * `goway` — and deliberately not a reference to a `places_sources` row.
 *
 * That is a direct response to issue #58, where `places_sources` recorded Museu
 * Picasso's provenance as `way/34633854`, the Empire State Building: an
 * identifier that resolves to *something* looks exactly like one that resolves
 * to the right thing unless somebody dereferences it. A column holding
 * `openstreetmap` names no foreign record, so there is nothing here that can
 * point at the wrong continent. The question a name row has to answer is "which
 * source says this spelling", and it answers that with no dereferenceable claim
 * to get wrong.
 *
 * ## The default name is NOT here
 *
 * OpenStreetMap's bare `name` is the local-language name, its language is
 * usually unrecorded, and it is `places.name`. Every row in this table carries
 * a real language tag, so `language` is NOT NULL and there is no "which row is
 * the default" question to answer with a partial index.
 */
export const placesNames = pgTable(
  'places_names',
  {
    id: generatedId(),
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    /**
     * Canonical BCP 47, as `normalizeLanguageTag` produces it: the `xx` of
     * OpenStreetMap's `name:xx`, lower-cased language, Titlecase script,
     * UPPER region.
     *
     * The CHECK below is built from the SAME pattern the contract publishes, so
     * a tag the HTTP layer accepts is a tag this column accepts. Without a
     * canonical form `es`, `ES` and `es ` are three rows under the unique key
     * below, and a re-import adds a fourth instead of refreshing the first.
     */
    language: text().notNull(),
    name: text().notNull(),
    /**
     * `lower(btrim(name))`, GENERATED — the only form of a translated name
     * that reconciliation is allowed to compare, for the reasons the identical
     * column on `places` gives.
     *
     * What it feeds is `proximity_and_translated_name` and nothing else. It is
     * never compared against `places.name_normalized` in a way that changes
     * what `proximity_and_name` means.
     */
    nameNormalized: text().generatedAlwaysAs(() => sql.raw('lower(btrim(name))')),
    /** `openstreetmap`, `goway`, or another registered source key. */
    source: text().notNull(),
    /**
     * When this source last stated this spelling — the freshness half of
     * provenance, and the guard that makes a re-import idempotent in both
     * directions. The upsert in `placesRepository` refuses to move a name
     * BACKWARD in time, so replaying an old planet export is a no-op rather
     * than a regression.
     */
    observedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** Explicitly named: the derived name would exceed the 63-byte identifier limit. */
    unique('places_names_language_source_key').on(table.placeId, table.language, table.source),
    index('places_names_place_idx').on(table.placeId),
    /**
     * Cross-language duplicate detection reads this, and a future free-text
     * search over GoWay's own names reads it for exact and prefix matches. A
     * trigram index for fuzzy matching is the search issue's decision, not
     * this one's — it needs `pg_trgm` in `REQUIRED_EXTENSIONS`, and an
     * extension added speculatively is one nobody can remove.
     */
    index('places_names_name_normalized_idx').on(table.nameNormalized),
    check('places_names_language_tag_check', sql`${table.language} ~ '${sql.raw(LANGUAGE_TAG_SQL_PATTERN)}'`),
    check('places_names_name_not_blank_check', sql`btrim(${table.name}) <> ''`),
    check('places_names_source_not_blank_check', sql`btrim(${table.source}) <> ''`),
  ],
);

/**
 * A source's own statement of a place, versioned.
 *
 * `tags` is EVERYTHING the source said, raw — every OpenStreetMap tag, not the
 * fourteen GoWay happened to map when the row was written — so a mapping added
 * next year can be applied to what is already stored instead of waiting for a
 * re-import. `normalized` is what GoWay read from it, in the form it went into
 * the columns: the import's three-way merge compares the column against it to
 * tell a GoWay correction from an unchanged source fact.
 *
 * `v` is the shape's version. A reader that meets a version it does not know
 * treats the row as having no previous statement, which makes the merge fill
 * gaps and change nothing else — the safe direction.
 */
export interface PlaceSourceData {
  v: 2;
  tags: Record<string, string>;
  normalized: Record<string, unknown>;
}

/**
 * Every source a place reconciles against.
 *
 * Provenance is a ROW, not a column, and it is never destructively overwritten:
 * a later refresh of the same source updates that source's own row while every
 * other source's row, and GoWay's own enrichment on `places`, stays exactly as
 * it was. That is the whole of "do not overwrite a source fact" as a schema
 * property rather than a convention.
 *
 * `(source, source_id)` is UNIQUE ACROSS the table, which is what makes source
 * linking deterministic: one external record belongs to at most one GoWay
 * place, so a second place claiming it is a collision the importer must
 * resolve — as a duplicate CANDIDATE — instead of a silent second copy.
 */
export const placesSources = pgTable(
  'places_sources',
  {
    id: generatedId(),
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    /** `openstreetmap`, `goway`, or another registered source key. */
    source: text().notNull(),
    /** The identifier this source uses, verbatim. A foreign system's key: no FK. */
    sourceId: foreignServiceId().notNull(),
    /**
     * When this source last CONFIRMED the record — the freshness half of
     * provenance. Monotonic by construction in `placesRepository`: a late-
     * arriving older observation must not make a record look staler than it is.
     */
    observedAt: timestamptz().notNull().defaultNow(),
    /**
     * What this source said, as it said it and as GoWay read it — see
     * {@link PlaceSourceData}. Deliberately not merged into `places`: keeping
     * the source's own version beside GoWay's lets a later reconciliation see
     * what changed upstream instead of guessing which side a differing value
     * came from. Null for a source linked through the API, which states no
     * facts of its own.
     */
    sourceData: jsonb().$type<PlaceSourceData>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /**
     * A named `unique()` CONSTRAINT rather than a `uniqueIndex()`, and the
     * distinction is load-bearing: a foreign key may target a unique constraint
     * or a primary key, never a unique index, and pointing one at an index
     * raises `42830` at apply time. `places_capabilities.place_source_id`
     * targets this table's primary key today; a future reference to the source
     * pair would work against this.
     */
    unique('places_sources_source_record_key').on(table.source, table.sourceId),
    index('places_sources_place_idx').on(table.placeId),
    check('places_sources_source_not_blank_check', sql`btrim(${table.source}) <> ''`),
    check('places_sources_source_id_not_blank_check', sql`btrim(${table.sourceId}) <> ''`),
  ],
);

/**
 * One asserted capability of a place, in a namespaced key space.
 *
 * `payments.faircoin` + `accepted`, `commerce.mercaria` + `store`,
 * `mobility.moovo` + `pickup`. A new Oxy product adds rows, never columns and
 * never a table — which is the requirement that "capabilities support FairCoin
 * and future Oxy products without schema forks" actually cashes out to.
 *
 * ## Uniqueness includes the VERIFICATION tier, on purpose
 *
 * `(place, namespace, capability, verification)` rather than
 * `(place, namespace, capability)`. A community report and an Oxy-verified fact
 * about the same capability are different assertions with different weight, and
 * collapsing them means the first community report to arrive after a
 * verification silently demotes a verified fact — or, worse, that an
 * `oxy_verified` write erases the community history that justified checking.
 * Both rows coexist; the read model publishes both with their provenance, and a
 * consumer that only wants facts it can act on filters on `verification`.
 *
 * `observed_at` is what makes freshness legible: a two-year-old community
 * report is not a current fact, and a client cannot tell without the date.
 */
export const placesCapabilities = pgTable(
  'places_capabilities',
  {
    id: generatedId(),
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    /** e.g. `payments.faircoin` */
    namespace: text().notNull(),
    /** e.g. `accepted` */
    capability: text().notNull(),
    /**
     * `<namespace>.<capability>`, GENERATED.
     *
     * The public contract requires `key === namespace + '.' + capability` and
     * the SDK's parser REJECTS a response where they disagree. Generating it
     * means no write path can produce that disagreement, and it gives the
     * capability filter a single indexed column to match rather than a
     * two-column predicate every caller would have to know how to spell.
     */
    key: text().generatedAlwaysAs(() => sql.raw("namespace || '.' || capability")),
    /**
     * The value, typed by the key's entry in the contract's capability
     * registry: a flag, an enum value, an enum SET (an array of strings), a
     * number, a URL or a text. jsonb so each round-trips to the contract
     * without a discriminator column and without `'true'` and `true` becoming
     * indistinguishable. Which shape a key takes is validated at every write;
     * this column only bounds the jsonb types.
     */
    value: jsonb().notNull().$type<CapabilityValue>(),
    verification: text().notNull(),
    observedAt: timestamptz().notNull().defaultNow(),
    /**
     * The source record that asserted this, when it came from outside GoWay.
     *
     * `set null` rather than `cascade`: unlinking a source is not a reason to
     * forget that the capability was once asserted, and the row keeps its
     * `verification` and `observed_at` either way.
     */
    placeSourceId: text().references(() => placesSources.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('places_capabilities_verification_check', table.verification, CAPABILITY_VERIFICATIONS),
    /**
     * A namespace may contain dots (`payments.faircoin`); a capability may not.
     * Otherwise `namespace || '.' || capability` would be ambiguous and two
     * different rows could generate the same `key`.
     */
    check('places_capabilities_namespace_shape_check', sql`${table.namespace} ~ '^[a-z0-9_-]+([.][a-z0-9_-]+)*$'`),
    check('places_capabilities_capability_shape_check', sql`${table.capability} ~ '^[a-z0-9_-]+$'`),
    check(
      'places_capabilities_value_type_check',
      sql`jsonb_typeof(${table.value}) in ('boolean', 'string', 'number', 'array')`,
    ),
    /**
     * An `external_source` assertion has to NAME the source it came from.
     * Without this the weakest-looking provenance tier is also the one that can
     * be written with no evidence attached at all.
     */
    check(
      'places_capabilities_external_source_check',
      sql`${table.verification} <> 'external_source' or ${table.placeSourceId} is not null`,
    ),
    /** Explicitly named: the derived name would exceed Postgres's 63-byte identifier limit. */
    unique('places_capabilities_assertion_key').on(
      table.placeId,
      table.namespace,
      table.capability,
      table.verification,
    ),
    /** What `?capabilities=payments.faircoin.accepted` matches against. */
    index('places_capabilities_key_idx').on(table.key),
    index('places_capabilities_place_idx').on(table.placeId),
  ],
);

/**
 * A claimed relationship between an Oxy account and a place.
 *
 * A LIST of claims rather than an `owner_id`, because a place and a business are
 * related but distinct: a franchise location is operated by one account under
 * another's brand, a shared venue has several operators, and a management
 * company is neither owner nor brand. Each of those is a row here and none of
 * them is representable in a single ownership column.
 *
 * The account is usually an Oxy ORGANIZATION, and Oxy — not this table — says
 * who may act for it: whoever has switched into it, or a member holding an
 * `owner`, `admin` or `editor` role (`places/claimAuthority`). There is no
 * member list here and there must never be one. A chain is an organization
 * claiming each of its locations in the `brand` role; nothing else groups them.
 *
 * `state` is separate from `role` deliberately. A PENDING owner claim is not
 * ownership, and a schema that cannot say so grants control at the moment
 * somebody asks for it.
 */
export const placesClaims = pgTable(
  'places_claims',
  {
    id: generatedId(),
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    /** The claiming Oxy account, usually an organization. Oxy owns identity: no FK. */
    oxyAccountId: foreignServiceId().notNull(),
    role: text().notNull(),
    state: text().notNull().default('pending'),
    claimedAt: timestamptz().notNull().defaultNow(),
    /** When the claim left `pending`. Null while it has not. */
    decidedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('places_claims_role_check', table.role, PLACE_CLAIM_ROLES),
    closedSet('places_claims_state_check', table.state, PLACE_CLAIM_STATES),
    check(
      'places_claims_decided_at_check',
      sql`(${table.state} = 'pending') = (${table.decidedAt} is null)`,
    ),
    unique('places_claims_account_role_key').on(table.placeId, table.oxyAccountId, table.role),
    index('places_claims_place_state_idx').on(table.placeId, table.state),
    index('places_claims_account_idx').on(table.oxyAccountId),
    /** The moderation queue: claims in one state, oldest first. */
    index('places_claims_state_claimed_idx').on(table.state, table.claimedAt),
  ],
);

/**
 * Two places that MIGHT be the same place.
 *
 * A queue entry, not a decision. Reconciliation writes rows here and merges
 * nothing: a merge is not reversible from the outside, and the cost of a false
 * positive in an automatic merger is two real businesses collapsed into one
 * record that a deep link, a claim and a capability all now point at wrongly.
 *
 * The pair is stored in a canonical order (`place_id < candidate_place_id`)
 * so one pair is one row regardless of which side detection started from —
 * without it, A/B and B/A are two rows and the unique constraint below protects
 * nothing.
 */
export const placesDuplicateCandidates = pgTable(
  'places_duplicate_candidates',
  {
    id: generatedId(),
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    candidatePlaceId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    reason: text().notNull(),
    /** Detector confidence in [0, 1], when the detector produces one. */
    score: doublePrecision(),
    state: text().notNull().default('open'),
    decidedAt: timestamptz(),
    /** The reviewer. An Oxy user id: no FK. */
    decidedByOxyUserId: foreignServiceId(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('places_duplicates_reason_check', table.reason, DUPLICATE_CANDIDATE_REASONS),
    closedSet('places_duplicates_state_check', table.state, DUPLICATE_CANDIDATE_STATES),
    check(
      'places_duplicates_pair_order_check',
      sql`${table.placeId} < ${table.candidatePlaceId}`,
    ),
    check(
      'places_duplicates_score_range_check',
      sql`${table.score} is null or ${table.score} between 0 and 1`,
    ),
    /** Explicitly named: the derived name would exceed the 63-byte identifier limit. */
    unique('places_duplicates_pair_key').on(table.placeId, table.candidatePlaceId),
    /** The moderation queue: candidates in one state, oldest first. */
    index('places_duplicates_state_idx').on(table.state, table.createdAt),
    index('places_duplicates_candidate_idx').on(table.candidatePlaceId),
  ],
);

/**
 * One write to a place: what changed, through which door, and as whom.
 *
 * APPEND-ONLY. Every write path in `db/places` records exactly one row here in
 * the SAME transaction as the write, so history and state cannot disagree: a
 * write that rolled back left no revision, and a revision always describes a
 * write that committed. Nothing in this package updates or deletes a row; the
 * repository exposes an insert and two reads, and that is the whole API.
 *
 * ## Who, and why it is two columns
 *
 * `oxy_account_id` is the account the write was made AS — `req.userId`, which is
 * an organization when a person switched into one. `operated_by_oxy_user_id` is
 * the PERSON, from Oxy's actor chain (`getOxyActor`); null when Oxy did not
 * report one, which is recorded as unknown rather than guessed. Both are Oxy
 * ids: no foreign key. Neither is ever published — the public history says
 * what changed and when, never who (`@goway/contracts` `revision.ts`).
 *
 * `changes` is a field-level diff in the published shape, never a row dump: a
 * column added to `places` cannot reach the history by being spread into it.
 */
export const placeRevisions = pgTable(
  'place_revisions',
  {
    id: generatedId(),
    /** `cascade`: a place is never deleted by any API path, and its history goes with it if it ever is. */
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    action: text().notNull(),
    source: text().notNull(),
    /** The account the write was made as. An Oxy id: no FK, never published. */
    oxyAccountId: foreignServiceId().notNull(),
    /** The person who made it, when Oxy reported one. An Oxy user id: no FK, never published. */
    operatedByOxyUserId: foreignServiceId(),
    changes: jsonb().notNull().$type<PlaceRevisionChange[]>(),
    createdAt: createdAt(),
  },
  (table) => [
    closedSet('place_revisions_action_check', table.action, PLACE_REVISION_ACTIONS),
    closedSet('place_revisions_source_check', table.source, PLACE_REVISION_SOURCES),
    check('place_revisions_changes_array_check', sql`jsonb_typeof(${table.changes}) = 'array'`),
    /** A place's history, newest first — the only order it is read in. */
    index('place_revisions_place_created_idx').on(table.placeId, table.createdAt, table.id),
  ],
);

/**
 * A signed-in person's report that something about a place is wrong.
 *
 * Reports never change a place by themselves — an operator decides, and the
 * decision is a revision of its own. The reporter and the note are never
 * published: an operator reads the note, nobody reads the reporter.
 */
export const placeReports = pgTable(
  'place_reports',
  {
    id: generatedId(),
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    /** The reporter. An Oxy user id: no foreign key, never published. */
    reporterOxyUserId: foreignServiceId().notNull(),
    reason: text().notNull(),
    note: text(),
    createdAt: createdAt(),
    resolvedAt: timestamptz(),
    resolution: text(),
    /** The operator who resolved it. An Oxy user id: no foreign key, never published. */
    resolvedByOxyUserId: foreignServiceId(),
  },
  (table) => [
    closedSet('place_reports_reason_check', table.reason, PLACE_REPORT_REASONS),
    check(
      'place_reports_resolution_check',
      sql`${table.resolution} is null or ${table.resolution} in (${sql.raw(inList(PLACE_REPORT_RESOLUTIONS))})`,
    ),
    /** Resolved means all three: when, how, and by whom. Open means none of them. */
    check(
      'place_reports_resolved_check',
      sql`(${table.resolvedAt} is null) = (${table.resolution} is null) and (${table.resolvedAt} is null) = (${table.resolvedByOxyUserId} is null)`,
    ),
    check('place_reports_note_check', sql`${table.note} is null or char_length(${table.note}) <= 500`),
    /** One open report per reporter per place: a repeat answers the existing one. */
    uniqueIndex('place_reports_open_key')
      .on(table.placeId, table.reporterOxyUserId)
      .where(sql`${table.resolvedAt} is null`),
    /** The moderation queue, oldest first, in either state. */
    index('place_reports_queue_idx').on(table.createdAt, table.id),
  ],
);

/**
 * A dated exception to a place's weekly hours: closed, or open on special
 * hours, for every day from `starts_on` to `ends_on` inclusive.
 *
 * A row rather than a jsonb list on `places`, for the reason
 * `places_capabilities` is a table: an exception is a CLAIM. "Closed on the
 * 26th" said by the business and the same thing reported by a passer-by are
 * two assertions with different weight, so each carries the verification tier
 * and freshness a capability does, and the unique key includes the tier — a
 * community report lands BESIDE the business's own and never overwrites it.
 * Readers take the strongest tier for a date (`openingStatusAt`).
 *
 * Dates, not instants: an exception is said in the place's own calendar, and
 * `places.timezone` is how it is read.
 *
 * Mercaria's `location_closures` is the same fact for a pickup location; once
 * Mercaria reads hours from GoWay it is this table.
 */
export const placeHoursExceptions = pgTable(
  'place_hours_exceptions',
  {
    id: generatedId(),
    placeId: text()
      .notNull()
      .references(() => places.id, { onDelete: 'cascade' }),
    startsOn: date({ mode: 'string' }).notNull(),
    /** Inclusive: a one-day exception has `starts_on = ends_on`. */
    endsOn: date({ mode: 'string' }).notNull(),
    closed: boolean().notNull(),
    /** The special hours on each day of the range. Empty exactly when `closed`. */
    intervals: jsonb()
      .notNull()
      .$type<TimeRange[]>()
      .default(sql`'[]'::jsonb`),
    note: text(),
    /** `goway` for anything written through the API; the same key space as `places_sources.source`. */
    source: text().notNull(),
    verification: text().notNull(),
    observedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('place_hours_exceptions_verification_check', table.verification, CAPABILITY_VERIFICATIONS),
    check('place_hours_exceptions_range_check', sql`${table.startsOn} <= ${table.endsOn}`),
    check(
      'place_hours_exceptions_span_check',
      sql`${table.endsOn} - ${table.startsOn} < ${sql.raw(String(MAX_HOURS_EXCEPTION_DAYS))}`,
    ),
    check(
      'place_hours_exceptions_intervals_check',
      sql`jsonb_typeof(${table.intervals}) = 'array' and ${table.closed} = (jsonb_array_length(${table.intervals}) = 0)`,
    ),
    check('place_hours_exceptions_source_not_blank_check', sql`btrim(${table.source}) <> ''`),
    unique('place_hours_exceptions_range_key').on(table.placeId, table.startsOn, table.endsOn, table.verification),
    /** The single-place read asks for the exceptions that have not ended yet. */
    index('place_hours_exceptions_place_ends_idx').on(table.placeId, table.endsOn),
  ],
);
