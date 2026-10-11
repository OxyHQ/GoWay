/**
 * A CityJSON reader (1.0–2.0, a whole `.city.json` or a CityJSONSeq
 * `.city.jsonl`) producing the same {@link RawBuilding}s the CityGML reader
 * does, so everything after reading is one pipeline.
 *
 * A building is a root `Building` (or a parentless `BuildingPart`) with the
 * geometry of every descendant part folded in — the renderer draws surfaces,
 * not the part tree, exactly as with CityGML. Semantic surface types come
 * from each geometry's `semantics` (`RoofSurface` → roof, …); a geometry
 * without them is left `none` for `prepare.ts` to classify by its normals.
 * LODs keep their decimal (`"2.2"` → 2.2): `prepare.ts` takes the best LOD
 * whose integer part is at most 2.
 *
 * The input is UNTRUSTED: vertex indices are bounds-checked, numbers must be
 * finite, and anything malformed is skipped and counted, never coerced.
 */
import { readFileSync } from 'node:fs';

import type { CityGmlStats, RawBuilding, RawPolygon, SurfaceKind } from './cityGml';

interface Transform {
  scale: [number, number, number];
  translate: [number, number, number];
}

type CityObject = {
  type?: string;
  attributes?: Record<string, unknown>;
  children?: string[];
  parents?: string[];
  geometry?: Geometry[];
};

type Geometry = {
  type?: string;
  lod?: string | number;
  boundaries?: unknown;
  semantics?: { surfaces?: { type?: string }[]; values?: unknown };
};

const KINDS: Record<string, SurfaceKind> = {
  RoofSurface: 'roof',
  GroundSurface: 'ground',
  WallSurface: 'wall',
  ClosureSurface: 'other',
  OuterCeilingSurface: 'other',
  OuterFloorSurface: 'other',
};

const BUILDING_TYPES = new Set(['Building', 'BuildingPart']);

/** Every surface of a geometry with its semantic value, whatever the nesting depth. */
function surfacesOf(geometry: Geometry): { rings: unknown; semantic: unknown }[] {
  const depth: Record<string, number> = {
    MultiSurface: 0,
    CompositeSurface: 0,
    Solid: 1,
    MultiSolid: 2,
    CompositeSolid: 2,
  };
  const d = geometry.type ? depth[geometry.type] : undefined;
  if (d === undefined || !Array.isArray(geometry.boundaries)) return [];
  const out: { rings: unknown; semantic: unknown }[] = [];
  const walk = (boundaries: unknown, values: unknown, level: number) => {
    if (!Array.isArray(boundaries)) return;
    for (let i = 0; i < boundaries.length; i++) {
      const value = Array.isArray(values) ? values[i] : undefined;
      if (level === 0) out.push({ rings: boundaries[i], semantic: value });
      else walk(boundaries[i], value, level - 1);
    }
  };
  walk(geometry.boundaries, geometry.semantics?.values, d);
  return out;
}

class Reader {
  stats: CityGmlStats = { buildings: 0, polygons: 0, rejectedRings: 0 };

  constructor(
    private readonly onBuilding: (building: RawBuilding) => void,
    private transform: Transform | null = null,
  ) {}

  header(document: { transform?: Transform; metadata?: { referenceSystem?: string } }): void {
    if (document.transform) this.transform = document.transform;
    const srs = document.metadata?.referenceSystem;
    if (typeof srs === 'string' && !this.stats.srsName) this.stats.srsName = srs;
  }

  /** One `CityObjects` map with its own `vertices`. */
  objects(objects: Record<string, CityObject>, vertices: unknown): void {
    if (!Array.isArray(vertices)) return;
    const vertex = (index: unknown): [number, number, number] | null => {
      if (typeof index !== 'number' || !Number.isInteger(index)) return null;
      const v = vertices[index];
      if (!Array.isArray(v) || v.length < 3) return null;
      const t = this.transform;
      const out: [number, number, number] = [0, 0, 0];
      for (let d = 0; d < 3; d++) {
        const raw = v[d];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
        out[d] = t ? raw * t.scale[d] + t.translate[d] : raw;
      }
      return out;
    };
    const ringOf = (indices: unknown): Float64Array | null => {
      if (!Array.isArray(indices) || indices.length < 3) return null;
      const ring = new Float64Array(indices.length * 3);
      for (let i = 0; i < indices.length; i++) {
        const v = vertex(indices[i]);
        if (!v) return null;
        ring.set(v, i * 3);
      }
      return ring;
    };

    for (const [id, object] of Object.entries(objects)) {
      if (!object || !BUILDING_TYPES.has(object.type ?? '')) continue;
      // Roots only; parts are folded in below.
      if (object.parents?.some((parent) => BUILDING_TYPES.has(objects[parent]?.type ?? ''))) {
        continue;
      }
      const building: RawBuilding = { id, attributes: {}, polygons: [] };
      if (this.stats.srsName) building.srsName = this.stats.srsName;
      for (const [key, value] of Object.entries(object.attributes ?? {})) {
        if (typeof value === 'string' || typeof value === 'number') {
          building.attributes[key] = String(value);
        }
      }
      const queue = [id];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        const node = objects[current];
        if (!node) continue;
        for (const child of node.children ?? []) queue.push(child);
        for (const geometry of node.geometry ?? []) {
          const lod = Number(geometry.lod ?? 0);
          const types = geometry.semantics?.surfaces ?? [];
          for (const { rings, semantic } of surfacesOf(geometry)) {
            if (!Array.isArray(rings) || rings.length === 0) continue;
            const kind: SurfaceKind =
              typeof semantic === 'number'
                ? (KINDS[types[semantic]?.type ?? ''] ?? 'other')
                : 'none';
            const parsed: Float64Array[] = [];
            let bad = false;
            for (let r = 0; r < rings.length; r++) {
              const ring = ringOf(rings[r]);
              if (ring) parsed.push(ring);
              else {
                this.stats.rejectedRings++;
                if (r === 0) bad = true;
              }
            }
            if (bad || parsed.length === 0) continue;
            const polygon: RawPolygon = {
              kind,
              lod: Number.isFinite(lod) ? lod : 0,
              rings: parsed,
            };
            building.polygons.push(polygon);
            this.stats.polygons++;
          }
        }
      }
      this.stats.buildings++;
      this.onBuilding(building);
    }
  }
}

/** Read a `.city.json` or `.city.jsonl` file; each building goes to `onBuilding`. */
export function readCityJson(path: string, onBuilding: (b: RawBuilding) => void): CityGmlStats {
  const text = readFileSync(path, 'utf8');
  const reader = new Reader(onBuilding);
  if (path.endsWith('.jsonl')) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const document = JSON.parse(line) as {
        type?: string;
        transform?: Transform;
        metadata?: { referenceSystem?: string };
        CityObjects?: Record<string, CityObject>;
        vertices?: unknown;
      };
      if (document.type === 'CityJSON') reader.header(document);
      else if (document.type === 'CityJSONFeature' && document.CityObjects) {
        reader.objects(document.CityObjects, document.vertices);
      }
    }
    return reader.stats;
  }
  const document = JSON.parse(text) as {
    type?: string;
    transform?: Transform;
    metadata?: { referenceSystem?: string };
    CityObjects?: Record<string, CityObject>;
    vertices?: unknown;
  };
  if (document.type !== 'CityJSON') throw new Error(`${path}: not a CityJSON document`);
  reader.header(document);
  reader.objects(document.CityObjects ?? {}, document.vertices);
  return reader.stats;
}
