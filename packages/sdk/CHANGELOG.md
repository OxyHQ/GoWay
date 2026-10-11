# Changelog

All notable changes to `@goway.to/sdk`. The package follows semantic versioning
with the 0.x rule: while the major version is 0, a MINOR release may break the
API or the contract, and a PATCH release never does.

## 0.4.0 — unreleased

Two changes to how GoWay names places' kinds. The place category taxonomy
moved out of the contract and into GoWay's database, where GoWay's moderators
edit it — new categories, labels in any language, OpenStreetMap mappings,
deprecations — without a release; the SDK no longer bundles a copy. And
GoWay's vocabulary labels come in Mercaria's twelve languages, with a locale
matched to one of them by BCP 47 rules instead of by its bare language. A
MINOR under the 0.x rule, and breaking for every consumer of the bundled
taxonomy.

### Added

- `places.update(id, { openingHoursDays })` replaces only explicitly named
  opening weekdays atomically; exported `OpeningHoursDayPatch` describes each
  replacement. Empty day intervals close that day. Unknown schedules require
  all seven days (`GoWayConflictError`); the entire merged week keeps the
  existing 64-interval limit. Deploy the matching API before consumers use
  this input. Full `openingHours` replacement/clear remains available and
  cannot be combined with day patches.

### Breaking

- **The bundled taxonomy is gone.** `CATEGORIES`, `CATEGORY_KEYS`,
  `CategoryKey`, `categoryOf`, `categoryLabel`, `categoryDescendants` and
  `isCategoryKey` are removed. Fetch the list with `categories.list()` and index
  it with `categoryTaxonomy(page.items)`, whose `of`, `label` and `descendants`
  replace them.
- **A category key is any well-formed dotted key client-side**
  (`CATEGORY_KEY_PATTERN`, at most `MAX_CATEGORY_KEY_LENGTH`). Membership is the
  server's question: a key that is not a category is `GoWayValidationError` from
  the API (`validation_failed`) on a write or a filter, and so is a `deprecated`
  key on a write that would add it to a place. A place already carrying a
  deprecated key keeps it, and a filter on it still finds that place.
- **`categories.list(options?)` is now `categories.list(query?, options?)`**,
  with `query.locale` (a BCP 47 tag, normalized like every `locale`).
- **`Category` gains `status`** (`active` | `deprecated`) **and `label`**, the
  label resolved for the requested locale by `localizedLabel`.
- **`LABEL_LANGUAGES` has twelve languages**: `en`, `ar`, `bn`, `ca`, `de`,
  `es`, `fr`, `hi`, `ja`, `pt-BR`, `ru` and `zh-Hans`, all canonical tags.
  `Labels` requires every one of them, so a `Labels` value built by hand needs
  all twelve.
- **`Category.labels` is `LocalizedLabels`**: `{ en: string; [tag]: string }`.
  English is always there and any other language may be, keyed by canonical
  tag. `es` is no longer a guaranteed key. Read a category's label with
  `localizedLabel(category.labels, locale)` rather than indexing it. The
  response schema is open, so a language GoWay adds later does not break
  parsing.
- **`localizedLabel` matches the whole locale.** Pass the reader's full tag,
  such as `zh-Hans-CN`, `pt-PT` or `es-MX`. The match order is: the exact tag,
  then the same language in a compatible script (the reader's region first,
  then no region, then another region), then the same language in another
  script, then English. `pt` and `pt-PT` read `pt-BR`. `zh`, `zh-CN` and
  `zh-SG` read `zh-Hans`. `zh-TW`, `zh-HK` and `zh-Hant` read `zh-Hans` until a
  `zh-Hant` label is offered, which then wins for them.

### Added

- `categoryTaxonomy` and `CategoryTaxonomy`: index a category list to look keys
  up, label them in a locale (English as the fallback; the key itself for an
  unknown one) and expand a parent to its descendants.
- `CATEGORY_STATUSES` and `CategoryStatus`, and `CategoryListQuery`.
- Constants for the shapes and limits the API enforces: `CATEGORY_KEY_PATTERN`,
  `OSM_TAG_PATTERN`, `MAX_CATEGORY_KEY_LENGTH`, `MAX_CATEGORY_LABEL_LENGTH`,
  `MAX_CATEGORY_OSM_TAGS`, `MAX_CATEGORY_POSITION`.
- Operator methods for the taxonomy on `moderation`: `categories` (every
  category with its position and OpenStreetMap mapping), `createCategory`,
  `updateCategory` (glyph, position, mapping, status — a key never changes; a
  rename is a new key and the old one deprecated), `setCategoryLabel` and
  `removeCategoryLabel` (English cannot be removed). Label tags in a path or a
  body are normalized before sending (`pt_br` → `pt-BR`). Types:
  `ModerationCategory`, `ModerationCategoryPage`, `CategoryCreateInput`,
  `CategoryUpdateInput`, `CategoryLabelInput`.
- `matchLanguageTag(offered, locale)`: the BCP 47 best match that
  `localizedLabel` uses, for labels you store yourself. It returns the offered
  tag as you spelled it, or `undefined` when nothing serves.
- The `LocalizedLabels` type.
- Capability keys, enum values and groups are labelled in all twelve
  languages. Brand names (FairCoin, Mercaria, Wikidata, WhatsApp, Instagram,
  X, TikTok, Facebook) are kept as they are. The translations other than
  English and Spanish are machine-authored and await native review
  (`docs/LABEL_TRANSLATIONS.md`).
- Categories are labelled in the same twelve languages, from GoWay's database:
  the category tables are seeded with them, and `categories.list()` publishes
  every language a category has.

## 0.3.0 — unreleased

The SDK now validates every request and parses every response with the
contract's own zod schemas — the ones the GoWay API validates with — instead of
hand-written copies, and follows the Oxy API conventions for lists, errors and
parameters (`~/Oxy/docs/api-conventions.md`). A MINOR under the 0.x rule, and
almost every part of it is breaking.

### Breaking

- **`zod` is a runtime dependency** (`^4.6.5`), imported rather than bundled, so
  a consumer that already uses zod 4 shares one copy. The package is no longer
  dependency-free. zod's own declarations name the global `URL` type, which
  Node's types, the DOM lib, React Native and Bun all provide.
- **The hand-written response parsers are gone.** Responses are parsed by the
  contract schemas; unknown keys are still stripped. An optional field that
  arrives as `null` is now a `GoWayResponseError` (it used to be read as
  absent): the contract says optional, not nullable. A malformed response's
  message is now `response.<path>: <expectation>`, and still never quotes a
  value.
- **Lists are pages, `{ items, nextCursor }`**, with opaque cursors:
  - `places.nearby` → `PlaceWithDistancePage` (was `PlaceWithDistance[]`);
  - `places.inBounds` → `PlacePage` (was `Place[]`);
  - `search.query` and every `geocode.*` → `SearchResults`, whose `results` is
    renamed **`items`** and which gains `nextCursor`;
  - `captures.sessions(query?)` → `CaptureSessionPage` (was the 50 most recent
    sessions as an array);
  - `captures.assets(sessionId, query?)` → `CaptureAssetPage` (was an array).

  Every list query takes `cursor` and `limit`. Pass a cursor back with the same
  filters; walk a whole list with `iterateGoWayPages`. The capture lists take
  their query FIRST, so their request options (`signal`) move to the last
  argument: `captures.sessions(query?, options?)`,
  `captures.assets(sessionId, query?, options?)`.
- **Inputs are validated client-side with the contract request schemas**, and
  the PARSED value is what is sent. A refusal is `GoWayValidationError` with
  `status: null`, a message of the form `query.<path>: <expectation>`, and no
  request sent. Concretely:
  - query parameters are strict: an unknown key is refused, not dropped;
  - a body drops keys the contract does not name (`id`, `verification`, a
    claim's `state` never leave the client) — except a scene report, whose
    contract is strict, so an unknown key there is refused;
  - `limit` is held to the contract maxima (`MAX_PLACE_LIST_LIMIT` 200,
    `SEARCH_MAX_LIMIT` 50, `MAX_CLAIM_LIST_LIMIT` 200,
    `MAX_CAPTURE_LIST_LIMIT` 100) instead of being left to the server, and the
    contract default limit is now sent explicitly on place, claim and capture
    lists;
  - `radiusMeters` is at most `MAX_RADIUS_METERS` (50 km), a bounds box or a
    search viewport spans at most `MAX_BOUNDS_SPAN_DEGREES` (90°), a search
    `query` is at most 256 characters, and `waypoints` at most `MAX_WAYPOINTS`
    (8);
  - **capability keys must be lower-case `<namespace>.<capability>`**, in a
    filter and in a path: `Payments.FairCoin.Accepted` is refused rather than
    matching nothing;
  - values are normalized: locale and name-language tags to their canonical
    spelling (`ES` → `es`, `zh_hant` → `zh-Hant`), country codes upper-cased,
    names and notes trimmed. A tag outside GoWay's BCP 47 subset is refused;
  - path parameters are checked by the contract's path schemas (a place id or
    capture id of at most 128 characters, a scene id of at most 64);
  - the client's `locale` option is normalized once and applied to every call
    that accepts one and names none, directions included.
- **`removed` is no longer a place status a caller can write or a published
  place can carry.** `PlaceCreateInput.status` / `PlaceUpdateInput.status` are
  `WritablePlaceStatus` (`active`, `closed`, `proposed`), `Place.status` is one
  of `PUBLISHED_PLACE_STATUSES`, and `places.get` of a removed place rejects with
  the new `GoWayGoneError` (410). `PlaceStatus` still names `removed`, as a
  stored state.
- **The capability filter requires a HOLDING value** (server-side): a place
  matches `capabilities: [key]` only when its strongest assertion of `key` is
  not `false`, `0` or `''`. A place whose business asserts `false` no longer
  matches because somebody once reported `true`. `placeHasCapability` applies
  the same rule client-side.
- **`captures.remove(assetId)` resolves with nothing** (the API answers `204`);
  it used to resolve with the withdrawn `CaptureAsset`.
- **`PlaceClaim` gains a required `placeId`** and an optional `decidedAt`.
- **A business is an Oxy organization; `brandId` is gone.** `PlaceClaim.brandId`
  and `PlaceClaimInput.brandId` are removed: a chain is an Oxy organization
  claiming each location in the `brand` role. `PlaceClaimInput` gains
  `oxyAccountId` — the account to claim FOR, usually the business's
  organization, which the caller must own or administer in Oxy; omitted, the
  claim is the signed-in account's own. Editing a claimed place, asserting at the
  business tier and reading its claims are open to whoever acts for the claiming
  account: the session that switched into it, or a member Oxy reports as
  `owner`, `admin` or `editor`.
- **Operations that ask Oxy about an organization can reject with
  `GoWayUnavailableError`** (`service_unavailable`, 503, retryable) when Oxy
  cannot answer: `places.update`, `places.capabilities.put`/`delete`,
  `places.hoursExceptions.create`/`replace`/`delete`,
  `places.claims.create`/`list` and `claims.list`. GoWay fails closed rather
  than guessing. A place nobody has claimed never needs the answer.
- **`PlaceStatus` gains `merged`**, a stored state like `removed`: a merged place
  is never published, and `places.get` of one rejects with `GoWayGoneError`
  whose new `mergedInto` is the id that replaces it.
- **Two new error classes**, both non-retryable: `GoWayGoneError` (`gone`, 410)
  and `GoWayUnknownRouteError` (`unknown_route`, 404 — this SDK and the API
  disagree about what routes exist; deliberately not a `GoWayNotFoundError`).
  A `rate_limited` 429 now arrives as a JSON error body, and
  `retryAfterSeconds` is read from its `details` first.
- **Renamed and removed exports.** `PlaceReadOptions` is now `PlaceReadQuery`.
  `PlaceCapabilityInput`, `PlaceCreateInput` and `PlaceUpdateInput` are no
  longer SDK-local: they are the contract's input types, so `PlaceCreateInput`
  gains `names`, its `status` narrows as above, and a written `source` is a
  `PlaceSourceRefInput` (`source` and `sourceId`; `observedAt` is the server's
  clock). `GoWayHttpMethod` adds `PUT`.
- **Categories are a closed taxonomy of dotted keys** (`food.cafe`,
  `shop.books`, `transport.rail_station`; `CATEGORY_KEYS`). `Place.categories`
  holds those keys only — the OpenMapTiles-style `cafe`/`food_drink` values the
  importer wrote are converted server-side — and a category in a write or a
  `categories` filter that is not in the taxonomy is refused client-side. A
  filter on a parent (`food`) matches every key below it, so a place no longer
  carries its ancestors.
- **Capability keys are a closed, typed registry** (`CAPABILITY_KEYS`).
  `WELL_KNOWN_CAPABILITIES` and `WellKnownCapability` are gone; `CapabilityKey`
  is now the union of registered keys. Each key declares its value kind
  (boolean, enum, enum set, integer, price level, URL, text) and every write —
  `capabilities.put` and a place body's `capabilities` — is held to it before
  anything is sent: an unregistered key or a value of the wrong kind is a
  `GoWayValidationError`. A value comes back normalized by its key (a social
  handle as its URL, an enum set in registry order). `CapabilityValue` widens
  to `boolean | string | number | string[]`.
- **`capabilityValueHolds(value)` is replaced by `capabilityHolds(key, value)`**:
  whether a value holds now depends on the key (`accessibility.wheelchair: 'no'`
  is an assertion that the place does NOT have it), and `[]` never holds.
- **`OpeningHours.timezone` is removed.** The zone is `Place.timezone`, which
  GoWay derives from the position and no caller can write; `openingHoursInput`
  no longer accepts one.
- The `capabilities` filter is a list of `key` or `key:value` strings
  (`'food.cuisine:italian'`), typed `string[]` rather than `CapabilityKey[]`.
- **`places.update` is a merge patch, down to the parts of `address` and
  `contact`.** A part left out is now UNTOUCHED — `contact: { phone }` used to
  clear the email and the website, and now keeps them — and `null` clears:
  `contact: { phone: null }`, `address: { houseNumber: null }`, or the whole
  `address: null` / `contact: null`, as well as `description`, `logoFileId`,
  `coverFileId`, `geometry` and `openingHours`. `name`, `location`, `status`
  and `categories` refuse `null` (`categories: []` clears the list), and
  `timezone` is not writable at all. `PlaceUpdateInput.address` is a
  `StructuredAddressPatch` and `.contact` a `PlaceContactPatch`. A value
  cleared this way that OpenStreetMap supplied stays cleared on the next
  import, until OpenStreetMap's value changes.
- **Approving a claim re-tiers what the claimant said while it was pending.**
  A `community_reported` capability or hours exception whose latest statement
  was made after the claim was filed, by the claimant account itself or by
  the person who filed the claim, becomes `business_asserted` in the same
  transaction — unless the business tier already holds that key or those
  dates. Another member who spoke as themselves is not re-tiered and
  re-asserts once the claim is approved. Each re-tier is a public
  `capability_retiered` or `hours_exception_retiered` revision (new values of
  `PLACE_REVISION_ACTIONS`), whose one change goes from the community row to
  the same statement at the business tier, `observedAt` unchanged.

### Added

- 360° captures (OxyHQ/GoWay#91): `CaptureAssetInput.projection` declares an
  `equirectangular` photo or video, `CaptureAsset.projection` reports the
  declaration (`perspective` when a server sends none), and
  `CaptureUploadPolicy.equirectangular` carries the 360° size, duration and
  resolution limits when the deployment accepts such media.
  `CAPTURE_PROJECTIONS`, `CaptureProjection` and
  `CaptureEquirectangularPolicy` are exported.
- `places.getMany(placeIds, options?)` → `PlaceBatch` (`GET /places?ids=`):
  up to `MAX_PLACE_BATCH_SIZE` (50) places in one request. Every id lands in
  exactly one of `items` (each place exactly as `places.get` answers it),
  `gone` (`{ id, mergedInto? }` — what `get` rejects with `GoWayGoneError`)
  and `missing` (what it rejects with `GoWayNotFoundError`), in the order you
  named them; repeats collapse. More ids than the maximum is a
  `GoWayValidationError` before anything is sent.
- `claims.list({ placeId })` — one account's claims on one place.
- A text capability key filters by its exact value:
  `'commerce.mercaria.store:<locationId>'`, `'brand.wikidata:Q42'`, through
  the strongest assertion like every other value filter
  (`placeMatchesCapabilityFilter` agrees). The value is held to the key's own
  schema and may not contain a comma.
- Exports `MAX_PLACE_BATCH_SIZE` and the types `PlaceBatch`, `PlaceBatchGone`,
  `PlaceBatchQuery`, `StructuredAddressPatch` and `PlaceContactPatch`.

- `places.capabilities.put(placeId, key, assertion)` → `Place`, and
  `places.capabilities.delete(placeId, key)` → nothing (`204`).
- `places.claims.create(placeId, input)` → `PlaceClaim`,
  `places.claims.list(placeId, query?)` → `PlaceClaimPage`, and the new
  `claims` namespace with `claims.list(query?)` → `PlaceClaimPage` — the
  signed-in account's claims, or with `oxyAccountId` an organization's.
- `places.revisions(placeId, query?)` → `PlaceRevisionPage`: a place's public
  history, newest first — what changed and when, as field-level
  `{ field, before?, after? }` changes. It never names an account or a person,
  and never lists a claim, report or duplicate review. Needs no account. An
  hours-exception write is history too: `hours_exception_created`,
  `hours_exception_replaced` and `hours_exception_withdrawn` are public
  actions whose change is `hoursExceptions.<id>`, and a move that changes the
  derived `timezone` lists it.
- `places.report(placeId, input)` → `PlaceReport`: report a place to moderation
  with a reason from `PLACE_REPORT_REASONS` and an optional note that only
  operators read. Repeating it while your report is open resolves with that
  same report.
- `GoWayGoneError.mergedInto` — the id a merged place now lives at, or `null`
  for a place removed outright.
- The `moderation` namespace — `claims`, `decideClaim`, `updatePlace`,
  `verifyCapability`, `withdrawVerifiedCapability`, `revisions`, `duplicates`,
  `resolveDuplicate`, `reports`, `resolveReport` — for GoWay's own operators.
  Every call needs a session whose person is on the deployment's operator
  allow-list and rejects with `GoWayForbiddenError` for anybody else.
  `verifyCapability` holds its value to the key's registry entry, as
  `places.capabilities.put` does, before anything is sent. It ships
  in the SDK so GoWay's tools are built on the same contract; no integration
  needs it.
- `iterateGoWayPages(fetchPage)` — an async iterator over every item of a list,
  which throws `GoWayResponseError` if the server ever repeats a cursor.
- `places.create` / `places.update` accept every field of the contract input,
  `names` included.
- Exports: the value sets `WRITABLE_PLACE_STATUSES`, `PUBLISHED_PLACE_STATUSES`,
  `RETENTION_CLASSES`, `CAPTURE_LOCATION_ORIGIN_RANK`,
  `CAPTURE_CONTENT_HASH_ALGORITHM`, `STRUCTURED_GEOCODE_FIELDS` (beside the ones
  already exported); the limits `MAX_PLACE_LIST_LIMIT`,
  `DEFAULT_PLACE_LIST_LIMIT`, `MAX_RADIUS_METERS`, `MAX_BOUNDS_SPAN_DEGREES`,
  `MAX_CLAIM_LIST_LIMIT`, `DEFAULT_CLAIM_LIST_LIMIT`, `MAX_CAPTURE_LIST_LIMIT`,
  `DEFAULT_CAPTURE_LIST_LIMIT`, `SEARCH_MAX_LIMIT`, `SEARCH_MAX_DEPTH`,
  `MAX_SEARCH_QUERY_LENGTH`, `MAX_WAYPOINTS`, `MAX_CURSOR_LENGTH`,
  `MAX_LANGUAGE_TAG_LENGTH`; the helpers `placeHasCapability`,
  `strongestCapability`, `splitCapabilityKey` and
  `boundingBoxWidth`; and the types `Page`, `PlacePage`,
  `PlaceWithDistancePage`, `PlaceClaimPage`, `CaptureSessionPage`,
  `CaptureAssetPage`, `PlaceCapabilityAssertion`, `PlaceClaimInput`,
  `PlaceNameInput`, `PlaceSourceRefInput`, `WritablePlaceStatus`,
  `CapabilityValue`, `ClaimListQuery`, `CaptureListQuery`, `ApiErrorDetails`,
  the remaining capture types and the `GoWayPlaceCapabilitiesApi`,
  `GoWayPlaceClaimsApi`, `GoWayClaimsApi`, `GoWayModerationApi` and
  `GoWayPageLike` interfaces; and for revisions, reports and moderation the
  value sets `PLACE_REVISION_ACTIONS`, `PLACE_REVISION_VISIBILITY`,
  `PUBLIC_PLACE_REVISION_ACTIONS`, `PLACE_REVISION_SOURCES`,
  `PLACE_REPORT_REASONS`, `PLACE_REPORT_RESOLUTIONS`, `PLACE_REPORT_STATES`,
  `CLAIM_DECISION_STATES`, `CLAIM_DECISION_FROM`, `DUPLICATE_CANDIDATE_REASONS`,
  `DUPLICATE_CANDIDATE_STATES`, `MODERATED_PLACE_STATUSES` and
  `GONE_MERGED_INTO_DETAIL`, their limits, and their types.
- The whole route registry is covered: a unit test holds every operation the
  API publishes to an SDK method.
- Place data: `Place.timezone` (IANA, derived from the position) and
  `Place.hoursExceptions` (dated closures and special hours that have not
  ended, on every place read — `places.get`, `places.getMany`, `places.nearby`
  and `places.inBounds` — so open-now is right on a list too; `[]` when none).
- `openingStatusAt(place, now?)` → `OpeningStatus`: `open`/`closed`/`unknown`,
  today's local date, the next change as an instant and as the place's own
  clock reads it, and the exception deciding today. The same evaluation the
  GoWay API and app use; it answers `unknown` without a zone rather than
  guessing one.
- `places.hoursExceptions.list|create|replace|delete` over
  `/places/{placeId}/hours-exceptions`, with the capability authority rules:
  the tier is derived, a caller rewrites only their own tier's exception, and
  only whoever acts for an approved claimant withdraws one. A merged place's
  exceptions move to the place that absorbed it, unless that place already
  holds one for the same dates at the same tier.
- `categories.list()` → `CategoryPage` (`GET /categories`), and the bundled
  taxonomy: `CATEGORIES`, `CATEGORY_KEYS`, `CATEGORY_ICONS`, `categoryLabel`,
  `categoryOf`, `categoryParent`, `categoryRoot`, `categoryDescendants`, `isCategoryKey`.
- The capability registry's public half: `CAPABILITY_KEYS`,
  `CAPABILITY_GROUPS`, `CAPABILITY_VALUE_KINDS`, `capabilityLabel`,
  `capabilityValueLabel`, `capabilityGroupLabel`, `capabilityGroupOf`,
  `capabilityValueKind`, `isCapabilityKey`, `capabilityHolds` and
  `placeMatchesCapabilityFilter`.
- `LABEL_LANGUAGES` and `localizedLabel` — every label is English and Spanish,
  with English as the fallback.
- Types `Category`, `CategoryKey`, `CategoryIcon`, `CategoryPage`,
  `CapabilityGroup`, `CapabilityValueKind`, `PlaceHoursException`,
  `PlaceHoursExceptionInput`, `PlaceHoursExceptionPage`, `HoursExceptionListQuery`,
  `TimeRange`, `OpeningStatus`, `OpeningChange`, `OpeningFacts`, `Labels`,
  `LabelLanguage`, and the `GoWayCategoriesApi` and
  `GoWayPlaceHoursExceptionsApi` interfaces.
- **Place galleries** — `places.media.list|add|remove|reorder|report` over
  `/places/{placeId}/media`. An item is an Oxy FILE ID: upload the image with
  the Oxy SDK (`oxy.assets.upload(file, { visibility: 'public' })`), pass its id
  to `places.media.add`, and render items with
  `oxy.assets.publicUrl(item.fileId, variant)`. GoWay checks with Oxy, on your
  session, that the file is a public, active image you own and links it to the
  place; it never serves image bytes. `add` rejects with `GoWayForbiddenError`
  for somebody else's file, `GoWayValidationError` for a private, trashed or
  non-image one, `GoWayConflictError` for a file already in the gallery, and
  `GoWayUnavailableError` when Oxy cannot be asked. Kinds are
  `PLACE_MEDIA_KINDS` (`photo`, `logo`, `cover`, `menu`, `interior`,
  `exterior`); `logo` and `cover` on a claimed place are the business's.
  `remove` is the contributor's or the business's, `reorder` the business's.
- **Reviews** — `places.reviews.list|mine|put|delete|reply|deleteReply|report`
  over `/places/{placeId}/reviews`. One review per person, written and
  rewritten with `put` (1–5, optional title, body and locale) and withdrawn
  with `delete`, which erases its words. `list` takes `sort`: `newest`
  (default), `highest` or `lowest`. A session switched into an organization,
  and anybody with any role in an organization holding an approved claim on
  the place, is refused with `GoWayForbiddenError`; the business answers with
  `reply` instead, published without naming who wrote it. A review carries its
  author's Oxy user id (`authorOxyUserId`) to resolve to their public profile.
- **The place profile**: `Place.description` (the default-language one),
  `Place.descriptions` and `Place.localizedDescription` (single-place and batch
  reads only, absent from lists like `names`), `Place.logoFileId` and
  `Place.coverFileId` (Oxy files of visible `logo`/`cover` gallery items), and
  `Place.rating` — `{ average, count }` over the published reviews, derived on
  every review write, absent until the first. `PlaceCreateInput` gains
  `description` and `descriptions` (`{ language, description }`, `null`
  withdrawing a language); `PlaceUpdateInput` also gains `logoFileId` and
  `coverFileId` (`null` clears).
- Reports about one item: `places.media.report` and `places.reviews.report`
  take a `ContentReportInput` with a reason from `CONTENT_REPORT_REASONS`, and
  `PlaceReport` gains optional `mediaId` and `reviewId`. `PLACE_REPORT_REASONS`
  gains `not_this_place` and `conflict_of_interest`.
- Moderation: `moderation.media|moderateMedia` (list a gallery in any state,
  hide or restore an item), `moderation.reviews|moderateReview` (list reviews
  in any status, hide or restore one) and `moderation.removeReviewReply`.
- Revision actions `media_added`, `media_removed` and `media_reordered`
  (public) and `media_hidden`, `media_restored` and the `review_*` actions
  (moderation only). No revision carries an Oxy file id or a review's words.
- Exports: the value sets and limits `PLACE_MEDIA_KINDS`,
  `BUSINESS_MEDIA_KINDS`, `PLACE_MEDIA_STATES`, `MODERATED_PLACE_MEDIA_STATES`,
  `PLACE_MEDIA_MIME_TYPES`, `MAX_MEDIA_CAPTION_LENGTH`, `MAX_MEDIA_ORDER_LENGTH`,
  `MAX_MEDIA_LIST_LIMIT`, `DEFAULT_MEDIA_LIST_LIMIT`, `PLACE_REVIEW_STATUSES`,
  `MODERATED_PLACE_REVIEW_STATUSES`, `REVIEW_SORTS`, `MIN_REVIEW_RATING`,
  `MAX_REVIEW_RATING`, `MAX_REVIEW_TITLE_LENGTH`, `MAX_REVIEW_BODY_LENGTH`,
  `MAX_REVIEW_REPLY_LENGTH`, `MAX_REVIEW_LIST_LIMIT`, `DEFAULT_REVIEW_LIST_LIMIT`,
  `CONTENT_REPORT_REASONS` and `MAX_DESCRIPTION_LENGTH`; the types for every
  shape above; and the `GoWayPlaceMediaApi` and `GoWayPlaceReviewsApi`
  interfaces.

## 0.2.0 — unreleased

- Add the typed `captures` namespace for policy, sessions, registration, upload
  finalization, contribution history and withdrawal.
- Registration accepts an idempotency key so clients can retry the same intent.
- Upload tickets describe direct, checksum-bound object storage requests. The
  SDK never forwards account credentials or media bytes to object storage.

## 0.1.1 — unreleased

A PATCH, and the version number is the claim: nothing in 0.1.0 changed meaning,
nothing was removed, and a consumer on 0.1.0 keeps working against a server that
has this change (OxyHQ/GoWay#61).

In particular `Place.name` is exactly what it was — the place's DEFAULT,
local-language name — and it does not move with the new `locale` parameter. A
field whose meaning depended on a query parameter would make one cached `Place`
mean different things to different holders of it, so the resolved answer is a
second field instead.

### Added

- `Place.names` — every language GoWay holds a name for the place in, each with
  its own provenance. Carried by `places.get` and by search results; ABSENT from
  `places.nearby` and `places.inBounds`, where every language of every pin is a
  payload nothing renders. Absent is not empty, as with `Place.claims`.
- `Place.localizedName` — the name for the locale the call asked for, present
  only when one exists. GoWay resolves it: requested tag → bare language →
  another variety of that language, and a GoWay correction outranks a source's
  spelling at every step.
- `placeDisplayName(place)` — `localizedName` if there is one, `name` otherwise.
  The one expression every consumer should render, published so nobody has to
  restate the fallback and quietly get it wrong.
- `locale` on `places.nearby` and `places.inBounds`, and a `locale` option on
  `places.get`. The client's own `locale` now applies to all three; before this
  release it reached search, geocoding and routing only.
- `normalizeLanguageTag`, `baseLanguageTag` and `LANGUAGE_TAG_PATTERN` — the
  canonical BCP 47 subset GoWay stores names under, so a consumer can key a
  cache the same way the server does.
- `PlaceName`, `PlaceReadOptions` and `GoWayPlaceReadOptions` types.

## 0.1.0 — unreleased

First release — the headless integration boundary GoWay's own frontend and
every consuming Oxy app use from now on (OxyHQ/GoWay#3), and the surface the
FairCoin merchant-discovery reference integration is built on
(OxyHQ/GoWay#8).

### Added

- `createGoWayClient` for Node 18+, Bun, browsers and React Native, with no
  runtime dependencies. ESM and CommonJS builds with bundled type declarations.
- Anonymous reads by default — the map, search and routing all work signed out.
  Identity-bound calls take an Oxy access token through `getAccessToken`, which
  is called before every request and never cached, stored or logged.
- Places: `places.get`, `places.nearby`, `places.inBounds`, `places.create`,
  `places.update`, with the generic typed capability filter
  (`capabilities: ['payments.faircoin.accepted']`).
- Search and geocoding: `search.query`, `geocode.forward`, `geocode.reverse`,
  `geocode.structured`.
- Routing: `routes.directions`, with `no_route` and `unsupported_mode` surfaced
  as branchable domain answers rather than defects.
- Canonical links: `links.place` (`https://goway.to/place/<placeId>`) and
  `links.map`.
- A typed error hierarchy driven off the shared `API_ERROR_CODES` vocabulary,
  carrying a `Symbol.for` lineage brand so `instanceof` survives a process
  holding both the ESM and the CommonJS copy.
- Every domain type re-exported from GoWay's shared contracts, bundled so no
  consumer resolves a private workspace package.
