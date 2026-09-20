/**
 * A Mapbox Vector Tile decoder, for verifying tiles GoWay itself built.
 *
 * ## Why decode our own output
 *
 * Because a tile build that printed no errors has proved nothing. Planetiler
 * exits 0 on a run that dropped a layer, stopped a zoom short, or — the one
 * that matters most here — wrote feature ids that cannot be joined back to
 * OpenStreetMap. None of those is visible in a log line or a file size. The
 * only honest check is to open the artefact, read the features out of it and
 * assert on what is actually there, which is what `build-map-tiles.ts --verify`
 * does with this file.
 *
 * ## Geometry is deliberately not decoded
 *
 * The verifier asks three questions — which layers exist, what attributes the
 * features carry, and what their ids are — and none of them needs the zigzag
 * command stream. Skipping it keeps this under 150 lines and keeps the
 * verifier fast enough to sweep hundreds of tiles. {@link VectorTileFeature}
 * still reports the geometry TYPE, because "the poi layer came out as
 * polygons" is exactly the kind of build error worth catching.
 *
 * ## The id encoding, which is the point of the exercise
 *
 * Planetiler sets a tile feature's id to `osmId * 10 + sourceId`, with
 * `sourceId` 1 for a node, 2 for a way and 3 for a relation (its
 * `feature_source_id_multiplier` argument). {@link osmElementFor} undoes that,
 * and it is the reason GoWay builds its own tiles at all: a GoWay place whose
 * provenance is `openstreetmap:way/188938001` can be joined to the basemap
 * label drawn from the same OSM element, which is impossible when the id in
 * the tile means nothing outside the tile.
 *
 * @see https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */
import { PbfReader, WIRE_FIXED32, WIRE_FIXED64, WIRE_LENGTH_DELIMITED, WIRE_VARINT } from './protobuf';

/** Geometry types, as `vector_tile.proto` numbers them. */
export const GEOMETRY_TYPE = ['unknown', 'point', 'linestring', 'polygon'] as const;

export type GeometryType = (typeof GEOMETRY_TYPE)[number];

/** An attribute value, in the three shapes MVT can carry. */
export type VectorTileValue = string | number | boolean;

export interface VectorTileFeature {
  /** The raw tile feature id. `undefined` when the writer set none. */
  id?: number;
  type: GeometryType;
  properties: Record<string, VectorTileValue>;
}

export interface VectorTileLayer {
  name: string;
  version: number;
  extent: number;
  features: VectorTileFeature[];
}

/** The OSM element a Planetiler-written tile feature id came from. */
export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
}

/** `sourceId` values Planetiler's `feature_source_id_multiplier` assigns. */
const OSM_SOURCE_IDS: Record<number, OsmElement['type']> = { 1: 'node', 2: 'way', 3: 'relation' };

/** The multiplier Planetiler applies, and the one GoWay's builds must keep. */
export const OSM_ID_MULTIPLIER = 10;

/**
 * Undo `osmId * 10 + sourceId`, or `null` when the id did not come from OSM.
 *
 * A `sourceId` of 0 is Planetiler's "some other source" — the Natural Earth
 * and water-polygon shapefiles that fill the low zooms — and those genuinely
 * have no OSM element behind them. Returning `null` rather than guessing is
 * what lets the verifier state a real coverage figure for the `poi` layer
 * instead of a reassuring one.
 */
export function osmElementFor(featureId: number | undefined): OsmElement | null {
  if (featureId === undefined || !Number.isFinite(featureId) || featureId <= 0) return null;
  const type = OSM_SOURCE_IDS[featureId % OSM_ID_MULTIPLIER];
  if (!type) return null;
  return { type, id: Math.floor(featureId / OSM_ID_MULTIPLIER) };
}

/** `way/188938001` — the form `places_sources` records provenance in. */
export function osmElementKey(element: OsmElement): string {
  return `${element.type}/${element.id}`;
}

function readValue(reader: PbfReader): VectorTileValue | undefined {
  let value: VectorTileValue | undefined;
  while (!reader.atEnd) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WIRE_LENGTH_DELIMITED) value = reader.readString();
    else if (field === 2 && wireType === WIRE_FIXED32) value = reader.readFloat();
    else if (field === 3 && wireType === WIRE_FIXED64) value = reader.readDouble();
    else if (field === 4 && wireType === WIRE_VARINT) value = reader.readVarint();
    else if (field === 5 && wireType === WIRE_VARINT) value = reader.readVarint();
    else if (field === 6 && wireType === WIRE_VARINT) value = reader.readSint64();
    else if (field === 7 && wireType === WIRE_VARINT) value = reader.readVarint() !== 0;
    else reader.skip(wireType);
  }
  return value;
}

/** Read a packed repeated varint field into an array. */
function readPacked(reader: PbfReader): number[] {
  return reader.readMessage((nested) => {
    const out: number[] = [];
    while (!nested.atEnd) out.push(nested.readVarint());
    return out;
  });
}

interface RawFeature {
  id?: number;
  type: number;
  tags: number[];
}

function readFeature(reader: PbfReader): RawFeature {
  const feature: RawFeature = { type: 0, tags: [] };
  while (!reader.atEnd) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WIRE_VARINT) feature.id = reader.readVarint();
    else if (field === 2 && wireType === WIRE_LENGTH_DELIMITED) feature.tags = readPacked(reader);
    else if (field === 3 && wireType === WIRE_VARINT) feature.type = reader.readVarint();
    else reader.skip(wireType);
  }
  return feature;
}

function readLayer(reader: PbfReader): VectorTileLayer {
  let name = '';
  let version = 1;
  let extent = 4096;
  const keys: string[] = [];
  const values: (VectorTileValue | undefined)[] = [];
  const raw: RawFeature[] = [];

  while (!reader.atEnd) {
    const { field, wireType } = reader.readTag();
    if (field === 1 && wireType === WIRE_LENGTH_DELIMITED) name = reader.readString();
    else if (field === 2 && wireType === WIRE_LENGTH_DELIMITED) raw.push(reader.readMessage(readFeature));
    else if (field === 3 && wireType === WIRE_LENGTH_DELIMITED) keys.push(reader.readString());
    else if (field === 4 && wireType === WIRE_LENGTH_DELIMITED) values.push(reader.readMessage(readValue));
    else if (field === 5 && wireType === WIRE_VARINT) extent = reader.readVarint();
    else if (field === 15 && wireType === WIRE_VARINT) version = reader.readVarint();
    else reader.skip(wireType);
  }

  const features = raw.map((feature) => {
    const properties: Record<string, VectorTileValue> = {};
    for (let i = 0; i + 1 < feature.tags.length; i += 2) {
      const key = keys[feature.tags[i]];
      const value = values[feature.tags[i + 1]];
      if (key !== undefined && value !== undefined) properties[key] = value;
    }
    return {
      id: feature.id,
      type: GEOMETRY_TYPE[feature.type] ?? 'unknown',
      properties,
    } satisfies VectorTileFeature;
  });

  return { name, version, extent, features };
}

/**
 * Decode one **uncompressed** vector tile.
 *
 * Callers pass the bytes after gunzip: a PMTiles archive stores tiles gzipped
 * and says so in its header, and pretending that is this function's business
 * would mean sniffing a magic number that a future archive might legitimately
 * not have.
 */
export function decodeVectorTile(bytes: Uint8Array): VectorTileLayer[] {
  const reader = new PbfReader(bytes);
  const layers: VectorTileLayer[] = [];
  while (!reader.atEnd) {
    const { field, wireType } = reader.readTag();
    if (field === 3 && wireType === WIRE_LENGTH_DELIMITED) layers.push(reader.readMessage(readLayer));
    else reader.skip(wireType);
  }
  return layers;
}
