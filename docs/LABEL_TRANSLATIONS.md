# Label translations

GoWay's own vocabularies (the category taxonomy, the capability keys, their
enum values and groups) are contract data, so they are written in the
languages GoWay publishes, not in each client. The languages are Mercaria's
locales, so the two products read alike:

`en` (the fallback), `ar`, `bn`, `ca`, `de`, `es`, `fr`, `hi`, `ja`, `pt-BR`,
`ru`, `zh-Hans`. These are `LABEL_LANGUAGES` in `packages/contracts/src/labels.ts`,
and every tag is canonical (`normalizeLanguageTag`).

## Where the labels live

| vocabulary | where | languages |
|---|---|---|
| capability keys, enum values, groups | `capability-registry.ts`, as `Labels` | all twelve, **required** by the type |
| categories, in the SDK bundle | `category.ts` | `en`, `es` |
| categories, the other ten | `i18n/category-labels.json` | all twelve, seed data for `place_category_labels` |
| the app's generic pin and "Other" heading | `frontend/lib/goway/{categories,capabilities}.ts` | all twelve |

Capability labels require every language, so the vocabulary never renders as a
patchwork: a reader sees all of it in their language or all of it in English.

`category-labels.json` is JSON rather than TypeScript for three reasons. It is
seed data for the migration that fills the category tables, not code. Nothing
imports it, so it ships in no SDK bundle and no `dist/`. And translation tools
read it as it is, the same way they read Mercaria's `locales/*.json`.
`packages/sdk/test/categoryLabels.test.ts` holds it to the taxonomy: every
key, in registry order, with exactly the twelve languages, and with the same
English and Spanish as `category.ts`.

## Matching a locale

Every label is read through `localizedLabel(entry, locale)`, which uses
`matchLanguageTag(offered, locale)`. The matcher is exported so that labels
stored as rows can use it too. Pass the reader's whole tag (`zh-Hans-CN`,
`pt-PT`, `es-MX`), never only its language. The matcher picks:

1. **The exact tag.** `pt-BR` reads `pt-BR`.
2. **The same language in a compatible script.** It prefers the reader's own
   region, then a tag with no region, then a tag with another region. Within
   each of those, it prefers the variant the reader asked for, then no variant,
   then a variant the reader did not ask for. So `zh`, `zh-CN`, `zh-SG` and
   `zh-Hans-CN` read `zh-Hans`; `pt` and `pt-PT` read `pt-BR`; `es-MX` reads
   `es`; and `ca-ES-valencia` reads `ca`.
3. **English.**

When a tag has no script, the matcher uses CLDR's likely script:
`zh-TW`/`zh-HK`/`zh-MO` are `Hant`, other `zh` is `Hans`, and `hi` is `Deva`.
A script mismatch is never a match. Following CLDR, where `zh-Hant` does not
inherit from `zh`, `zh-TW` and `zh-Hant-HK` read English rather than Simplified
Chinese, and `hi-Latn` reads English rather than Devanagari. Ties go to the
earlier language in the entry.

The app's `deviceLocale()` passes the engine's tag through whole. It drops only
the extension sequence (`-u-…`, `-x-…`), so `zh-Hant-TW-u-nu-hanidec` keeps the
script that matching needs.

## Adding a language

1. Add the canonical tag to `LABEL_LANGUAGES` and to `labelsSchema`.
   `typecheck` then lists every capability label that lacks it.
2. Write those labels, the two frontend fallbacks, and a column in
   `category-labels.json` (or rows in `place_category_labels` once the tables
   exist).
3. If the language can be written in more than one script, add its likely
   script and any regional exceptions to `LIKELY_SCRIPTS` in `language.ts`.
4. Run `bun run test:sdk`. It checks that the vocabulary has no gaps, that the
   JSON is complete, and that no bidi control characters are present. Then add
   the language to the table below.

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
