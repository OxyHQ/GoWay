# Places

Rules on top of the root and backend `AGENTS.md`.

- Every GoWay-enriched place gets a stable GoWay Place ID independent of provider IDs; deep links use it (`https://goway.to/place/<placeId>`). Preserve source provenance and never destructively overwrite a source fact.
- The OpenStreetMap import writes only `openstreetmap`-sourced rows, never deletes a place, and changes a `places` column only while it still holds what that source last said.
- The category taxonomy is data (`place_categories`, labels, OSM tags), edited via `/moderation/categories`; never put a copy in code. `places.categories` holds active keys (trigger-enforced), never an ancestor beside its child; keys are immutable. Note: `docs/PLACE_DATA.md`.
- A place attribute is a registered key in `CAPABILITY_DEFINITIONS` (value kind, labels, group, OSM tags) over `places_capabilities`, never a new column or table; every write goes through its key's schema.
- `places.timezone` is derived from the position (`places/timezone.ts`), never taken from a caller; evaluate hours only with the contract's `openingStatusAt`.
- Hours exceptions follow the capability authority rules: derived tier, rewrite at your own tier, claimant-only withdrawal.
- `PATCH /places` is a merge patch: absent leaves a field (or address/contact part) alone, `null` clears; the import refills a cleared column only once OSM's value changes.
- Approving a claim re-tiers only the claimant's own (or its filer's) community statements made since filing (`retierClaimantStatements`); never re-tier on a membership GoWay did not check with Oxy.
- The import's owned columns are declared once in `import/osm/fields.ts`; `source_data` is `{v:2, tags, normalized}` with every raw tag, and OSM attributes are `external_source` capabilities tied to the element's source row.
- `places.name` is the DEFAULT (local-language) name and never moves with a locale; every tagged name is a `places_names` row keyed `(place, language, source)`, resolved server-side and rendered via `placeDisplayName`. Design note: `docs/PLACE_NAMES.md`.
- A business is an Oxy organization: a claim stores its `oxyAccountId` and Oxy decides who acts for it (`places/claimAuthority`, asked with the caller's bearer). Never keep a member list or brand id; fail closed with 503 when Oxy cannot answer. Design note: `docs/BUSINESS_OWNERSHIP.md`.
- Every place write records exactly one `place_revisions` row through `recordRevision`, inside the write's transaction. The public history never names an account or person; classify a new action in `PLACE_REVISION_VISIBILITY`.
- Claim decisions, `oxy_verified`, removal and merges are moderation acts behind `MODERATION_OPERATOR_OXY_USER_IDS` (matched on the person); no public route may produce them.
- A place image is an Oxy file id: checked (owner, public, image) on the caller's bearer, referenced via `oxy/placeFiles` by GoWay's service token, not a session; no bytes kept. Design note: `docs/PLACE_MEDIA_REVIEWS.md`.
- A review is by the person, never an org session or anyone with any role in an approved claimant; `place_review_aggregates` is recomputed in every review write, never incremented.
- No revision holds an Oxy file id or a review's words.
- GoWay places are matched by name in SQL (`findPlacesByText`, the `foldedSql` trigram indexes), never in memory. Note: `docs/SEARCH.md`.
