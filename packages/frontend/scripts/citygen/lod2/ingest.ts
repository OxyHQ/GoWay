/**
 * Files of one official 3D dataset → the prepared buildings inside an area,
 * with what the receipt needs to name exactly which bytes they came from.
 *
 * The files are passed in by whoever runs the compiler (`--lod2=<source>:<files>`);
 * nothing here downloads anything, so the compiler never runs on bytes nobody
 * chose. Each file's SHA-256 goes into the receipt beside its name and size —
 * a published archive must say what it was derived from, and the dataset
 * pages do not version their files.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { type CityGmlStats, type RawBuilding, readCityGml } from './cityGml';
import { readCityJson } from './cityJson';
import { type InspirePart, readInspireBuildingParts } from './inspireBuildings';
import { type Crs, crsFromName } from './crs';
import {
  emptyPrepareStats,
  mercX,
  mercY,
  type PreparedBuilding,
  type PrepareStats,
  prepareBuilding,
  prepareInspireBuilding,
} from './prepare';
import { STOREY_MODELS } from '../storeys';
import type { Lod2SourceInfo } from './sources';

export interface IngestedFile {
  file: string;
  bytes: number;
  sha256: string;
  buildings: number;
  polygons: number;
  rejectedRings: number;
  srs?: string;
}

export interface IngestResult {
  buildings: PreparedBuilding[];
  files: IngestedFile[];
  prepare: PrepareStats;
  /** Prepared buildings whose representative point fell outside the area. */
  outside: number;
  crs: string[];
}

function sha256(path: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.alloc(16 * 1024 * 1024);
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hasher.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hasher.digest('hex');
}

export function ingest(
  source: Lod2SourceInfo,
  files: readonly string[],
  bbox: [number, number, number, number] | undefined,
  log: (line: string) => void = () => {},
): IngestResult {
  const box = bbox
    ? { x0: mercX(bbox[0]), x1: mercX(bbox[2]), y0: mercY(bbox[3]), y1: mercY(bbox[1]) }
    : null;
  const buildings: PreparedBuilding[] = [];
  const prepare = emptyPrepareStats();
  const crsCache = new Map<string, Crs>();
  const result: IngestResult = { buildings, files: [], prepare, outside: 0, crs: [] };

  for (const file of files) {
    const started = performance.now();
    const onBuilding = (raw: RawBuilding) => {
      const srs = raw.srsName ?? source.defaultSrs;
      if (!srs) {
        throw new Error(
          `${file}: building ${raw.id} declares no CRS and the source has no default`,
        );
      }
      let crs = crsCache.get(srs);
      if (!crs) {
        const resolved = crsFromName(srs);
        if (!resolved) throw new Error(`${file}: unsupported CRS ${srs} (see lod2/crs.ts)`);
        crs = resolved;
        crsCache.set(srs, crs);
        if (!result.crs.includes(crs.name)) result.crs.push(crs.name);
      }
      const prepared = prepareBuilding(raw, { crs, idAttributes: source.idAttributes }, prepare);
      if (!prepared) return;
      const [px, py] = prepared.point;
      if (box && !(px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1)) {
        result.outside++;
        return;
      }
      buildings.push(prepared);
    };
    const json = /\.(city\.)?jsonl?$/.test(file);
    const stats =
      source.format === 'inspire-bu'
        ? readInspire(file, source, box, result, prepare, crsCache)
        : source.format === 'cityjson' || json
          ? readCityJson(file, onBuilding)
          : readCityGml(file, onBuilding);
    result.files.push({
      file: basename(file),
      bytes: statSync(file).size,
      sha256: sha256(file),
      buildings: stats.buildings,
      polygons: stats.polygons,
      rejectedRings: stats.rejectedRings,
      srs: stats.srsName,
    });
    log(
      `  lod2 read   ${basename(file)}: ${stats.buildings} buildings, ${stats.polygons} polygons in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
  }
  return result;
}

/** A margin around the area, in mercator units (~1 km), for parts whose building straddles it. */
const AREA_MARGIN = 1 / 40000;

/**
 * INSPIRE building parts → buildings, grouped by cadastral reference. Parts
 * nowhere near the area are dropped as they are read (a municipality's file
 * is gigabytes; the area is a few square kilometres of it).
 */
function readInspire(
  file: string,
  source: Lod2SourceInfo,
  box: { x0: number; x1: number; y0: number; y1: number } | null,
  result: IngestResult,
  prepare: PrepareStats,
  crsCache: Map<string, Crs>,
): CityGmlStats {
  const groups = new Map<string, { parts: InspirePart[]; crs: Crs }>();
  const stats = readInspireBuildingParts(file, (part) => {
    const srs = part.srsName ?? source.defaultSrs;
    if (!srs) throw new Error(`${file}: part ${part.id} declares no CRS`);
    let crs = crsCache.get(srs);
    if (!crs) {
      const resolved = crsFromName(srs);
      if (!resolved) throw new Error(`${file}: unsupported CRS ${srs} (see lod2/crs.ts)`);
      crs = resolved;
      crsCache.set(srs, crs);
      if (!result.crs.includes(crs.name)) result.crs.push(crs.name);
    }
    if (box) {
      const ring = part.polygons[0][0];
      const [lon, lat] = crs.toLonLat(ring[0], ring[1]);
      const x = mercX(lon);
      const y = mercY(lat);
      if (
        x < box.x0 - AREA_MARGIN ||
        x > box.x1 + AREA_MARGIN ||
        y < box.y0 - AREA_MARGIN ||
        y > box.y1 + AREA_MARGIN
      ) {
        return;
      }
    }
    const group = groups.get(part.reference);
    if (group) group.parts.push(part);
    else groups.set(part.reference, { parts: [part], crs });
  });
  for (const [reference, { parts, crs }] of groups) {
    const prepared = prepareInspireBuilding(
      reference,
      parts,
      crs,
      prepare,
      STOREY_MODELS[source.policy.storeys ?? 'es'],
    );
    if (!prepared) continue;
    const [px, py] = prepared.point;
    if (box && !(px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1)) {
      result.outside++;
      continue;
    }
    result.buildings.push(prepared);
  }
  return {
    buildings: groups.size,
    polygons: stats.parts,
    rejectedRings: stats.rejectedRings,
    srsName: stats.srsName,
  };
}
