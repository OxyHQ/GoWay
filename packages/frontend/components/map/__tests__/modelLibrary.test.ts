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

import { taxiLiveryAt } from '../engine/cityLife/sim/liveries';
import {
  CAR_MODEL_SPECS,
  CAR_MODELS,
  PERSON_MODEL_SPECS,
  PERSON_MODELS,
  slotRanges,
  WHEELCHAIR,
} from '../engine/cityLife/sim/fleet';
import type { Network } from '../engine/cityLife/sim/network';
import { chooseEdge } from '../engine/cityLife/sim/pedestrians';
import { createRng } from '../engine/cityLife/sim/rng';
import { LIVE_LIBRARY_KEYS } from '../engine/live3d/liveModels';
import type { LibraryModel } from '../engine/vehicles/library';
import { LIBRARY_DIR, readLibrary, readManifest } from './libraryFromDisk';

const manifest = readManifest();
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

  test('the schema refuses a model over its budget, and clips on a vehicle', () => {
    const sedan = manifest.models.find((m) => m.key === 'vehicle.sedan');
    expect(() =>
      parseModelLibrary({ version: 1, models: [{ ...sedan, triangles: { near: 801, far: 10 } }] }),
    ).toThrow();
    const walker = manifest.models.find((m) => m.kind === 'person');
    expect(() =>
      parseModelLibrary({ version: 1, models: [{ ...sedan, clips: walker?.clips }] }),
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

  test('people carry their frames, vehicles none', () => {
    for (const [key, model] of library) {
      if (model.entry.kind !== 'person') {
        expect({ key, animation: model.animation }).toEqual({ key, animation: undefined });
        continue;
      }
      const clips = model.entry.clips;
      const animation = model.animation;
      expect(clips && animation).toBeTruthy();
      if (!clips || !animation) continue;
      expect(animation.vertexCount).toBe(model.near.geometry.getAttribute('position').count);
      expect(animation.frameCount).toBe(clips.move.count + clips.idle.count);
      expect(animation.positions.length).toBe(animation.frameCount * animation.vertexCount * 3);
      // The walk moves the body: its frames are not all one pose.
      const frame = (f: number) =>
        animation.positions.subarray(
          f * animation.vertexCount * 3,
          (f + 1) * animation.vertexCount * 3,
        );
      let moved = 0;
      const a = frame(clips.move.first);
      const b = frame(clips.move.first + Math.floor(clips.move.count / 2));
      for (let i = 0; i < a.length; i++) moved = Math.max(moved, Math.abs(a[i] - b[i]));
      expect({ key, moves: moved > 0.05 }).toEqual({ key, moves: true });
    }
  });

  test('a vehicle has a tintable body; a person none', () => {
    for (const [key, model] of library) {
      const painted = (model.near.geometry.getAttribute('paint').array as Float32Array).some(
        (v) => v > 0,
      );
      if (model.entry.kind === 'person') expect({ key, painted }).toEqual({ key, painted: false });
      else if (
        model.entry.kind === 'car' ||
        model.entry.kind === 'bus' ||
        model.entry.kind === 'aircraft'
      ) {
        expect({ key, painted }).toEqual({ key, painted: true });
      }
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
    for (const model of PERSON_MODELS) expect(keys.has(`person.${model}`)).toBe(true);
    for (const key of LIVE_LIBRARY_KEYS) expect(keys.has(key)).toBe(true);
  });

  test('the people include wheelchair users', () => {
    expect(PERSON_MODEL_SPECS.wheelchair.share).toBeGreaterThan(0);
    expect(PERSON_MODELS[WHEELCHAIR]).toBe('wheelchair');
  });
});

describe('slots', () => {
  test('per-model ranges tile the pool exactly, by share', () => {
    for (const capacity of [1, 7, 40, 600]) {
      const cars = slotRanges(CAR_MODELS, (m) => CAR_MODEL_SPECS[m].share, capacity);
      const people = slotRanges(PERSON_MODELS, (m) => PERSON_MODEL_SPECS[m].share, capacity);
      for (const [models, ranges] of [
        [CAR_MODELS, cars],
        [PERSON_MODELS, people],
      ] as const) {
        let at = 0;
        for (const model of models) {
          const [from, to] = (ranges as Record<string, [number, number]>)[model];
          expect(from).toBe(at);
          expect(to).toBeGreaterThanOrEqual(from);
          at = to;
        }
        expect(at).toBe(capacity);
      }
    }
    const big = slotRanges(PERSON_MODELS, (m) => PERSON_MODEL_SPECS[m].share, 1000);
    expect(big.wheelchair[1] - big.wheelchair[0]).toBe(40);
  });
});

describe('step-free routing', () => {
  // Node 0 joins a footway (edge 0, walked), a flight of steps (1) and a ramp (2).
  const edge = (id: number, steps: boolean) => ({ id, a: 0, b: id + 1, steps }) as never;
  const network = {
    pedEdges: [edge(0, false), edge(1, true), edge(2, false)],
    pedAdjacency: [[0, 1, 2]],
  } as unknown as Network;

  test('a wheelchair user never takes steps; a walker sometimes does', () => {
    const rng = createRng(7);
    const wheeled = new Set<number>();
    const walked = new Set<number>();
    for (let i = 0; i < 200; i++) {
      wheeled.add(chooseEdge(network, 0, 0, rng, true));
      walked.add(chooseEdge(network, 0, 0, rng));
    }
    expect([...wheeled]).toEqual([2]);
    expect(walked.has(1)).toBe(true);
  });

  test('with only steps ahead, a wheelchair user turns back', () => {
    const deadEnd = {
      pedEdges: [edge(0, false), edge(1, true)],
      pedAdjacency: [[0, 1]],
    } as unknown as Network;
    expect(chooseEdge(deadEnd, 0, 0, createRng(1), true)).toBe(0);
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
