/**
 * Reading POIs out of an `.osm.pbf`, including the ones that are not nodes.
 *
 * ## Three passes, because of the order the file is in
 *
 * An extract is sorted: every node, then every way, then every relation. A POI
 * mapped as a way — a museum, a department store, a park — carries no
 * coordinates, only node ids, and those nodes went past before the way named
 * them. A relation POI is a step worse: it names ways, which name nodes.
 *
 * So:
 *
 *  1. **Everything.** Node POIs are complete on sight and stream straight out.
 *     Way and relation POIs are classified and kept, with their references.
 *     Each blob's offset is recorded against what it turned out to contain.
 *  2. **The way blobs only.** Resolves the ways that POI relations are made of.
 *     Skipped entirely when the extract has no relation POIs.
 *  3. **The node blobs only.** Resolves the coordinates every kept reference
 *     needs, in one sweep.
 *
 * Passes 2 and 3 inflate only the blobs pass 1 recorded, which is what keeps
 * the cost at roughly twice the archive rather than three times it. A blob's
 * contents are unknowable without inflating it, which is why the index is built
 * rather than assumed.
 *
 * ## What this refuses to hold
 *
 * A node index for the whole extract would be simpler — one pass, look every
 * reference up as it appears. It is also 100 million entries for Spain and nine
 * billion for the planet, so it buys simplicity at the cost of the only
 * direction this importer is ever going to grow in. What is held instead is the
 * node ids that POI ways actually reference: a few million for Spain, and a
 * sorted `Float64Array` searched by bisection rather than a `Set`, which would
 * spend about ten times the memory on the same numbers.
 *
 * ## The position of a way is the mean of its vertices
 *
 * Not its area centroid. A POI's position is where a pin goes, the difference
 * between the two is metres on any building and tens of metres on a park, and
 * the area centroid of a concave polygon can fall outside the polygon — which
 * is worse, not better, for a pin. `geometry` on `places` is where a real
 * footprint belongs, and this importer does not claim to have one.
 */

import {
  MEMBER_TYPE_WAY,
  readBlobs,
  readPrimitiveBlock,
  type BlockStrings,
} from './pbf';
import { isPoiMappingKey } from './poiTags';
import { roundCoordinate, toImportedPlace, type ImportedPlace } from './placeRecord';

/** How many places accumulate before the consumer is handed a batch. */
const DEFAULT_BATCH_SIZE = 1000;

/** What one extract pass produced, for the log line and for the measurement. */
export interface ExtractStats {
  /** Blobs inflated, summed across all three passes. */
  blobsInflated: number;
  nodePlaces: number;
  wayPlaces: number;
  relationPlaces: number;
  /** Way and relation POIs dropped because no position could be resolved. */
  unpositioned: number;
  /** Translated names emitted, summed over every place. */
  names: number;
  /** Places carrying at least one language-tagged name beside the default. */
  placesWithTranslations: number;
  /** Places per most-specific category, for reconciling against what the basemap draws. */
  byCategory: Map<string, number>;
  /** Translated names per language, for seeing what the map's vocabulary will be. */
  byLanguage: Map<string, number>;
  passMilliseconds: [number, number, number];
}

export interface ExtractOptions {
  /** Path to the `.osm.pbf`. */
  path: string;
  /** Called with each full batch, and once more with the remainder. */
  onPlaces: (places: ImportedPlace[]) => Promise<void>;
  batchSize?: number;
  /** Stop after this many places. For a smoke run against a slice of a country. */
  limit?: number;
  /** Called every `progressEvery` places with the running total. */
  onProgress?: (emitted: number) => void;
  progressEvery?: number;
  /**
   * Keep only places inside this rectangle.
   *
   * A regional slice of a national extract — what a first production run over
   * central Barcelona uses to prove the write path against a few thousand rows
   * before it is asked for three quarters of a million.
   */
  bounds?: { west: number; south: number; east: number; north: number };
}

/** A way or relation POI whose position is not known yet. */
interface PendingPlace {
  place: ImportedPlace;
  /** Node ids for a way; member way ids for a relation. */
  refs: number[];
}

/**
 * Per-block tag matching by INTEGER index.
 *
 * A `PrimitiveBlock` holds up to 8000 elements that reference one string table
 * of a few thousand entries. Classifying the table once per block and then
 * comparing integers per element is the difference between decoding a few
 * thousand strings per block and a few hundred million per file — which, on a
 * Spain extract, is most of the running time.
 */
interface BlockIndex {
  strings: BlockStrings;
  nameKey: number;
  poiKeys: Set<number>;
}

/** Whether an element's keys include a `name` AND something that can make it a POI. */
function looksLikePoi(index: BlockIndex, keys: readonly number[]): boolean {
  let hasName = false;
  let hasPoiKey = false;
  for (const key of keys) {
    if (key === index.nameKey) hasName = true;
    else if (index.poiKeys.has(key)) hasPoiKey = true;
    if (hasName && hasPoiKey) return true;
  }
  return false;
}

/** The element's tags as strings — paid for only once an element looks like a POI. */
function tagsOf(index: BlockIndex, keys: readonly number[], vals: readonly number[]): Map<string, string> {
  const tags = new Map<string, string>();
  for (let position = 0; position < keys.length; position += 1) {
    tags.set(index.strings.text(keys[position] as number), index.strings.text(vals[position] as number));
  }
  return tags;
}

/** Classify a block's string table. See {@link BlockIndex}. */
function indexStrings(strings: BlockStrings): BlockIndex {
  const poiKeys = new Set<number>();
  let nameKey = -1;
  for (let entry = 0; entry < strings.count; entry += 1) {
    const text = strings.text(entry);
    if (text === 'name') nameKey = entry;
    else if (isPoiMappingKey(text)) poiKeys.add(entry);
  }
  return { strings, nameKey, poiKeys };
}

/**
 * A sorted, de-duplicated id list with the coordinates that were resolved for
 * it — the node index, in two typed arrays rather than a `Map`.
 *
 * `Float64Array` and not `BigInt64Array`: OSM ids are far below 2^53 (the
 * largest node id in existence is around 2^34), doubles hold them exactly, and
 * bisection over a `Float64Array` is several times faster than over boxed
 * `BigInt`s.
 */
class NodeIndex {
  private readonly ids: Float64Array;
  private readonly latitudes: Float64Array;
  private readonly longitudes: Float64Array;

  constructor(wanted: number[]) {
    const sorted = Float64Array.from(wanted);
    sorted.sort();
    let unique = 0;
    for (let index = 0; index < sorted.length; index += 1) {
      if (index === 0 || sorted[index] !== sorted[index - 1]) {
        sorted[unique] = sorted[index] as number;
        unique += 1;
      }
    }
    this.ids = sorted.subarray(0, unique);
    this.latitudes = new Float64Array(unique).fill(Number.NaN);
    this.longitudes = new Float64Array(unique).fill(Number.NaN);
  }

  get size(): number {
    return this.ids.length;
  }

  /** The slot for `id`, or -1. */
  private slot(id: number): number {
    let low = 0;
    let high = this.ids.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const value = this.ids[middle] as number;
      if (value === id) return middle;
      if (value < id) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  wants(id: number): boolean {
    return this.slot(id) >= 0;
  }

  record(id: number, latitude: number, longitude: number): void {
    const slot = this.slot(id);
    if (slot < 0) return;
    this.latitudes[slot] = latitude;
    this.longitudes[slot] = longitude;
  }

  /** The mean of the positions that resolved, or `null` when none did. */
  centre(ids: readonly number[]): { latitude: number; longitude: number } | null {
    let latitude = 0;
    let longitude = 0;
    let counted = 0;
    for (const id of ids) {
      const slot = this.slot(id);
      if (slot < 0) continue;
      const nodeLatitude = this.latitudes[slot] as number;
      if (Number.isNaN(nodeLatitude)) continue;
      latitude += nodeLatitude;
      longitude += this.longitudes[slot] as number;
      counted += 1;
    }
    if (counted === 0) return null;
    return { latitude: latitude / counted, longitude: longitude / counted };
  }
}

/**
 * Stream every POI in an extract to `onPlaces`, in batches.
 *
 * Node POIs arrive first and in file order; way and relation POIs arrive at the
 * end, once their positions are known.
 */
export async function extractPois(options: ExtractOptions): Promise<ExtractStats> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const progressEvery = options.progressEvery ?? 100_000;
  const stats: ExtractStats = {
    blobsInflated: 0,
    nodePlaces: 0,
    wayPlaces: 0,
    relationPlaces: 0,
    unpositioned: 0,
    names: 0,
    placesWithTranslations: 0,
    byCategory: new Map(),
    byLanguage: new Map(),
    passMilliseconds: [0, 0, 0],
  };
  const bounds = options.bounds;

  let batch: ImportedPlace[] = [];
  let emitted = 0;
  let stopped = false;

  const emit = async (place: ImportedPlace): Promise<void> => {
    if (stopped) return;
    if (
      bounds &&
      (place.latitude < bounds.south ||
        place.latitude > bounds.north ||
        place.longitude < bounds.west ||
        place.longitude > bounds.east)
    ) {
      return;
    }
    batch.push(place);
    emitted += 1;
    stats.names += place.names.length;
    if (place.names.length > 0) stats.placesWithTranslations += 1;
    for (const name of place.names) {
      stats.byLanguage.set(name.language, (stats.byLanguage.get(name.language) ?? 0) + 1);
    }
    const category = place.categories[0] ?? 'unknown';
    stats.byCategory.set(category, (stats.byCategory.get(category) ?? 0) + 1);
    if (emitted % progressEvery === 0) options.onProgress?.(emitted);
    if (options.limit !== undefined && emitted >= options.limit) stopped = true;
    if (batch.length >= batchSize || stopped) {
      const full = batch;
      batch = [];
      await options.onPlaces(full);
    }
  };

  const nodeOffsets: number[] = [];
  const wayOffsets: number[] = [];
  const pendingWays: PendingPlace[] = [];
  const pendingRelations: PendingPlace[] = [];
  const wantedNodes: number[] = [];
  const wantedWays = new Set<number>();

  // ── Pass 1: the whole archive ─────────────────────────────────────────────
  const startedOne = Date.now();
  for await (const blob of readBlobs(options.path)) {
    if (stopped) break;
    if (blob.type !== 'OSMData') continue;
    const data = await blob.inflate();
    stats.blobsInflated += 1;

    let index: BlockIndex | null = null;
    const emitLater: ImportedPlace[] = [];
    const contents = readPrimitiveBlock(data, {
      onStrings: (strings) => {
        index = indexStrings(strings);
      },
      onNode: (id, latitude, longitude, keys, vals) => {
        const current = index;
        if (!current || current.nameKey < 0 || !looksLikePoi(current, keys)) return;
        const place = toImportedPlace('node', id, latitude, longitude, tagsOf(current, keys, vals));
        if (place) emitLater.push(place);
      },
      onWay: (id, keys, vals, refs) => {
        const current = index;
        if (!current || current.nameKey < 0 || !looksLikePoi(current, keys)) return;
        const place = toImportedPlace('way', id, 0, 0, tagsOf(current, keys, vals));
        if (!place) return;
        const copied = refs.slice();
        for (const ref of copied) wantedNodes.push(ref);
        pendingWays.push({ place, refs: copied });
      },
      onRelation: (id, keys, vals, memberIds, memberTypes) => {
        const current = index;
        if (!current || current.nameKey < 0 || !looksLikePoi(current, keys)) return;
        const place = toImportedPlace('relation', id, 0, 0, tagsOf(current, keys, vals));
        if (!place) return;
        const ways: number[] = [];
        for (let member = 0; member < memberIds.length; member += 1) {
          if (memberTypes[member] !== MEMBER_TYPE_WAY) continue;
          const wayId = memberIds[member] as number;
          ways.push(wayId);
          wantedWays.add(wayId);
        }
        if (ways.length > 0) pendingRelations.push({ place, refs: ways });
      },
    });

    if (contents.nodes) nodeOffsets.push(blob.offset);
    if (contents.ways) wayOffsets.push(blob.offset);
    for (const place of emitLater) {
      stats.nodePlaces += 1;
      await emit(place);
    }
  }
  stats.passMilliseconds[0] = Date.now() - startedOne;

  // ── Pass 2: the way blobs, for the ways POI relations are made of ─────────
  const startedTwo = Date.now();
  const relationWayRefs = new Map<number, number[]>();
  if (!stopped && wantedWays.size > 0) {
    const wanted = new Set(wayOffsets);
    for await (const blob of readBlobs(options.path, { shouldRead: (offset) => wanted.has(offset) })) {
      if (blob.type !== 'OSMData') continue;
      const data = await blob.inflate();
      stats.blobsInflated += 1;
      readPrimitiveBlock(data, {
        onWay: (id, _keys, _vals, refs) => {
          if (!wantedWays.has(id)) return;
          const copied = refs.slice();
          relationWayRefs.set(id, copied);
          for (const ref of copied) wantedNodes.push(ref);
        },
      });
    }
  }
  stats.passMilliseconds[1] = Date.now() - startedTwo;

  // ── Pass 3: the node blobs, for every coordinate the first two asked for ──
  const startedThree = Date.now();
  const nodes = new NodeIndex(wantedNodes);
  wantedNodes.length = 0;
  if (!stopped && nodes.size > 0) {
    const wanted = new Set(nodeOffsets);
    for await (const blob of readBlobs(options.path, { shouldRead: (offset) => wanted.has(offset) })) {
      if (blob.type !== 'OSMData') continue;
      const data = await blob.inflate();
      stats.blobsInflated += 1;
      readPrimitiveBlock(data, {
        onNode: (id, latitude, longitude) => {
          if (nodes.wants(id)) nodes.record(id, latitude, longitude);
        },
      });
    }
  }
  stats.passMilliseconds[2] = Date.now() - startedThree;

  // ── Position what pass 1 held back ────────────────────────────────────────
  for (const pending of pendingWays) {
    if (stopped) break;
    const centre = nodes.centre(pending.refs);
    if (!centre) {
      stats.unpositioned += 1;
      continue;
    }
    pending.place.latitude = roundCoordinate(centre.latitude);
    pending.place.longitude = roundCoordinate(centre.longitude);
    stats.wayPlaces += 1;
    await emit(pending.place);
  }

  for (const pending of pendingRelations) {
    if (stopped) break;
    const memberNodes: number[] = [];
    for (const wayId of pending.refs) {
      const refs = relationWayRefs.get(wayId);
      if (!refs) continue;
      // A loop rather than a spread: a multipolygon's outer way can carry a
      // couple of thousand nodes, and `push(...refs)` puts every one of them on
      // the argument stack.
      for (const ref of refs) memberNodes.push(ref);
    }
    const centre = nodes.centre(memberNodes);
    if (!centre) {
      stats.unpositioned += 1;
      continue;
    }
    pending.place.latitude = roundCoordinate(centre.latitude);
    pending.place.longitude = roundCoordinate(centre.longitude);
    stats.relationPlaces += 1;
    await emit(pending.place);
  }

  if (batch.length > 0) await options.onPlaces(batch);
  return stats;
}
