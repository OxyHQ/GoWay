/**
 * The shared model library (`lib/map/modelLibrary.ts`, `engine/vehicles/`):
 * the manifest matches the files, every asset is licensed and in budget,
 * every model loads into the profile its consumers rely on — and city life
 * and the live layer draw only from it.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, test } from 'bun:test';

import { MODEL_CATALOGUE_FIXTURE } from '@/lib/map/modelCatalogue';
import { MODEL_BUDGETS, MODEL_LIBRARY_PATH, parseModelLibrary } from '@/lib/map/modelLibrary';

import { PERSON_HIP_M, PERSON_PART, person } from '../engine/cityLife/people';
import { taxiLiveryAt } from '../engine/cityLife/sim/liveries';
import { CAR_MODEL_SPECS, CAR_MODELS, slotRanges } from '../engine/cityLife/sim/fleet';
import { LIVE_LIBRARY_KEYS } from '../engine/live3d/liveModels';
import type { LibraryModel } from '../engine/vehicles/library';
import type * as THREE from 'three';
import { LIBRARY_DIR, readLibrary, readManifest } from './libraryFromDisk';

const manifest = readManifest();

/**
 * Of a level's edges (corners matched by position), the share no face shares
 * the other way round — a hole's rim — and the share two faces wind the same
 * way — a fold or a flipped face.
 */
function edgeHealth(geometry: THREE.BufferGeometry): { open: number; doubled: number } {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!index) throw new Error('not indexed');
  const at = (i: number) =>
    [position.getX(i), position.getY(i), position.getZ(i)].map((v) => v.toFixed(3)).join(',');
  const edges = new Map<string, number>();
  for (let t = 0; t < index.count; t += 3) {
    const corners = [at(index.getX(t)), at(index.getX(t + 1)), at(index.getX(t + 2))];
    for (let k = 0; k < 3; k++) {
      const edge = `${corners[k]}|${corners[(k + 1) % 3]}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  let open = 0;
  let doubled = 0;
  for (const [edge, count] of edges) {
    const [a, b] = edge.split('|');
    if (count === 1 && !edges.has(`${b}|${a}`)) open++;
    if (count > 1) doubled++;
  }
  return { open: open / edges.size, doubled: doubled / edges.size };
}
let library: Map<string, LibraryModel>;
beforeAll(async () => {
  library = await readLibrary();
});

describe('the manifest', () => {
  test('lists exactly the files on disk, at their size and hash', () => {
    const files = readdirSync(LIBRARY_DIR).filter((f) => f.endsWith('.glb'));
    expect(manifest.models.map((m) => m.file).sort()).toEqual(files.sort());
    for (const entry of manifest.models) {
      const bytes = readFileSync(join(LIBRARY_DIR, entry.file));
      expect({ key: entry.key, bytes: bytes.length }).toEqual({
        key: entry.key,
        bytes: entry.bytes,
      });
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    }
  });

  test('every asset is CC0, Kenney or GoWay’s own, with provenance', () => {
    for (const { key, licence } of manifest.models) {
      expect({ key, spdx: licence.spdx }).toEqual({ key, spdx: 'CC0-1.0' });
      if (licence.method === 'third-party') {
        expect(licence.author).toBe('Kenney (www.kenney.nl)');
        expect(licence.source).toMatch(/^https:\/\/kenney\.nl\/assets\//);
      } else {
        expect(licence.method).toBe('procedural');
        expect(licence.source).toMatch(/^packages\/frontend\/scripts\/library\//);
      }
    }
  });

  test('the schema refuses a model over its budget', () => {
    const sedan = manifest.models.find((m) => m.key === 'vehicle.sedan');
    expect(() =>
      parseModelLibrary({ version: 1, models: [{ ...sedan, triangles: { near: 1101, far: 10 } }] }),
    ).toThrow();
  });
});

describe('every model', () => {
  test('loads as two merged levels within budget, standing on the ground', () => {
    for (const [key, model] of library) {
      const budget = MODEL_BUDGETS[model.entry.kind];
      expect({ key, near: model.near.triangles }).toEqual({
        key,
        near: model.entry.triangles.near,
      });
      expect({ key, far: model.far.triangles }).toEqual({ key, far: model.entry.triangles.far });
      expect(model.near.triangles).toBeLessThanOrEqual(budget.near);
      expect(model.far.triangles).toBeLessThanOrEqual(budget.far);
      // The near level stands on y = 0 (a far vehicle has no wheels to stand on).
      model.near.geometry.computeBoundingBox();
      const ground = Math.abs(model.near.geometry.boundingBox?.min.y ?? 1) < 0.08;
      expect({ key, ground }).toEqual({ key, ground: true });
      for (const level of [model.near, model.far]) {
        const g = level.geometry;
        for (const name of ['position', 'normal', 'color', 'paint']) {
          expect({ key, name, has: Boolean(g.getAttribute(name)) }).toEqual({
            key,
            name,
            has: true,
          });
        }
        const paint = g.getAttribute('paint');
        for (let i = 0; i < paint.count; i++) expect([0, 1]).toContain(paint.getX(i));
      }
    }
  });

  test('cars, buses and aircraft have a tintable body', () => {
    for (const [key, model] of library) {
      if (!['car', 'bus', 'aircraft'].includes(model.entry.kind)) continue;
      const painted = (model.near.geometry.getAttribute('paint').array as Float32Array).some(
        (v) => v > 0,
      );
      expect({ key, painted }).toEqual({ key, painted: true });
    }
  });

  /**
   * The surface is whole: every edge of a road vehicle's near level is shared
   * with a face wound the other way (a closed, consistently wound skin), but
   * for the few the kit itself leaves open (and the hub discs): ≤ 2.3% today.
   * The first library squeezed each 2,000-triangle kit car into 800 with a
   * permissive simplifier — it spent the budget on the wheels, tore the body
   * (7.2–9.6% of its edges open) and the cars looked broken.
   */
  test('a road vehicle’s near level is a whole surface, not a torn one', () => {
    for (const [key, model] of library) {
      if (!['car', 'van', 'truck', 'bus'].includes(model.entry.kind)) continue;
      const { open, doubled } = edgeHealth(model.near.geometry);
      expect({ key, open: open < 0.03 }).toEqual({ key, open: true });
      expect({ key, doubled: doubled < 0.01 }).toEqual({ key, doubled: true });
    }
  });

  test('every far level is closed boxes', () => {
    for (const [key, model] of library) {
      if (model.entry.kind === 'bus' || model.entry.kind === 'aircraft') continue;
      const { open, doubled } = edgeHealth(model.far.geometry);
      expect({ key, open, doubled }).toEqual({ key, open: 0, doubled: 0 });
    }
  });
});

describe('the frame', () => {
  test('front is +Z: the delivery truck’s box (its paint) is behind its cab', () => {
    const truck = library.get('vehicle.truck') as LibraryModel;
    const position = truck.near.geometry.getAttribute('position');
    const paint = truck.near.geometry.getAttribute('paint');
    let sum = 0;
    let n = 0;
    for (let i = 0; i < position.count; i++) {
      if (paint.getX(i) < 0.5) continue;
      sum += position.getZ(i);
      n++;
    }
    expect(n).toBeGreaterThan(0);
    expect(sum / n).toBeLessThan(-0.3);
  });

  test('the bus’s headlamps are at +Z', () => {
    const bus = library.get('vehicle.bus') as LibraryModel;
    bus.near.geometry.computeBoundingBox();
    expect(bus.near.geometry.boundingBox?.max.z ?? 0).toBeGreaterThan(5.9);
  });
});

describe('one library for everything that draws vehicles', () => {
  test('the SDK model catalogue’s car is the library’s saloon', () => {
    expect(MODEL_CATALOGUE_FIXTURE['vehicle.car']?.url).toBe(
      `${MODEL_LIBRARY_PATH}/vehicle.sedan.glb`,
    );
  });

  test('city life and the live layer draw only library models', () => {
    const keys = new Set(manifest.models.map((m) => m.key));
    for (const model of CAR_MODELS) expect(keys.has(`vehicle.${model}`)).toBe(true);
    for (const key of LIVE_LIBRARY_KEYS) expect(keys.has(key)).toBe(true);
  });
});

describe('slots', () => {
  test('per-model car ranges tile the pool exactly, by share', () => {
    for (const capacity of [1, 7, 40, 600]) {
      const ranges = slotRanges(CAR_MODELS, (m) => CAR_MODEL_SPECS[m].share, capacity);
      let at = 0;
      for (const model of CAR_MODELS) {
        const [from, to] = ranges[model];
        expect(from).toBe(at);
        expect(to).toBeGreaterThanOrEqual(from);
        at = to;
      }
      expect(at).toBe(capacity);
    }
  });
});

describe('people', () => {
  test('city life’s own rounded walkers: two legs that swing, a body, a head', () => {
    const near = person('near');
    const parts = new Set(near.parts);
    for (const part of Object.values(PERSON_PART)) expect(parts.has(part)).toBe(true);
    expect(near.indices.length / 3).toBeLessThanOrEqual(300);
    expect(person('far').indices.length / 3).toBeLessThanOrEqual(50);
    // The legs hang from the hip they swing about.
    for (let i = 0; i < near.parts.length; i++) {
      if (near.parts[i] === PERSON_PART.legLeft || near.parts[i] === PERSON_PART.legRight) {
        expect(near.positions[i * 3 + 2]).toBeLessThanOrEqual(PERSON_HIP_M + 0.05);
      }
    }
  });
});

describe('taxi liveries', () => {
  test('only where a city has one', () => {
    expect(taxiLiveryAt(2.164, 41.392)?.doors).toEqual([238, 200, 70]); // Barcelona: yellow doors
    expect(taxiLiveryAt(-74.006, 40.712)?.body).toEqual([242, 198, 64]); // New York: yellow
    expect(taxiLiveryAt(-0.12, 51.5)).toBeNull();
    expect(taxiLiveryAt(139.77, 35.68)).toBeNull();
  });
});
