# Label translations

GoWay's own vocabularies (the category taxonomy, the capability keys, their
enum values and groups) are GoWay's data, so they are written in the languages
GoWay publishes, not in each client. The languages are Mercaria's
locales, so the two products read alike:

`en` (the fallback), `ar`, `bn`, `ca`, `de`, `es`, `fr`, `hi`, `ja`, `pt-BR`,
`ru`, `zh-Hans`. These are `LABEL_LANGUAGES` in `packages/contracts/src/labels.ts`,
and every tag is canonical (`normalizeLanguageTag`).

## Where the labels live

| vocabulary | where | languages |
|---|---|---|
| capability keys, enum values, groups | `capability-registry.ts`, as `Labels` | all twelve, **required** by the type |
| categories | `place_category_labels`, in the database | `en` **required**; any others. Seeded with all twelve by `0016` |
| the app's generic pin and "Other" heading | `frontend/lib/goway/{categories,capabilities}.ts` | all twelve |

Capability labels require every language, so the vocabulary never renders as a
patchwork: a reader sees all of it in their language or all of it in English.

Category labels are data a moderator edits (`PUT`/`DELETE
/moderation/categories/{key}/labels/{language}`; `docs/PLACE_DATA.md`), so a
language arrives a row at a time and only English is required. The twelve
languages were written as `i18n/category-labels.json`, which `0016`'s seed was
generated from and which was then deleted with the code registry: the database
is the one copy. The frozen seed — keys, glyphs, tags and those labels — is the
backend test fixture `src/__tests__/fixtures/categoryTaxonomy-0.3.0.json`, and
`categoryTables.realdb.test.ts` holds the migrated database to it, with the
same hygiene the JSON's own test had (twelve languages, trimmed, NFC, no bidi
controls). The table CHECKs trimmed, non-empty, NFC and at most 80 characters,
so a label that breaks those rules cannot be stored by any path.

### Delivering more category labels

A batch of category translations is delivered as ONE JSON file, the shape
`category-labels.json` had:

```json
{
  "food": { "it": "Cibo e bevande", "ko": "음식·음료" },
  "food.cafe": { "it": "Caffè", "ko": "카페" }
}
```

- keys: category keys as `GET /moderation/categories` lists them (a key the
  database does not hold is skipped, never created);
- languages: canonical BCP 47 tags (`normalizeLanguageTag`): `it`, `ko`,
  `zh-Hant`, `pt-PT` — never `en`, which is the source;
- labels: trimmed, NFC, 1–80 characters, no bidi control characters, brand
  names as they are.

It lands as a custom migration generated from the file (`bun run db:generate
-- --custom --name goway_category_labels_<langs>`, `pre`), one statement:

```sql
-- oxy:deploy-phase=pre
INSERT INTO "place_category_labels" ("category_key", "language", "label")
SELECT "label"."category_key", "label"."language", "label"."label"
FROM (VALUES
  ('food', 'it', 'Cibo e bevande'),
  ('food.cafe', 'it', 'Caffè')
) AS "label"("category_key", "language", "label")
JOIN "place_categories" ON "place_categories"."key" = "label"."category_key"
ON CONFLICT ("category_key", "language") DO NOTHING;
```

The JOIN skips a key a moderator never created; `DO NOTHING` keeps a label a
moderator already wrote. Like the seed, it records no `place_category_events`.
A handful of corrections goes through the moderation API instead, which
records each one.

## Matching a locale

Every label is read through `localizedLabel(entry, locale)`, which uses
`matchLanguageTag(offered, locale)`. The matcher is exported so that labels
stored as rows use it too: the category catalog resolves every
`GET /categories` label through `localizedLabel` unchanged. Pass the reader's whole tag (`zh-Hans-CN`,
`pt-PT`, `es-MX`), never only its language. The matcher picks:

1. **The exact tag.** `pt-BR` reads `pt-BR`.
2. **The same language in a compatible script.** It prefers the reader's own
   region, then a tag with no region, then a tag with another region. Within
   each of those, it prefers the variant the reader asked for, then no variant,
   then a variant the reader did not ask for. So `zh`, `zh-CN`, `zh-SG` and
   `zh-Hans-CN` read `zh-Hans`; `pt` and `pt-PT` read `pt-BR`; `es-MX` reads
   `es`; and `ca-ES-valencia` reads `ca`.
3. **The same language in another script**, ranked the same way: `zh-TW` reads
   `zh-Hans` while there is no `zh-Hant`.
4. **English.**

When a tag has no script, the matcher uses CLDR's likely script:
`zh-TW`/`zh-HK`/`zh-MO` are `Hant`, other `zh` is `Hans`, and `hi` is `Deva`.
The reader's own script always wins, but another script of the same language
beats English: `zh-TW` and `zh-Hant-HK` read Simplified Chinese until a
`zh-Hant` label exists, and `hi-Latn` reads Devanagari. This departs from CLDR,
where `zh-Hant` does not inherit from `zh`, on purpose (product decision,
2026-10-05): Simplified is far more legible to a Traditional reader than
English. Ties go to the
earlier language in the entry.

The app's `deviceLocale()` passes the engine's tag through whole. It drops only
the extension sequence (`-u-…`, `-x-…`), so `zh-Hant-TW-u-nu-hanidec` keeps the
script that matching needs.

## Adding a language

1. Add the canonical tag to `LABEL_LANGUAGES` and to `labelsSchema`.
   `typecheck` then lists every capability label that lacks it.
2. Write those labels and the two frontend fallbacks. Deliver the category
   labels as described under *Delivering more category labels*.
3. If the language can be written in more than one script, add its likely
   script and any regional exceptions to `LIKELY_SCRIPTS` in `language.ts`.
4. Run `bun run test:sdk` (no vocabulary gaps, no bidi control characters) and
   the backend suite (the migration applies and the CHECKs hold). Then add the
   language to the table below.

Do not add bidi control characters. Arabic labels carry Latin brand names
(FairCoin, Mercaria, Oxy) as they are, and the renderer handles direction.

## Review status

`en` is the source. `es` was written with the vocabularies and has not been
re-reviewed here. The other ten are **machine-authored and need native
review** before they are relied on. Each one checked Mercaria's wording for
payment, shop, delivery, pickup and brand. Things a reviewer should look at
first:

| language | status | look at |
|---|---|---|
| `ar` | machine, unreviewed | short masculine cuisine chips (إيطالي); `shop.deli`, `shop.chemist` are approximate; takeaway طلبات خارجية vs سفري |
| `bn` | machine, unreviewed | West Bengal register (জুতো, বিমা), where Bangladesh may prefer জুতা, বীমা; Moovo pickup uses Mercaria's সংগ্রহ |
| `ca` | machine, unreviewed | `food.bakery` Forn de pa; `amenities.drive_through` Servei per a cotxes; `steak_house` Brasa; Barcelona signage terms (Bústia, Estanc, Caixer automàtic) |
| `de` | machine, unreviewed | `shop.hardware` Baumarkt; `culture.castle` Burg vs Schloss; `education.kindergarten` Kita |
| `fr` | machine, unreviewed | `shop` Commerces; `health.clinic` Centre médical; drive-through Drive; feminine diet chips (Végane) |
| `hi` | machine, unreviewed | `shop.convenience` किराना स्टोर; `office.estate_agent` प्रॉपर्टी डीलर; `craft` |
| `ja` | machine, unreviewed | `culture.museum` 博物館・美術館; `shop.hardware` ホームセンター; breakfast モーニング; place スポット |
| `pt-BR` | machine, unreviewed | Brazilian everyday terms (Brechó, Balada, Rodoviária, Fórum); Lámen; contactless Pagamento por aproximação |
| `ru` | machine, unreviewed | ё used, following Mercaria; АЗС, Ж/д станция abbreviations; neuter diet chips (Веганское) |
| `zh-Hans` | machine, unreviewed | `craft` 手工作坊 may be too narrow; `health.doctor` 门诊 vs `health.clinic` 诊所; drive-through 免下车 |

When a native speaker has reviewed a language, change its status to
`reviewed (<who>, <date>)`.
