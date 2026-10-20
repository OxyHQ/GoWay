# Search

`GET /search` blends GoWay's own places with the interactive geocoder (Photon) and ranks the lot.

## GoWay places: matched in SQL

`findPlacesByText` (`db/places/placesRepository.ts`) matches typed text against the accent-folded
default name and every `places_names` row: exact, prefix, word-start, substring, then trigram
`word_similarity` for typos (words of 4+ characters). It needs no position; `center` only orders
ties by distance and bounds the scan to `TEXT_SEARCH_RADIUS_METERS`. Text under 3 characters is
prefix-only and needs a `center`.

The fold is `translate(name_normalized, from, to)` from one table, `db/places/textFold.ts`, used by
`foldText` in JavaScript and `foldedSql` in SQL. `translate` is IMMUTABLE, so the GIN trigram indexes
(`places_name_fold_trgm_idx`, `places_names_name_fold_trgm_idx`, `pg_trgm` in `REQUIRED_EXTENSIONS`)
are expression indexes with no `unaccent` and no hand-written function. Changing the table
orphans the deployed indexes: `textFold.test.ts` pins its hash.

A typed word that names a category in any label language (`catalog.named`) also surfaces the places
in it, below name matches. An explicit category/capability filter stays the question: matches first,
then the rest of the filter appended.

## Ranking

Reciprocal-rank fusion over each list, times proximity, enrichment and a text-relevance factor
(`textRelevance` in `search/ranking.ts`, the same ladder as the SQL score). Photon gets `zoom` and
`location_bias_scale` from the viewport. Requests carrying a coordinate are never cached (privacy,
`search/cache.ts`).

## Photon languages

The public instance answers 400 for a `lang` it was not built with, so `photonLanguages` stays
de/en/fr/it unless the deployment sets `SEARCH_PHOTON_LANGUAGES`; other locales get local names.

## App

`useExplore` derives search mode from the live box (the request alone is debounced), keeps the previous
list dimmed while the next loads, opens the best result on Enter, and keeps recent searches on the
device only (`lib/search/recentSearches.ts`, text only). Copy is `lib/messages/search.ts`.
