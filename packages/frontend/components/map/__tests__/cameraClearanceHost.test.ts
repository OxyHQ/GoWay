/**
 * The camera rule's MapLibre host (`cameraClearance.web.ts`), against a fake
 * map that hands the hook what MapLibre hands it — a transform — and keeps
 * the camera a gesture accumulates (`_camera._requestedCameraState`). The
 * real map needs WebGL; the buildings are real (`fixtures/clearanceCity.ts`).
 *
 * Every number about where the eye is comes from MapLibre's own definitions,
 * written out here and NOT from the rule's module: the eye is
 * `0.5·height / tan(fov/2)` pixels from the centre at `C·cos(lat) / (512·2^z)`
 * metres a pixel, and the near plane is a fiftieth of the screen's height
 * (`MercatorTransform._calcMatrices`). So a rule with no margin, or a host
 * that drops its answer, fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { attachCameraClearance, type ClearanceMap } from '@/components/map/cameraClearance.web';
import { PROGRAMMATIC } from '@goway.to/maps/plugin';
import type { ClearanceField } from '@/components/map/engine/camera/clearance';
import { createAnimationClock } from '@/components/map/perf/animationClock';

import { at, building, field, lngLatOf, SIZE, tileVolumes } from './fixtures/clearanceCity';

/** MapLibre's Earth and its 512-px world. */
const CIRCUMFERENCE = 2 * Math.PI * 6371008.8;
const HEIGHT_PX = 1080;
const FOV = 36.87;

interface Camera {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

const metresPerPixel = (lat: number, zoom: number) =>
  (CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
const distanceM = (c: Camera) =>
  ((0.5 * HEIGHT_PX) / Math.tan((FOV * Math.PI) / 360)) * metresPerPixel(c.lat, c.zoom);
/** The eye's height, metres, over a flat map. */
const eyeAltitude = (c: Camera) => distanceM(c) * Math.cos((c.pitch * Math.PI) / 180);
/** MapLibre's near plane in metres: `height / 50` of its camera's pixels. */
const nearM = (c: Camera) => (HEIGHT_PX / 50) * metresPerPixel(c.lat, c.zoom);
/** Metres south of the centre the eye stands, at bearing 0. */
const eyeSouthM = (c: Camera) => distanceM(c) * Math.sin((c.pitch * Math.PI) / 180);

/** The middle of the test tile, where every camera here looks. */
const CENTRE = lngLatOf(at(SIZE / 2, SIZE / 2));

/** A building under the eye of `camera` (bearing 0: the eye is due south of the centre). */
function under(camera: Camera, height: number, side = 60) {
  return tileVolumes([building(at(SIZE / 2, SIZE / 2 + eyeSouthM(camera)), side, side, height)]);
}

interface Asked {
  zoom: number;
  pitch: number;
  bearing: number;
  setZoom(zoom: number): void;
  setPitch(pitch: number): void;
}

function asked(c: Camera): Asked {
  return {
    zoom: c.zoom,
    pitch: c.pitch,
    bearing: c.bearing,
    setZoom(zoom) {
      this.zoom = zoom;
    },
    setPitch(pitch) {
      this.pitch = pitch;
    },
  };
}

function fakeMap(start: Partial<Camera> = {}) {
  const drawn: Camera = { ...CENTRE, zoom: 18.5, pitch: 75, bearing: 0, ...start };
  const listeners = new Map<string, Set<() => void>>();
  const eases: Array<{ options: Record<string, unknown>; eventData: unknown }> = [];
  let hook: ((next: unknown) => { zoom?: number; pitch?: number }) | null = null;
  let moving = false;
  const timers: Array<() => void> = [];
  const clock = createAnimationClock({
    hz: 30,
    idleMs: 0,
    requestFrame: () => {},
    setTimer: (fn) => {
      timers.push(fn);
      return fn;
    },
    clearTimer: (handle) => {
      const i = timers.indexOf(handle as () => void);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const map = {
    terrain: null,
    getTerrain: () => null,
    getSource: () => undefined,
    _camera: { _requestedCameraState: undefined as Asked | undefined },
    setTransformCameraUpdate(fn: typeof hook) {
      hook = fn;
    },
    getCenter: () => ({ lng: drawn.lng, lat: drawn.lat }),
    getZoom: () => drawn.zoom,
    getPitch: () => drawn.pitch,
    getBearing: () => drawn.bearing,
    getCenterElevation: () => 0,
    getVerticalFieldOfView: () => FOV,
    getCanvas: () => ({ clientHeight: HEIGHT_PX }),
    isMoving: () => moving,
    easeTo(options: Record<string, unknown>, eventData: unknown) {
      eases.push({ options, eventData });
    },
    on(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    off(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    map,
    drawn,
    eases,
    clock,
    hooked: () => hook !== null,
    setMoving(on: boolean) {
      moving = on;
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    /** Run the clock's pending ticks. */
    tick() {
      for (const fn of timers.splice(0)) fn();
    },
    /**
     * One camera update as MapLibre makes it: the camera asked for (the
     * gesture's accumulated one when `state` is given), through the hook; what
     * the hook answers is drawn.
     */
    update(camera: Camera, state?: Asked): Camera {
      if (!hook) throw new Error('no hook');
      map._camera._requestedCameraState = state;
      const answer = hook({
        center: { lng: camera.lng, lat: camera.lat },
        zoom: camera.zoom,
        pitch: camera.pitch,
        bearing: camera.bearing,
        elevation: 0,
        fov: FOV,
        height: HEIGHT_PX,
      });
      Object.assign(drawn, camera, answer);
      return { ...drawn };
    },
  };
}

function attach(fake: ReturnType<typeof fakeMap>, read: () => ClearanceField | null) {
  const container = new EventTarget();
  const window = new EventTarget();
  let time = 0;
  const handle = attachCameraClearance(fake.map as unknown as ClearanceMap, {
    field: read,
    clock: fake.clock,
    container,
    releaseTarget: window,
    now: () => (time += 16),
  });
  const pointer = (target: EventTarget, type: string, id: number) => {
    const event = new Event(type);
    Object.defineProperty(event, 'pointerId', { value: id });
    target.dispatchEvent(event);
  };
  return {
    handle,
    down: (id = 1) => pointer(container, 'pointerdown', id),
    up: (id = 1) => pointer(window, 'pointerup', id),
  };
}

describe('the hook draws what the rule answers', () => {
  test('an eye inside a building is drawn over its roof with MapLibre’s near plane to spare', () => {
    const camera: Camera = { ...CENTRE, zoom: 18.5, pitch: 75, bearing: 0 };
    expect(eyeAltitude(camera)).toBeLessThan(100);
    const fake = fakeMap(camera);
    attach(fake, () => field([under(camera, 100, 120)]));
    const drawn = fake.update(camera);
    // Lifted: less pitch and less zoom, the same centre and bearing.
    expect(drawn.pitch).toBeLessThan(camera.pitch);
    expect(drawn.zoom).toBeLessThan(camera.zoom);
    expect(drawn.bearing).toBe(camera.bearing);
    expect(drawn.lng).toBe(camera.lng);
    // Over the roof by at least 1.5 of MapLibre's near planes (and 2 m).
    const clearance = Math.max(2, 1.5 * nearM(drawn));
    expect(eyeAltitude(drawn)).toBeGreaterThanOrEqual(100 + clearance - 0.05);
    // And the eye did not move over the ground: the same point, higher.
    expect(eyeSouthM(drawn)).toBeCloseTo(eyeSouthM(camera), 1);
  });

  test('close in, where the near plane is centimetres, the eye still keeps 2 m over the roof', () => {
    const camera: Camera = { ...CENTRE, zoom: 21, pitch: 70, bearing: 0 };
    // MapLibre's near plane at z21: under half a metre.
    expect(1.5 * nearM(camera)).toBeLessThan(1);
    const fake = fakeMap(camera);
    attach(fake, () => field([under(camera, eyeAltitude(camera) + 5, 40)]));
    const drawn = fake.update(camera);
    expect(eyeAltitude(drawn)).toBeGreaterThanOrEqual(eyeAltitude(camera) + 5 + 2 - 0.05);
  });

  test('beside it, the camera is drawn as asked', () => {
    const camera: Camera = { ...CENTRE, zoom: 18.5, pitch: 75, bearing: 0 };
    const fake = fakeMap(camera);
    // 30 m tall, 120 m east of the eye.
    const away = tileVolumes([
      building(at(SIZE / 2 + 120, SIZE / 2 + eyeSouthM(camera)), 30, 30, 30),
    ]);
    attach(fake, () => field([away]));
    expect(fake.update(camera)).toEqual(camera);
  });

  test('the field is read on every update, not once', () => {
    const camera: Camera = { ...CENTRE, zoom: 18.5, pitch: 75, bearing: 0 };
    const fake = fakeMap(camera);
    let current: ClearanceField | null = null;
    attach(fake, () => current);
    expect(fake.update(camera)).toEqual(camera);
    // The engine attaches (or a tile arrives): the next update reads it.
    current = field([under(camera, 100, 120)]);
    let drawn = fake.update(camera);
    expect(eyeAltitude(drawn)).toBeGreaterThan(eyeAltitude(camera));
    // Data that arrives under the eye is eased in, within half a second.
    for (let frame = 0; frame < 30; frame++) drawn = fake.update(camera);
    expect(eyeAltitude(drawn)).toBeGreaterThan(100);
  });
});

describe('the camera asked for is held at the surface on zoom and pitch, never on bearing', () => {
  // A 60 m block, 600 m across, under every eye of these cameras.
  const block = () => tileVolumes([building(at(SIZE / 2, SIZE / 2 + 300), 600, 520, 60)]);

  test('a pinch into the roof stops there, and reversing it answers at once (no dead zone)', () => {
    const start: Camera = { ...CENTRE, zoom: 17, pitch: 60, bearing: 0 };
    const fake = fakeMap(start);
    attach(fake, () => field([block()]));
    const state = asked(start);
    let drawn = fake.update(start, state);
    expect(eyeAltitude(drawn)).toBeGreaterThan(80);
    // Pinch in, 0.1 a frame, two zoom levels past where the roof stops it.
    for (let i = 0; i < 40; i++) {
      state.zoom += 0.1;
      drawn = fake.update({ ...start, zoom: state.zoom }, state);
      expect(eyeAltitude(drawn)).toBeGreaterThanOrEqual(60);
    }
    // The gesture's own camera stayed at the surface, not 4 levels deep.
    expect(state.zoom).toBeLessThan(start.zoom + 4 - 1);
    expect(state.zoom).toBeCloseTo(drawn.zoom, 6);
    // Reverse by one frame's worth: the drawn camera moves out at once.
    const before = eyeAltitude(drawn);
    state.zoom -= 0.1;
    drawn = fake.update({ ...start, zoom: state.zoom }, state);
    expect(eyeAltitude(drawn)).toBeGreaterThan(before + 1);
  });

  test('a tilt towards the horizon into the roof stops there, and reversing it answers at once', () => {
    const start: Camera = { ...CENTRE, zoom: 17.4, pitch: 30, bearing: 0 };
    const fake = fakeMap(start);
    attach(fake, () => field([block()]));
    const state = asked(start);
    let drawn = fake.update(start, state);
    for (let i = 0; i < 50; i++) {
      state.pitch = Math.min(85, state.pitch + 1);
      drawn = fake.update({ ...start, pitch: state.pitch }, state);
      expect(eyeAltitude(drawn)).toBeGreaterThanOrEqual(60);
    }
    // Held short of the 85° the gesture asked for.
    expect(state.pitch).toBeLessThan(84);
    const before = drawn.pitch;
    state.pitch -= 1;
    drawn = fake.update({ ...start, pitch: state.pitch }, state);
    expect(drawn.pitch).toBeLessThan(before - 0.5);
  });

  test('a rotation is never held: the eye rises over a tower and comes back down to what was asked', () => {
    const start: Camera = { ...CENTRE, zoom: 18.5, pitch: 75, bearing: -60 };
    const fake = fakeMap(start);
    attach(fake, () => field([under({ ...start, bearing: 0 }, 100, 60)]));
    const state = asked(start);
    let lifted = false;
    for (let bearing = -60; bearing <= 60; bearing += 2) {
      state.bearing = bearing;
      const drawn = fake.update({ ...start, bearing }, state);
      expect(drawn.bearing).toBe(bearing);
      if (eyeAltitude(drawn) > 100) lifted = true;
    }
    expect(lifted).toBe(true);
    // Nothing was written into the gesture's zoom or pitch...
    expect(state.zoom).toBe(start.zoom);
    expect(state.pitch).toBe(start.pitch);
    // ...so past the tower the camera is exactly the one asked for.
    expect(fake.update({ ...start, bearing: 60 }, state)).toEqual({ ...start, bearing: 60 });
  });

  test('inertia after a pinch never carries the camera into the roof, and the next gesture starts at the surface', () => {
    const start: Camera = { ...CENTRE, zoom: 17, pitch: 60, bearing: 0 };
    const fake = fakeMap(start);
    attach(fake, () => field([block()]));
    // An inertial ease: MapLibre sets each frame's zoom outright, deeper.
    const state = asked(start);
    let drawn = fake.update(start, state);
    for (let i = 1; i <= 30; i++) {
      state.zoom = start.zoom + i * 0.12;
      drawn = fake.update({ ...start, zoom: state.zoom }, state);
      expect(eyeAltitude(drawn)).toBeGreaterThanOrEqual(60);
    }
    // `moveend`: MapLibre drops the camera asked for; the next gesture's
    // starts from what is drawn, and a pinch out answers at once.
    const next = asked(drawn);
    const before = eyeAltitude(drawn);
    next.zoom -= 0.1;
    drawn = fake.update({ ...drawn, zoom: next.zoom }, next);
    expect(eyeAltitude(drawn)).toBeGreaterThan(before + 1);
  });
});

describe('a still camera is eased clear, on the clock, as the map’s own move, never under a finger', () => {
  function stillInside() {
    const camera: Camera = { ...CENTRE, zoom: 18.5, pitch: 75, bearing: 0 };
    const fake = fakeMap(camera);
    const f = field([]);
    const host = attach(fake, () => f);
    fake.update(camera);
    fake.fire('render');
    fake.tick();
    expect(fake.eases).toHaveLength(0);
    // A tile arrives under the still eye.
    f.setTiles([under(camera, 100, 120)]);
    return { fake, host, camera };
  }

  test('a new tile under a still eye: one ease, marked PROGRAMMATIC, started on the clock’s tick', () => {
    const { fake } = stillInside();
    fake.fire('render');
    // Not inside MapLibre's frame, not on a timer of its own: the clock's tick.
    expect(fake.eases).toHaveLength(0);
    fake.tick();
    expect(fake.eases).toHaveLength(1);
    // The map's own move: no "Search this area", no paused tour, no folded credit.
    expect(fake.eases[0].eventData).toBe(PROGRAMMATIC);
    const target = fake.eases[0].options as { pitch: number; zoom: number };
    expect(eyeAltitude({ ...fake.drawn, ...target })).toBeGreaterThan(100);
    // Once.
    fake.fire('render');
    fake.tick();
    expect(fake.eases).toHaveLength(1);
  });

  test('a finger resting on the map holds the ease until it lifts (an ease would end the drag)', () => {
    const { fake, host } = stillInside();
    host.down(7);
    fake.fire('render');
    fake.tick();
    fake.tick();
    expect(fake.eases).toHaveLength(0);
    host.up(7);
    fake.tick();
    expect(fake.eases).toHaveLength(1);
  });

  test('a moving camera is not eased: the next update corrects it, and the ease waits for moveend', () => {
    const { fake } = stillInside();
    fake.setMoving(true);
    fake.fire('render');
    fake.tick();
    expect(fake.eases).toHaveLength(0);
    fake.setMoving(false);
    fake.fire('moveend');
    fake.tick();
    expect(fake.eases).toHaveLength(1);
  });

  test('detached, it leaves the map as it found it', () => {
    const fake = fakeMap();
    const { handle } = attach(fake, () => null);
    expect(fake.hooked()).toBe(true);
    handle.dispose();
    expect(fake.hooked()).toBe(false);
  });
});

describe('the engine plugin wires it', () => {
  const source = readFileSync(join(import.meta.dir, '../gowayEngine.web.ts'), 'utf8');

  test('gowayEngine.web.ts attaches it with the live field, the clock and the container', () => {
    const call = source.match(/attachCameraClearance\(map, \{([\s\S]*?)\}\);/);
    expect(call).not.toBeNull();
    const body = call?.[1] ?? '';
    expect(body).toMatch(/field: \(\) => city\?\.clearance\(\) \?\? null/);
    expect(body).toMatch(/\bclock\b/);
    expect(body).toMatch(/\bcontainer\b/);
    expect(body).toMatch(/releaseTarget: window/);
    expect(source).toMatch(/clearance\.dispose\(\)/);
  });
});
