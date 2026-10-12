/**
 * A licensed import on disk, as an operator would hand it to
 * `street3d:admin import-licensed`: a chunked RAD tree laid out the way Spark's
 * `build-lod` writes one (`<name>-lod.rad` beside `<name>-lod-<n>.radc`), an
 * optional environment tree, a JPEG poster and the JSON manifest naming them.
 *
 * The bytes after each magic are filler: the backend reads headers and checks
 * chunk sizes and magics, and never decodes a splat.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RAD_CHUNK_MAGIC, RAD_MAGIC } from '../radHeader';

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

/** A RAD header: magic, metadata length, JSON, zero padding to 8 bytes, then any inline data. */
export function radHeaderBytes(meta: unknown, inline: Uint8Array = new Uint8Array()): Buffer {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const padding = Buffer.alloc((8 - (json.length % 8)) % 8);
  return Buffer.concat([u32(RAD_MAGIC), u32(json.length), json, padding, inline]);
}

/** Write `<name>-lod.rad` and its chunks into `dir`. Returns the header's file name. */
export function writeRadTree(
  dir: string,
  name: string,
  options: { chunks?: number; gaussians?: number; seed?: string } = {},
): string {
  const chunks = Array.from({ length: options.chunks ?? 3 }, (_, index) => {
    const filename = `${name}-lod-${index}.radc`;
    const bytes = Buffer.concat([
      u32(RAD_CHUNK_MAGIC),
      Buffer.from(options.seed ?? ''),
      randomBytes(64 + index),
    ]);
    writeFileSync(join(dir, filename), bytes);
    return { offset: 0, bytes: bytes.length, filename };
  });
  const header = `${name}-lod.rad`;
  writeFileSync(
    join(dir, header),
    radHeaderBytes({
      version: 1,
      type: 'gsplat',
      count: options.gaussians ?? 2_400_000,
      lodTree: true,
      chunkSize: 65536,
      allChunkBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
      chunks,
    }),
  );
  return header;
}

/** A JPEG's first bytes, then filler. */
export function writePoster(dir: string, name = 'poster.jpg'): string {
  writeFileSync(
    join(dir, name),
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(256)]),
  );
  return name;
}

/** Kabukicho Ichibangai, Shinjuku: the gate on Yasukuni-dori, looking north. */
export const KABUKICHO = { latitude: 35.69388, longitude: 139.70224, altitudeMeters: 39.5 };

/** A complete, valid manifest for the files {@link writeLicensedImport} lays out, around `at`. */
export function importManifest(
  overrides: Record<string, unknown> = {},
  at: { latitude: number; longitude: number; altitudeMeters: number } = KABUKICHO,
): Record<string, unknown> {
  const { latitude, longitude } = at;
  const d = 0.0009;
  return {
    schemaVersion: 1,
    anchor: at,
    enuFromScene: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    initialView: { position: [0, -20, 1.6], target: [0, 10, 1.6] },
    navigation: {
      viewpoints: [
        { position: [0, -20, 1.6], forward: [0, 1, 0] },
        { position: [0, -10, 1.6], forward: [0, 1, 0] },
        { position: [0.4, -10.2, 1.6], forward: [0, 1, 0] },
      ],
      fieldOfView: { horizontalDegrees: 90, verticalDegrees: 70 },
    },
    footprint: {
      type: 'Polygon',
      coordinates: [
        [
          [longitude - d, latitude - d],
          [longitude + d, latitude - d],
          [longitude + d, latitude + d],
          [longitude - d, latitude + d],
          [longitude - d, latitude - d],
        ],
      ],
    },
    bounds: {
      west: longitude - d,
      south: latitude - d,
      east: longitude + d,
      north: latitude + d,
    },
    observedFrom: '2026-09-13T13:00:00.000Z',
    observedTo: '2026-09-14T15:00:00.000Z',
    attributions: ['3D scan © Kawaii World Industries Co., Ltd. (Locahun 3D)'],
    licence: {
      licensor: 'Kawaii World Industries Co., Ltd. (Locahun 3D)',
      name: 'Locahun 3D scan licence',
      tier: 'Commercial',
      grantReference: 'LH3D-TEST-0001',
      grantedAt: '2026-09-20',
      permits: ['public_display', 'format_conversion', 'commercial_use'],
    },
    privacy: {
      basis: 'licensor_redacted',
      reviewedBy: 'operator@goway.test',
      note: 'Licensor blurred faces and plates; reviewed the whole street at street level.',
    },
    placement: 'approximate',
    placementNote: 'Placed by hand against OpenStreetMap building outlines.',
    alignmentResidualMeters: 4,
    provenance: {
      components: { capture: 'XGRIDS PortalCam', 'spark-build-lod': '2.3.1' },
    },
    assets: {
      splat: 'kabukicho-lod.rad',
      environment: 'kabukicho-env-lod.rad',
      poster: 'poster.jpg',
    },
    ...overrides,
  };
}

export interface ImportOnDisk {
  dir: string;
  manifestPath: string;
  writeManifest(manifest: Record<string, unknown>): void;
}

/** Lay out a whole licensed import in a fresh directory. */
export function writeLicensedImport(
  overrides: Record<string, unknown> = {},
  options: {
    seed?: string;
    at?: { latitude: number; longitude: number; altitudeMeters: number };
  } = {},
): ImportOnDisk {
  const dir = mkdtempSync(join(tmpdir(), 'goway-licensed-import-'));
  mkdirSync(dir, { recursive: true });
  writeRadTree(dir, 'kabukicho', { chunks: 3, ...(options.seed ? { seed: options.seed } : {}) });
  writeRadTree(dir, 'kabukicho-env', { chunks: 1, gaussians: 50_000 });
  writePoster(dir);
  const manifestPath = join(dir, 'import.json');
  const writeManifest = (manifest: Record<string, unknown>) =>
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeManifest(importManifest(overrides, options.at));
  return { dir, manifestPath, writeManifest };
}
