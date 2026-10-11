/**
 * Which railway lines run UNDERGROUND, read from the basemap's own
 * OpenStreetMap data — pure arithmetic, no MapLibre.
 *
 * OpenMapTiles' `transportation` layer carries every railway (`class` `rail`
 * or `transit`: rail, subway, light rail, tram) with OSM's `brunnel=tunnel`
 * and `layer`. A live train is placed on its operator's published track; that
 * track is somewhere under or over one of these lines. Whichever line is
 * NEAREST it decides: a tunnel (`brunnel=tunnel`, or a negative `layer` — the
 * tag a mapper uses for a cutting or a station box) means the train is below
 * the street, and is not drawn standing on it (`liveLayer.web.ts`).
 *
 * No line within {@link RAIL_MATCH_METERS}: unknown (`null`) — the caller
 * keeps what it last knew. The basemap only carries tunnels from z13 tiles.
 */

/** How far a train may be from an OSM railway and still be on it. */
export const RAIL_MATCH_METERS = 35;
/** The grid the lines are bucketed in, in degrees (~110 m of latitude). */
const CELL_DEGREES = 0.001;
const METRES_PER_DEGREE = 111_195;

export interface RailLine {
  /** `[longitude, latitude]` positions. */
  coordinates: readonly (readonly [number, number])[];
  tunnel: boolean;
}

/** A vector-tile feature, as `querySourceFeatures` hands it back. */
export interface RailFeature {
  properties?: Record<string, unknown> | null;
  geometry: { type: string; coordinates?: unknown };
}

const RAIL_CLASSES = new Set(['rail', 'transit']);

/** Whether OSM says a railway feature is below ground. */
export function isTunnel(properties: Record<string, unknown>): boolean {
  if (properties.brunnel === 'tunnel') return true;
  const layer = Number(properties.layer);
  return Number.isFinite(layer) && layer < 0;
}

/** The railway lines among basemap features (others, and malformed ones, skipped). */
export function railLinesOf(features: readonly RailFeature[]): RailLine[] {
  const lines: RailLine[] = [];
  for (const feature of features) {
    const properties = feature.properties ?? {};
    if (!RAIL_CLASSES.has(String(properties.class))) continue;
    const tunnel = isTunnel(properties);
    const { type, coordinates } = feature.geometry;
    const parts =
      type === 'LineString' ? [coordinates] : type === 'MultiLineString' ? coordinates : null;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!Array.isArray(part)) continue;
      const points = part.filter(
        (p): p is [number, number] =>
          Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
      );
      if (points.length >= 2) lines.push({ coordinates: points, tunnel });
    }
  }
  return lines;
}

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  tunnel: boolean;
}

/** The nearest-line lookup over a set of railway lines. */
export class RailIndex {
  private readonly cells = new Map<string, Segment[]>();

  constructor(lines: readonly RailLine[]) {
    const pad = RAIL_MATCH_METERS / METRES_PER_DEGREE;
    for (const line of lines) {
      for (let i = 0; i + 1 < line.coordinates.length; i++) {
        const [ax, ay] = line.coordinates[i] as readonly [number, number];
        const [bx, by] = line.coordinates[i + 1] as readonly [number, number];
        const segment = { ax, ay, bx, by, tunnel: line.tunnel };
        // Longitude padding is wider than latitude's away from the equator;
        // pad by the larger (at up to ~70°) so no near segment is missed.
        const lonPad = pad * 3;
        const x0 = Math.floor((Math.min(ax, bx) - lonPad) / CELL_DEGREES);
        const x1 = Math.floor((Math.max(ax, bx) + lonPad) / CELL_DEGREES);
        const y0 = Math.floor((Math.min(ay, by) - pad) / CELL_DEGREES);
        const y1 = Math.floor((Math.max(ay, by) + pad) / CELL_DEGREES);
        // A pathological segment (a tile-crossing straight line) is skipped
        // rather than flooding the grid.
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) continue;
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            const key = `${x}/${y}`;
            let cell = this.cells.get(key);
            if (!cell) {
              cell = [];
              this.cells.set(key, cell);
            }
            cell.push(segment);
          }
        }
      }
    }
  }

  get empty(): boolean {
    return this.cells.size === 0;
  }

  /**
   * Whether the railway nearest a position runs underground; `null` when no
   * railway is within {@link RAIL_MATCH_METERS}.
   */
  underground(latitude: number, longitude: number): boolean | null {
    const cell = this.cells.get(
      `${Math.floor(longitude / CELL_DEGREES)}/${Math.floor(latitude / CELL_DEGREES)}`,
    );
    if (!cell) return null;
    const kx = METRES_PER_DEGREE * Math.cos((latitude * Math.PI) / 180);
    let best = RAIL_MATCH_METERS;
    let verdict: boolean | null = null;
    for (const s of cell) {
      // Local metres, relative to the position.
      const ax = (s.ax - longitude) * kx;
      const ay = (s.ay - latitude) * METRES_PER_DEGREE;
      const bx = (s.bx - longitude) * kx;
      const by = (s.by - latitude) * METRES_PER_DEGREE;
      const dx = bx - ax;
      const dy = by - ay;
      const length2 = dx * dx + dy * dy;
      const t = length2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2)) : 0;
      const distance = Math.hypot(ax + t * dx, ay + t * dy);
      if (distance <= best) {
        best = distance;
        verdict = s.tunnel;
      }
    }
    return verdict;
  }
}
