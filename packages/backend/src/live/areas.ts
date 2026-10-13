/**
 * Where a source's vehicles can be: its operator's own stops, as a handful of
 * tight boxes. A source's `coverage` is one box round all of it — Renfe's
 * reaches from Galicia to Catalonia and so takes in Toulouse — and demand
 * matched against that one box would wake a feed (and read its static GTFS)
 * for a viewer hundreds of kilometres from its nearest station. Demand is
 * matched against these areas instead (`hub.ts`).
 *
 * Derived, never drawn by hand: `bun run --cwd packages/backend live:areas`
 * reads each source's static GTFS (`stops.txt`, or the shapes where a
 * portal publishes no stops) or its GBFS stations and rewrites
 * `areas.generated.ts`. The method: the points fall in 0.5° cells; each
 * row's run of neighbouring cells, merged with the identical runs above and
 * below it, is one box, shrunk to the points inside it and padded by
 * {@link AREA_PAD_DEGREES}. A line of stations stays one chain of boxes; the
 * empty land between two networks is in none.
 */

import type { GeoBoundingBox, LiveTransitMode } from '@goway/contracts';
import { LIVE_SOURCE_AREAS } from './areas.generated';

/** The grid the points are bucketed on, in degrees (~55 km of latitude). */
export const AREA_CELL_DEGREES = 0.5;
/** The margin round the points of each box (~5 km): a depot, a terminus loop. */
export const AREA_PAD_DEGREES = 0.05;

export interface SourceAreas {
  /** One box round every area: the source's `coverage`. */
  outer: GeoBoundingBox;
  areas: readonly GeoBoundingBox[];
}

/** What `live:areas` derived for one source, and from what. */
export interface DerivedSource extends SourceAreas {
  /** The day what it was derived from last changed (or was first read): `YYYY-MM-DD`. */
  readOn: string;
  /** SHA-256 of what it was derived from: the stops' positions and the route types. */
  sha256: string;
  /**
   * The modes its operator's `routes.txt` names (`modeOfRouteType`), sorted;
   * empty for bike share. A source's declared `transitModes` must include
   * every one (`modes.test.ts`).
   */
  modes: readonly LiveTransitMode[];
}

const round = (value: number) => Math.round(value * 100) / 100;

/** The areas of a set of points (`[latitude, longitude]`); `null` for none. */
export function areasOf(points: readonly (readonly [number, number])[]): SourceAreas | null {
  const cells = new Map<string, (readonly [number, number])[]>();
  const rows = new Map<number, Set<number>>();
  for (const point of points) {
    const [latitude, longitude] = point;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (Math.abs(latitude) > 85 || Math.abs(longitude) > 180) continue;
    if (latitude === 0 && longitude === 0) continue;
    const row = Math.floor((latitude + 90) / AREA_CELL_DEGREES);
    const column = Math.floor((longitude + 180) / AREA_CELL_DEGREES);
    const key = `${row}/${column}`;
    let list = cells.get(key);
    if (!list) {
      list = [];
      cells.set(key, list);
    }
    list.push(point);
    let columns = rows.get(row);
    if (!columns) {
      columns = new Set();
      rows.set(row, columns);
    }
    columns.add(column);
  }
  if (cells.size === 0) return null;

  // Each row's runs of neighbouring columns.
  const runs: { row: number; from: number; to: number }[] = [];
  for (const [row, columns] of rows) {
    const sorted = [...columns].sort((a, b) => a - b);
    let from = sorted[0] as number;
    let to = from;
    for (const column of sorted.slice(1)) {
      if (column === to + 1) {
        to = column;
        continue;
      }
      runs.push({ row, from, to });
      from = column;
      to = column;
    }
    runs.push({ row, from, to });
  }
  // The same run in consecutive rows is one block.
  runs.sort((a, b) => a.from - b.from || a.to - b.to || a.row - b.row);
  const blocks: { first: number; last: number; from: number; to: number }[] = [];
  for (const run of runs) {
    const previous = blocks[blocks.length - 1];
    if (
      previous &&
      previous.from === run.from &&
      previous.to === run.to &&
      previous.last === run.row - 1
    ) {
      previous.last = run.row;
      continue;
    }
    blocks.push({ first: run.row, last: run.row, from: run.from, to: run.to });
  }

  const areas: GeoBoundingBox[] = [];
  for (const block of blocks) {
    let west = Number.POSITIVE_INFINITY;
    let south = Number.POSITIVE_INFINITY;
    let east = Number.NEGATIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;
    for (let row = block.first; row <= block.last; row++) {
      for (let column = block.from; column <= block.to; column++) {
        for (const [latitude, longitude] of cells.get(`${row}/${column}`) ?? []) {
          west = Math.min(west, longitude);
          east = Math.max(east, longitude);
          south = Math.min(south, latitude);
          north = Math.max(north, latitude);
        }
      }
    }
    areas.push({
      west: round(west - AREA_PAD_DEGREES),
      south: round(south - AREA_PAD_DEGREES),
      east: round(east + AREA_PAD_DEGREES),
      north: round(north + AREA_PAD_DEGREES),
    });
  }
  areas.sort((a, b) => a.west - b.west || a.south - b.south);
  return {
    outer: {
      west: Math.min(...areas.map((area) => area.west)),
      south: Math.min(...areas.map((area) => area.south)),
      east: Math.max(...areas.map((area) => area.east)),
      north: Math.max(...areas.map((area) => area.north)),
    },
    areas,
  };
}

/** A source's derived areas, when its stops are known (`areas.generated.ts`). */
export function sourceAreas(sourceId: string): DerivedSource | null {
  return LIVE_SOURCE_AREAS[sourceId] ?? null;
}

/**
 * A source's `coverage`: its derived outer box, or `fallback` until
 * `live:areas` has derived one (a new source; `areas.test.ts` fails the build
 * for a source with stops and no areas).
 */
export function derivedCoverage(sourceId: string, fallback: GeoBoundingBox): GeoBoundingBox {
  return sourceAreas(sourceId)?.outer ?? fallback;
}

/** Whether a box (a watched room) meets a source's areas, or its coverage when it has none. */
export function meetsSource(
  source: { id: string; coverage: GeoBoundingBox | null },
  box: GeoBoundingBox,
): boolean {
  const derived = sourceAreas(source.id);
  if (derived) return derived.areas.some((area) => intersects(area, box));
  return source.coverage === null || intersects(source.coverage, box);
}

function intersects(a: GeoBoundingBox, b: GeoBoundingBox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}
