/**
 * A streaming CityGML reader: buildings and the polygons of their boundary
 * surfaces, one building at a time, from files far too large to hold as a DOM
 * (one NYC distribution area is 600 MB of XML).
 *
 * It is NOT an XML parser. It walks tags with `indexOf`, matches them by LOCAL
 * name (so `bldg:`, `building:`, a default namespace, CityGML 1.0, 2.0 and the
 * 3.0 element names it shares all read the same), and keeps only what a
 * building's shell needs:
 *
 *  - `Building` / `BuildingPart` (parts are folded into their building — the
 *    renderer draws surfaces, not the part tree), its `gml:id`, `gml:name`,
 *    generic attributes (`stringAttribute`, `intAttribute`, `doubleAttribute`,
 *    and 3.0's `genericAttribute` name/value pairs) and the few typed ones a
 *    receipt reports (`measuredHeight`, `storeysAboveGround`, `roofType`, …);
 *  - every `gml:Polygon` (`exterior`/`interior` `LinearRing` as `posList` or a
 *    run of `pos`), tagged with the thematic surface it is in (`RoofSurface`,
 *    `GroundSurface`, `WallSurface`, others as `other`) or `none`, and the LOD
 *    of the geometry property it came from (`lod2MultiSurface` → 2);
 *  - the `srsName` and `srsDimension` that apply.
 *
 * Skipped outright: appearances (textures), openings, rooms, installations and
 * furniture — none of it changes a shell seen from the street, and textures
 * are photographs GoWay does not draw. A polygon referenced by `xlink:href`
 * is a second reference to geometry already read, so it is never followed.
 *
 * The input is UNTRUSTED (a download): every number is parsed with `Number`
 * and a ring with a non-finite ordinate, too few points or a ragged dimension
 * is dropped and counted, never coerced.
 */
import { closeSync, openSync, readSync } from 'node:fs';

export type SurfaceKind = 'roof' | 'ground' | 'wall' | 'other' | 'none';

export interface RawPolygon {
  kind: SurfaceKind;
  /** The `lodN…` geometry property it came from; 0 when none was seen. */
  lod: number;
  /** Exterior first, then holes; each `[x, y, z, x, y, z, …]`, closing point dropped. */
  rings: Float64Array[];
}

export interface RawBuilding {
  id: string;
  /** Generic and typed attributes by name; the first value seen wins. */
  attributes: Record<string, string>;
  polygons: RawPolygon[];
  /** The `srsName` in force for this building's geometry, when one was declared. */
  srsName?: string;
}

export interface CityGmlStats {
  buildings: number;
  polygons: number;
  rejectedRings: number;
  srsName?: string;
}

const SURFACE_KINDS: Record<string, SurfaceKind> = {
  RoofSurface: 'roof',
  GroundSurface: 'ground',
  WallSurface: 'wall',
  ClosureSurface: 'other',
  OuterCeilingSurface: 'other',
  OuterFloorSurface: 'other',
};

/** Subtrees that never contribute to a building's shell. */
const SKIPPED = new Set([
  'appearance',
  'appearanceMember',
  'Appearance',
  'opening',
  'Window',
  'Door',
  'interiorRoom',
  'Room',
  'outerBuildingInstallation',
  'interiorBuildingInstallation',
  'buildingInstallation',
  'BuildingInstallation',
  'interiorFurniture',
  'address',
  'Address',
]);

/** Typed building attributes worth a receipt line. */
const TYPED_ATTRIBUTES = new Set([
  'measuredHeight',
  'storeysAboveGround',
  'roofType',
  'function',
  'usage',
  'class',
  'yearOfConstruction',
]);

const GENERIC_ATTRIBUTES = new Set([
  'stringAttribute',
  'intAttribute',
  'doubleAttribute',
  'measureAttribute',
  'uriAttribute',
  'dateAttribute',
]);

function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

const ATTRIBUTE_PATTERNS = new Map<string, RegExp>();

function attribute(tag: string, name: string): string | undefined {
  // `name="…"` or `prefix:name="…"`, single or double quoted.
  let pattern = ATTRIBUTE_PATTERNS.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
    ATTRIBUTE_PATTERNS.set(name, pattern);
  }
  const match = pattern.exec(tag);
  return match ? (match[2] ?? match[3]) : undefined;
}

/** Whitespace-separated numbers → `[x, y, z, …]` with `dimension` ordinates each; `null` when unreadable. */
export function parseRing(text: string, dimension: number): Float64Array | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length === 1 && parts[0] === '') return null;
  if (dimension !== 2 && dimension !== 3) return null;
  if (parts.length % dimension !== 0) return null;
  let count = parts.length / dimension;
  // Drop the closing duplicate.
  if (count > 1) {
    let same = true;
    for (let d = 0; d < dimension; d++) {
      if (parts[d] !== parts[(count - 1) * dimension + d]) same = false;
    }
    if (same) count--;
  }
  if (count < 3) return null;
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 3; d++) {
      const value = d < dimension ? Number(parts[i * dimension + d]) : 0;
      if (!Number.isFinite(value)) return null;
      out[i * 3 + d] = value;
    }
  }
  return out;
}

interface State {
  building: RawBuilding | null;
  buildingDepth: number;
  surface: SurfaceKind;
  surfaceDepth: number;
  lod: number;
  lodDepth: number;
  skipDepth: number;
  polygon: Float64Array[] | null;
  polygonKind: SurfaceKind;
  polygonLod: number;
  ringText: string[] | null;
  ringDimension: number;
  attributeName: string | null;
  srsName?: string;
  srsDimension: number;
}

/**
 * Read a CityGML file and hand each building to `onBuilding` as soon as its
 * closing tag is read. Synchronous, bounded memory: one building and one
 * read buffer at a time.
 */
export function readCityGml(
  path: string,
  onBuilding: (building: RawBuilding) => void,
  options: { chunkBytes?: number } = {},
): CityGmlStats {
  const stats: CityGmlStats = { buildings: 0, polygons: 0, rejectedRings: 0 };
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(options.chunkBytes ?? 8 * 1024 * 1024);
  const decoder = new TextDecoder('utf-8');
  const state: State = {
    building: null,
    buildingDepth: 0,
    surface: 'none',
    surfaceDepth: 0,
    lod: 0,
    lodDepth: 0,
    skipDepth: 0,
    polygon: null,
    polygonKind: 'none',
    polygonLod: 0,
    ringText: null,
    ringDimension: 3,
    attributeName: null,
    srsDimension: 3,
  };
  // Element depth, so a closing tag can tell which open element it ends.
  let depth = 0;
  // Text being collected (posList, pos, value, …): its element's local name.
  let capture: string | null = null;
  let captured = '';

  const startTag = (raw: string, selfClosing: boolean) => {
    const space = raw.search(/[\s/]/);
    const qualified = space === -1 ? raw : raw.slice(0, space);
    const name = localName(qualified);
    depth++;
    const srs = raw.includes('srsName') ? attribute(raw, 'srsName') : undefined;
    if (srs) {
      if (!stats.srsName) stats.srsName = srs;
      if (state.building && !state.building.srsName) state.building.srsName = srs;
      state.srsName = srs;
    }
    const dim = raw.includes('srsDimension') ? attribute(raw, 'srsDimension') : undefined;
    if (dim) state.srsDimension = Number(dim);

    if (state.skipDepth > 0) {
      if (selfClosing) depth--;
      return;
    }
    if (SKIPPED.has(name)) {
      if (selfClosing) depth--;
      else state.skipDepth = depth;
      return;
    }
    if (name === 'Building' || name === 'BuildingPart') {
      if (!state.building) {
        state.building = { id: attribute(raw, 'id') ?? '', attributes: {}, polygons: [] };
        if (state.srsName) state.building.srsName = state.srsName;
        state.buildingDepth = depth;
      }
    } else if (state.building) {
      if (SURFACE_KINDS[name] !== undefined && state.surface === 'none') {
        state.surface = SURFACE_KINDS[name];
        state.surfaceDepth = depth;
      } else if (/^lod\d/.test(name) && state.lodDepth === 0) {
        state.lod = Number(name[3]);
        state.lodDepth = depth;
      } else if (name === 'Polygon' && !state.polygon) {
        state.polygon = [];
        state.polygonKind = state.surface;
        state.polygonLod = state.lod;
      } else if (state.polygon && (name === 'posList' || name === 'pos')) {
        const ringDim = dim ? Number(dim) : state.srsDimension;
        if (name === 'posList' || !state.ringText) {
          state.ringText = [];
          state.ringDimension = ringDim;
        }
        capture = name;
        captured = '';
      } else if (state.surface === 'none' && !state.polygon) {
        if (GENERIC_ATTRIBUTES.has(name)) {
          state.attributeName = attribute(raw, 'name') ?? null;
        } else if (name === 'value' && state.attributeName) {
          capture = 'value';
          captured = '';
        } else if (name === 'name' && depth === state.buildingDepth + 1) {
          capture = 'gml:name';
          captured = '';
        } else if (name === 'name' && state.attributeName === '') {
          // CityGML 3.0: <genericAttribute><StringAttribute><name>…</name><value>…
          capture = 'attrName';
          captured = '';
        } else if (name === 'genericAttribute') {
          state.attributeName = '';
        } else if (TYPED_ATTRIBUTES.has(name) && depth === state.buildingDepth + 1) {
          capture = name;
          captured = '';
        }
      }
    }
    if (selfClosing) endTag(name);
  };

  const endTag = (name: string) => {
    if (state.skipDepth > 0) {
      if (depth === state.skipDepth) state.skipDepth = 0;
      depth--;
      return;
    }
    if (capture !== null && (name === capture || (capture === 'gml:name' && name === 'name'))) {
      const text = captured;
      captured = '';
      const kind = capture;
      capture = null;
      const building = state.building;
      if ((kind === 'posList' || kind === 'pos') && state.ringText) {
        state.ringText.push(text);
      } else if (building && kind === 'value' && state.attributeName) {
        if (building.attributes[state.attributeName] === undefined) {
          building.attributes[state.attributeName] = text.trim();
        }
      } else if (building && kind === 'attrName') {
        state.attributeName = text.trim();
      } else if (building && kind === 'gml:name') {
        if (building.attributes.name === undefined) building.attributes.name = text.trim();
      } else if (building && building.attributes[kind] === undefined) {
        building.attributes[kind] = text.trim();
      }
    }
    if (name === 'LinearRing' && state.polygon && state.ringText) {
      const ring = parseRing(state.ringText.join(' '), state.ringDimension);
      if (ring) state.polygon.push(ring);
      else {
        stats.rejectedRings++;
        // An unreadable exterior voids the polygon; an unreadable hole is dropped.
        if (state.polygon.length === 0) state.polygon.push(new Float64Array(0));
      }
      state.ringText = null;
    } else if (name === 'Polygon' && state.polygon) {
      const rings = state.polygon;
      state.polygon = null;
      if (state.building && rings.length > 0 && rings[0].length > 0) {
        state.building.polygons.push({ kind: state.polygonKind, lod: state.polygonLod, rings });
        stats.polygons++;
      }
    } else if (GENERIC_ATTRIBUTES.has(name) || name === 'genericAttribute') {
      state.attributeName = null;
    }
    if (depth === state.surfaceDepth) {
      state.surface = 'none';
      state.surfaceDepth = 0;
    }
    if (depth === state.lodDepth) {
      state.lod = 0;
      state.lodDepth = 0;
    }
    if (state.building && depth === state.buildingDepth) {
      const building = state.building;
      state.building = null;
      state.buildingDepth = 0;
      stats.buildings++;
      onBuilding(building);
    }
    depth--;
  };

  let buffer = '';
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      const done = read === 0;
      buffer += done ? decoder.decode() : decoder.decode(chunk.subarray(0, read), { stream: true });
      let at = 0;
      for (;;) {
        const open = buffer.indexOf('<', at);
        if (open === -1) {
          if (capture !== null) captured += buffer.slice(at);
          at = buffer.length;
          break;
        }
        if (capture !== null) captured += buffer.slice(at, open);
        // From here an incomplete tag breaks out with `at` on its '<', so the
        // next chunk re-reads the tag and never the text before it.
        at = open;
        // Comments, CDATA and declarations: skip to their own terminator.
        let close: number;
        if (buffer.startsWith('<!--', open)) {
          close = buffer.indexOf('-->', open + 4);
          if (close === -1) break;
          at = close + 3;
          continue;
        }
        if (buffer.startsWith('<![CDATA[', open)) {
          close = buffer.indexOf(']]>', open + 9);
          if (close === -1) break;
          if (capture !== null) captured += buffer.slice(open + 9, close);
          at = close + 3;
          continue;
        }
        close = buffer.indexOf('>', open + 1);
        if (close === -1) break;
        const raw = buffer.slice(open + 1, close);
        at = close + 1;
        if (raw.startsWith('?') || raw.startsWith('!')) continue;
        if (raw.startsWith('/')) endTag(localName(raw.slice(1).trim()));
        else {
          const selfClosing = raw.endsWith('/');
          startTag(selfClosing ? raw.slice(0, -1) : raw, selfClosing);
        }
      }
      buffer = buffer.slice(at);
      if (done) break;
    }
  } finally {
    closeSync(fd);
  }
  return stats;
}
