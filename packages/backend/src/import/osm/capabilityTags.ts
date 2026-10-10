/**
 * OpenStreetMap tags → capability values, by the registry's own mappings.
 *
 * The mapping is DATA in `@goway/contracts` (`CAPABILITY_DEFINITIONS[key].osm`)
 * and this module only interprets it, so which tag means "takes cards" is
 * decided once, beside the key's type and labels, and never restated here.
 *
 * Every value produced is put through the key's own contract schema before it
 * is returned: an OpenStreetMap value the registry cannot express is dropped,
 * never stored in a shape an API write would have refused.
 *
 * What comes out is written as `external_source` assertions tied to the
 * element's `places_sources` row (`writePlaces`). A tag OpenStreetMap says
 * nothing about produces nothing — the absence of `wheelchair=*` is not
 * `wheelchair=no`.
 */

import {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_KEYS,
  capabilityValueSpecSchema,
  type CapabilityKey,
  type CapabilityOsmTags,
  type CapabilityValue,
  type CapabilityValueSpec,
} from '@goway/contracts';

/** One capability an element asserts. */
export interface ImportedCapability {
  key: CapabilityKey;
  value: CapabilityValue;
}

/** A tag's `;`-separated values, trimmed and lower-cased. */
function valuesOf(tags: ReadonlyMap<string, string>, key: string): string[] {
  const raw = tags.get(key);
  if (raw === undefined) return [];
  return raw
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

/** The raw value an element gives a capability, before the key's schema sees it. */
function rawValue(
  spec: CapabilityValueSpec,
  osm: CapabilityOsmTags,
  tags: ReadonlyMap<string, string>,
): unknown {
  const keys = osm.tags ?? [];
  const yes = osm.yes ?? ['yes'];
  const no = osm.no ?? ['no'];

  switch (spec.kind) {
    case 'boolean': {
      const said = keys.flatMap((key) => valuesOf(tags, key));
      if (said.some((value) => yes.includes(value))) return true;
      if (said.some((value) => no.includes(value))) return false;
      return undefined;
    }
    case 'enum':
      return keys
        .flatMap((key) => valuesOf(tags, key))
        .find((value) => Object.prototype.hasOwnProperty.call(spec.values, value));
    case 'enum_set': {
      const members =
        osm.prefix !== undefined
          ? Object.keys(spec.values).filter((value) =>
              valuesOf(tags, `${osm.prefix}${value}`).some((said) => yes.includes(said)),
            )
          : keys
              .flatMap((key) => valuesOf(tags, key))
              .filter((value) => Object.prototype.hasOwnProperty.call(spec.values, value));
      return members.length > 0 ? members : undefined;
    }
    case 'url':
    case 'text':
      for (const key of keys) {
        const value = tags.get(key)?.trim();
        if (value) return value;
      }
      return undefined;
    case 'integer':
    case 'price_level':
      // No registered key reads a number from OpenStreetMap.
      return undefined;
  }
}

/** Every capability an element's tags assert, in registry order. */
export function osmCapabilities(tags: ReadonlyMap<string, string>): ImportedCapability[] {
  const capabilities: ImportedCapability[] = [];
  for (const key of CAPABILITY_KEYS) {
    const definition = CAPABILITY_DEFINITIONS[key];
    if (!('osm' in definition)) continue;
    const spec: CapabilityValueSpec = definition.value;
    const raw = rawValue(spec, definition.osm, tags);
    if (raw === undefined) continue;
    const parsed = capabilityValueSpecSchema(spec).safeParse(raw);
    if (parsed.success) capabilities.push({ key, value: parsed.data });
  }
  return capabilities;
}
