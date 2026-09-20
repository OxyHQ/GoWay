/**
 * Language tags, in exactly one spelling.
 *
 * A place name is stored, keyed, upserted, compared and published under a
 * language tag, so the tag's canonical form is part of the contract rather than
 * a detail of whichever layer happened to write it. `es` and `ES`, `zh-hant`
 * and `zh-Hant`, `ca_valencia` and `ca-valencia` all name one language; stored
 * verbatim they are four rows, four cache keys and four chances for a
 * re-import to add a duplicate instead of refreshing what is there.
 *
 * {@link normalizeLanguageTag} is therefore the ONLY way a tag enters GoWay,
 * and {@link LANGUAGE_TAG_PATTERN} is the shape it comes out as — the same
 * pattern the `places_names.language` CHECK enforces, so a tag the database
 * would refuse is refused at the edge instead.
 *
 * ## Why the primary subtag is restricted to two or three letters
 *
 * BCP 47 also reserves four-letter and registers five-to-eight-letter primary
 * subtags. None is assigned, and admitting them would make this function say
 * yes to OpenStreetMap keys that are not languages at all: `name:left`,
 * `name:right`, `name:signed` and `name:prefix` are all well-formed under the
 * wider rule and none of them is a translation. An importer that trusted the
 * wider rule would file "left" as a language and put a street's left-hand-side
 * label into the map's vocabulary.
 */

/**
 * The canonical shape a normalized tag has: `es`, `zh-Hant`, `en-GB`,
 * `es-419`, `ca-valencia`, `zh-Hant-HK`.
 *
 * Deliberately a SUBSET of BCP 47 — language, script, region and variants, and
 * no extension or private-use sequences. GoWay has no use for `en-u-ca-gregory`
 * as a name key, and every subtag this admits is one OpenStreetMap actually
 * carries in a `name:*` key.
 */
export const LANGUAGE_TAG_PATTERN =
  /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?(?:-(?:[0-9][a-z0-9]{3}|[a-z0-9]{5,8}))*$/;

/** The same pattern as a string, for a database CHECK or another regex engine. */
export const LANGUAGE_TAG_SQL_PATTERN =
  '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?(-([0-9][a-z0-9]{3}|[a-z0-9]{5,8}))*$';

/** The longest tag GoWay will store. Far past anything the subset above can spell. */
export const MAX_LANGUAGE_TAG_LENGTH = 35;

/**
 * A language tag in canonical form, or `undefined` when the input is not one.
 *
 * `undefined` rather than a throw or a best-effort guess: the caller is
 * typically an importer reading a key it did not choose, and the right response
 * to `name:etymology` is to skip that key, not to fail the element or to file
 * it under a made-up language.
 *
 * Underscore is accepted as a separator on the way IN — OpenStreetMap carries
 * `name:zh_pinyin` beside `name:zh-Hant` — and never emitted.
 */
export function normalizeLanguageTag(tag: string | null | undefined): string | undefined {
  if (typeof tag !== 'string') return undefined;
  const trimmed = tag.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LANGUAGE_TAG_LENGTH) return undefined;

  const parts = trimmed.split(/[-_]/);
  const [primary, ...rest] = parts;
  if (primary === undefined || !/^[A-Za-z]{2,3}$/.test(primary)) return undefined;

  const canonical: string[] = [primary.toLowerCase()];
  let index = 0;

  // Script: four letters, Titlecase. At most one, and only immediately after
  // the language — `zh-Hant`, never `zh-GB-Hant`.
  const script = rest[index];
  if (script !== undefined && /^[A-Za-z]{4}$/.test(script)) {
    canonical.push(script[0]!.toUpperCase() + script.slice(1).toLowerCase());
    index += 1;
  }

  // Region: two letters UPPER, or three digits (a UN M.49 area such as `419`).
  const region = rest[index];
  if (region !== undefined && /^([A-Za-z]{2}|[0-9]{3})$/.test(region)) {
    canonical.push(/^[0-9]{3}$/.test(region) ? region : region.toUpperCase());
    index += 1;
  }

  // Variants: five-to-eight alphanumerics, or four starting with a digit.
  for (; index < rest.length; index += 1) {
    const variant = rest[index];
    if (variant === undefined || !/^([0-9][A-Za-z0-9]{3}|[A-Za-z0-9]{5,8})$/.test(variant)) {
      return undefined;
    }
    canonical.push(variant.toLowerCase());
  }

  const result = canonical.join('-');
  // Belt and braces: the assembled tag is held to the very pattern the database
  // enforces, so no path can produce a value the CHECK would then refuse.
  return LANGUAGE_TAG_PATTERN.test(result) ? result : undefined;
}

/**
 * The language a tag is a variety of: `es-419` and `es-ES` are both `es`.
 *
 * Returns the tag itself when it is already bare, and `undefined` when it is
 * not a tag at all — so `baseLanguageTag` can be called on untrusted input
 * without a normalization step in front of it.
 */
export function baseLanguageTag(tag: string | null | undefined): string | undefined {
  const normalized = normalizeLanguageTag(tag);
  if (normalized === undefined) return undefined;
  return normalized.split('-')[0];
}
