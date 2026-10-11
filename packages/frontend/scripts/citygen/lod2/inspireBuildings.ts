/**
 * A streaming reader for INSPIRE Buildings 2D `BuildingPart`s — the Spanish
 * Catastro's `A.ES.SDGC.BU.<municipality>.buildingpart.gml` — yielding each
 * part's footprint and its RECORDED storeys above ground.
 *
 * A Catastro building part is a volume of one cadastral building with one
 * floor count (`bu-ext2d:numberOfFloorsAboveGround`); a building is usually a
 * few of them (the street block, the rear wing, the courtyard roof at one
 * storey). The cadastral reference (`0004701DF3800C`) is the part id before
 * `_part`. Geometry is a `gml:Surface` of `PolygonPatch`es in the province's
 * ETRS89 UTM zone (`EPSG:25830` Madrid, `EPSG:25831` Barcelona), 2D.
 *
 * Like `cityGml.ts`, it is not an XML parser: each `featureMember` is small,
 * so the file is read in chunks and cut at every `</…BuildingPart>`, and the
 * few fields needed are read from that member with patterns. Files are
 * ISO-8859-1 (the Catastro's own declaration); every field read is ASCII.
 * The input is UNTRUSTED: a ring that does not parse, a floor count that is
 * not a small whole number, and a part with no geometry are dropped and
 * counted, never coerced.
 */
import { closeSync, openSync, readSync } from 'node:fs';

import { parseRing } from './cityGml';

export interface InspirePart {
  /** `0004701DF3800C_part1`. */
  id: string;
  /** The cadastral building the part belongs to: `0004701DF3800C`. */
  reference: string;
  /** Storeys above ground, as recorded; `null` when the record has none. */
  floorsAbove: number | null;
  floorsBelow: number | null;
  srsName?: string;
  /** Polygons: exterior first, then holes; each `[x, y, 0, …]` with the closing point dropped. */
  polygons: Float64Array[][];
}

export interface InspireStats {
  parts: number;
  rejectedRings: number;
  noFloors: number;
  srsName?: string;
}

const MEMBER_END = /<\/(?:[\w.-]+:)?BuildingPart\s*>/g;
const FLOOR_LIMIT = 200;

function floors(member: string, element: string): number | null {
  const match = new RegExp(`<(?:[\\w.-]+:)?${element}\\b[^>]*>\\s*([^<\\s]*)\\s*<`).exec(member);
  if (!match || match[1] === '') return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 0 && value <= FLOOR_LIMIT ? value : null;
}

/** One `BuildingPart` member's text → a part, or `null` with the reason counted. */
export function parseInspirePart(member: string, stats: InspireStats): InspirePart | null {
  const id = /\bgml:id\s*=\s*"(?:ES\.SDGC\.BU\.)?([^"]+)"/.exec(member)?.[1];
  if (!id) return null;
  const srsName = /\bsrsName\s*=\s*"([^"]+)"/.exec(member)?.[1];
  const polygons: Float64Array[][] = [];
  const patches = member.split(/<(?:[\w.-]+:)?(?:PolygonPatch|Polygon)\b[^>]*>/).slice(1);
  for (const patch of patches) {
    const rings: Float64Array[] = [];
    let exteriorOk = true;
    const ringPattern =
      /<(?:[\w.-]+:)?(exterior|interior)\b[^>]*>[\s\S]*?<(?:[\w.-]+:)?posList\b([^>]*)>([^<]*)</g;
    for (let m = ringPattern.exec(patch); m; m = ringPattern.exec(patch)) {
      const dimension = Number(/srsDimension\s*=\s*"(\d)"/.exec(m[2])?.[1] ?? 2);
      const ring = parseRing(m[3], dimension);
      if (!ring) {
        stats.rejectedRings++;
        if (m[1] === 'exterior') exteriorOk = false;
        continue;
      }
      if (m[1] === 'exterior') rings.unshift(ring);
      else rings.push(ring);
    }
    if (exteriorOk && rings.length > 0) polygons.push(rings);
  }
  if (polygons.length === 0) return null;
  const floorsAbove = floors(member, 'numberOfFloorsAboveGround');
  if (floorsAbove === null) stats.noFloors++;
  return {
    id,
    reference: id.replace(/_part\d+$/, ''),
    floorsAbove,
    floorsBelow: floors(member, 'numberOfFloorsBelowGround'),
    srsName,
    polygons,
  };
}

/** Read every `BuildingPart` of a file, handing each to `onPart`. Bounded memory. */
export function readInspireBuildingParts(
  path: string,
  onPart: (part: InspirePart) => void,
): InspireStats {
  const stats: InspireStats = { parts: 0, rejectedRings: 0, noFloors: 0 };
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  const decoder = new TextDecoder('latin1');
  let buffer = '';
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      buffer +=
        read === 0 ? decoder.decode() : decoder.decode(chunk.subarray(0, read), { stream: true });
      let start = 0;
      MEMBER_END.lastIndex = 0;
      for (let m = MEMBER_END.exec(buffer); m; m = MEMBER_END.exec(buffer)) {
        const member = buffer.slice(start, m.index);
        start = m.index + m[0].length;
        const open = member.search(/<(?:[\w.-]+:)?BuildingPart\b/);
        if (open === -1) continue;
        const part = parseInspirePart(member.slice(open), stats);
        if (!part) continue;
        stats.parts++;
        if (!stats.srsName && part.srsName) stats.srsName = part.srsName;
        onPart(part);
      }
      buffer = buffer.slice(start);
      if (read === 0) break;
    }
  } finally {
    closeSync(fd);
  }
  return stats;
}
