/**
 * The landmark registry (`public/landmarks/registry.json`) is reviewed data
 * the map trusts: every entry must name a licence the app may redistribute,
 * its provenance, the OSM elements it replaces, and an asset that exists and
 * is the bytes it says (`docs/MAP_LANDMARKS.md`).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { landmarkCredits, landmarksNear, prepareLandmarks } from '@/lib/map/landmarks/load';
import { landmarkForPlace } from '@/lib/map/landmarks/match';
import {
  cityFeatureId,
  type LandmarkRegistry,
  landmarkRegistrySchema,
  parseLandmarkRegistry,
} from '@/lib/map/landmarks/registry';

const FRONTEND = join(import.meta.dir, '..', '..', '..');
const REPO = join(FRONTEND, '..', '..');
const raw = JSON.parse(readFileSync(join(FRONTEND, 'public/landmarks/registry.json'), 'utf8'));

function clone(): LandmarkRegistry {
  return structuredClone(raw) as LandmarkRegistry;
}

function problems(registry: unknown): string[] {
  const parsed = landmarkRegistrySchema.safeParse(registry);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('the committed registry', () => {
  const registry = parseLandmarkRegistry(raw);

  test('parses, and holds the landmarks this change ships', () => {
    expect(registry.landmarks.length).toBeGreaterThanOrEqual(10);
  });

  test('every asset exists, is the bytes the entry says, and is within budget', () => {
    for (const landmark of registry.landmarks) {
      const path = join(FRONTEND, 'public', landmark.model.path);
      expect(existsSync(path)).toBe(true);
      const bytes = readFileSync(path);
      expect(bytes.length).toBe(landmark.model.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(landmark.model.sha256);
      expect(landmark.model.bytes).toBeLessThanOrEqual(1024 * 1024);
      expect(landmark.model.triangles).toBeLessThanOrEqual(50_000);
      // glTF binary, version 2.
      expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
      expect(bytes.readUInt32LE(4)).toBe(2);
    }
  });

  test('every generator named exists in the repository', () => {
    for (const landmark of registry.landmarks) {
      if (landmark.model.generator) {
        expect(existsSync(join(REPO, landmark.model.generator))).toBe(true);
      }
    }
  });

  test('assets stand on their anchor (origin at the base: bounds start at y = 0)', () => {
    for (const landmark of registry.landmarks) {
      expect(Math.abs(landmark.model.boundsMeters.min[1])).toBeLessThan(0.05);
      expect(landmark.model.boundsMeters.max[1]).toBeGreaterThan(5);
    }
  });

  test('every replaced element maps to a city-tile feature id', () => {
    for (const landmark of registry.landmarks) {
      for (const element of landmark.osm.replaces) expect(cityFeatureId(element)).not.toBeNull();
    }
  });
});

describe('the schema refuses what may not ship', () => {
  test('a licence off the allow-list (NC, ND, unknown)', () => {
    for (const spdx of ['CC-BY-NC-4.0', 'CC-BY-ND-4.0', 'unknown', 'All rights reserved']) {
      const registry = clone();
      (registry.landmarks[0].licence as { spdx: string }).spdx = spdx;
      expect(problems(registry).some((p) => p.startsWith('landmarks.0.licence.spdx'))).toBe(true);
    }
  });

  test('CC BY without the credit it obliges', () => {
    const registry = clone();
    registry.landmarks[0].licence.spdx = 'CC-BY-4.0';
    registry.landmarks[0].licence.credit = null;
    expect(problems(registry)).toContain('landmarks.0.licence.credit: CC-BY-4.0 requires a credit');
  });

  test('a third-party asset without the https page its licence was checked at', () => {
    const registry = clone();
    registry.landmarks[0].licence.method = 'third-party';
    registry.landmarks[0].licence.source = 'some model from the internet';
    expect(problems(registry).some((p) => p.startsWith('landmarks.0.licence.source'))).toBe(true);
  });

  test('missing licence fields', () => {
    for (const field of ['author', 'source', 'verifiedAt', 'notes', 'derivedFrom']) {
      const registry = clone();
      delete (registry.landmarks[0].licence as Record<string, unknown>)[field];
      expect(problems(registry).some((p) => p.startsWith(`landmarks.0.licence.${field}`))).toBe(
        true,
      );
    }
  });

  test('two landmarks replacing the same building', () => {
    const registry = clone();
    registry.landmarks[1].osm.replaces = [registry.landmarks[0].osm.replaces[0]];
    expect(problems(registry).some((p) => p.includes('is already replaced by'))).toBe(true);
  });

  test('a placement the map cannot draw, and a malformed OSM element', () => {
    const registry = clone();
    registry.landmarks[0].placement = { position: { latitude: 91, longitude: 0 } };
    registry.landmarks[1].osm.element = 'building 12';
    const found = problems(registry);
    expect(found).toContain('landmarks.0.placement: not a drawable placement');
    expect(found.some((p) => p.startsWith('landmarks.1.osm.element'))).toBe(true);
  });

  test('an asset path that is not its id', () => {
    const registry = clone();
    registry.landmarks[0].model.path = '/landmarks/something-else.glb';
    expect(problems(registry)).toContain('landmarks.0.model.path: path must be the id');
  });
});

describe('cityFeatureId', () => {
  test("Planetiler's osmId × 10 + 2 (way) | 3 (relation); nodes are never buildings", () => {
    expect(cityFeatureId('way/34633854')).toBe(346338542);
    expect(cityFeatureId('relation/9194723')).toBe(91947233);
    expect(cityFeatureId('node/1')).toBeNull();
  });
});

describe('reading the registry at runtime', () => {
  const prepared = prepareLandmarks(parseLandmarkRegistry(raw), 'https://goway.to');

  test('assets resolve on the page origin and replaced elements become feature ids', () => {
    for (const p of prepared) {
      expect(p.url).toBe(`https://goway.to${p.entry.model.path}`);
      expect(p.hides.length).toBe(p.entry.osm.replaces.length);
    }
  });

  test('landmarksNear: within the radius, nearest first', () => {
    const near = landmarksNear(prepared, { latitude: 41.4036, longitude: 2.1744 }, 3_000);
    expect(near[0]?.entry.id).toBe('sagrada-familia');
    for (const p of near) expect(p.entry.locality).toBe('Barcelona');
    expect(landmarksNear(prepared, { latitude: 0, longitude: 0 }, 50_000)).toEqual([]);
  });

  test('credits: only for CC BY models that are drawn', () => {
    const cc0 = prepared[0];
    const ccBy = {
      ...cc0,
      entry: {
        ...cc0.entry,
        id: 'credited',
        licence: {
          ...cc0.entry.licence,
          spdx: 'CC-BY-4.0' as const,
          credit: 'Model by A. Author (CC BY 4.0)',
          source: 'https://example.org/model',
        },
      },
    };
    const all = [cc0, ccBy];
    expect(landmarkCredits(all, new Set())).toEqual([]);
    expect(landmarkCredits(all, new Set([cc0.entry.id]))).toEqual([]);
    expect(landmarkCredits(all, new Set([cc0.entry.id, 'credited']))).toEqual([
      { label: 'Model by A. Author (CC BY 4.0)', href: 'https://example.org/model' },
    ]);
  });

  test('a place is its landmark by its OSM source or Place ID, never by name', () => {
    const sagrada = prepared.find((p) => p.entry.id === 'sagrada-familia');
    expect(sagrada).toBeDefined();
    const element = sagrada?.entry.osm.element ?? '';
    expect(
      landmarkForPlace(prepared, {
        id: 'p1',
        sources: [{ source: 'openstreetmap', sourceId: element }],
      })?.entry.id,
    ).toBe('sagrada-familia');
    // Same element id from another source is not a match.
    expect(
      landmarkForPlace(prepared, { id: 'p1', sources: [{ source: 'other', sourceId: element }] }),
    ).toBeNull();
    // Catalonia has four other churches called Sagrada Família.
    expect(
      landmarkForPlace(prepared, {
        id: 'p2',
        sources: [{ source: 'openstreetmap', sourceId: 'way/1161606054' }],
      }),
    ).toBeNull();
  });
});
