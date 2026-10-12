/**
 * GoWay's map-style catalogue document, parsed (`docs/MAP_STYLES.md`).
 *
 * `https://goway.to/map/styles/index.json` (`client.links.mapStyleIndex()`)
 * lists every published style, the lights it comes in, and each document's
 * URL. Fetch it however your app fetches; this checks what came back. The
 * schema is open: a style GoWay publishes after this SDK was built is listed,
 * not an error — pick the ids you know with `isMapStyleId`.
 */
import { mapStyleIndexSchema, type MapStyleIndex } from './contract';
import { GoWayValidationError } from './errors';

export function parseMapStyleIndex(value: unknown): MapStyleIndex {
  const parsed = mapStyleIndexSchema.safeParse(value);
  if (!parsed.success) {
    throw new GoWayValidationError(`not a GoWay map style index: ${parsed.error.message}`);
  }
  return parsed.data;
}
