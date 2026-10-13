/**
 * Simulated cars: car-following on the lane graph (`network.ts`).
 *
 * ## The model
 *
 * Each car follows the **Intelligent Driver Model** (Treiber, Hennecke &
 * Helbing, 2000) against whatever is nearest ahead along its route: the car in
 * front, a stop line it may not pass (a red light, a junction it could not
 * reserve, a crossing someone is on), or nothing. IDM is collision-free in
 * continuous time; a fixed step can still overshoot under emergency braking,
 * so every step's advance is also clamped to the gap — two cars NEVER overlap,
 * which `__tests__/cityLifeSim.test.ts` asserts over thousands of steps.
 *
 * ## Junctions
 *
 * A car may enter a connector (its path across a junction) only after it has
 * RESERVED it: the junction's signal shows its phase green, no connector that
 * conflicts with it (crosses it, or merges into the same lane) is reserved or
 * occupied by anyone else, and the lane beyond has room for it. Until then the
 * end of its lane is a stop line. Once reserved it is committed — an amber
 * that turns red behind a car already in the junction does not strand it —
 * and the reservation is released when it leaves the connector. Followers on
 * the same lane may reserve the same connector: they queue through behind
 * their leader rather than taking turns with it.
 *
 * Gridlock can still form in a model this simple (a ring of junctions each
 * waiting on the next); a car that has stood still for {@link STUCK_S} leaves
 * the simulation, out of view when it can.
 *
 * All of it is SIMULATION: plausible motion on the real street network, never
 * a statement about real traffic.
 */
import { LOCAL_ENTRY_WEIGHT, type Network, type Path, phaseGreen } from './network';
import { CAR_MODEL_SPECS, CAR_MODELS, type CarModel, slotRanges } from './fleet';
import type { Rng } from './rng';
import { modelBit } from './vehicleAccess';

/** IDM parameters. Textbook urban values (Treiber & Kesting, *Traffic Flow Dynamics*, tab. 11.2). */
export const IDM = {
  /** Maximum acceleration, m/s². */
  a: 1.4,
  /** Comfortable deceleration, m/s². */
  b: 2.2,
  /** Desired time headway, s. */
  T: 1.2,
  /** Minimum standstill gap, m. */
  s0: 2,
  /** Acceleration exponent. */
  delta: 4,
  /** Hardest braking the model may ask for, m/s². */
  maxBrake: 9,
} as const;

/** Seconds stood still before a car gives up and leaves. */
export const STUCK_S = 60;

/** How far ahead a car looks for leaders and stops, m. */
const LOOKAHEAD_M = 120;

/** Planned paths per car (current + upcoming). */
export const ROUTE_LENGTH = 8;

/**
 * Connectors one car may hold at once: a junction whose nodes are a few
 * metres apart (a dual carriageway's two halves, a chamfered corner) is
 * crossed in one reservation, through the short lanes between its nodes.
 */
export const HELD_MAX = 3;

/** Lanes shorter than this between two junction nodes are crossed without stopping. */
export const INTERNAL_LANE_M = 20;

/**
 * IDM acceleration for a car at speed `v` with desired speed `v0`, a gap of
 * `gap` metres (bumper to bumper, or to a stop line) to something moving at
 * `leadV`. `gap = Infinity`: free road.
 */
export function idmAcceleration(v: number, v0: number, gap: number, leadV: number): number {
  const free = 1 - (v / Math.max(v0, 0.1)) ** IDM.delta;
  if (!Number.isFinite(gap)) return IDM.a * free;
  if (gap <= 0.01) return -IDM.maxBrake;
  const dv = v - leadV;
  const desired = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
  return Math.max(-IDM.maxBrake, IDM.a * (free - (desired / gap) ** 2));
}

/** Structure-of-arrays state for every car slot. */
export class Cars {
  readonly capacity: number;
  /** Slot ranges per model: `[start, end)`. */
  readonly ranges: Record<CarModel, [number, number]>;
  readonly alive: Uint8Array;
  readonly model: Uint8Array;
  readonly path: Int32Array;
  readonly s: Float64Array;
  readonly v: Float64Array;
  readonly length: Float32Array;
  /** Personal desired-speed factor (drivers differ). */
  readonly temper: Float32Array;
  readonly route: Int32Array;
  readonly routeLength: Uint8Array;
  /** Connectors this car has reserved, {@link HELD_MAX} per car, −1 for none. */
  readonly held: Int32Array;
  readonly stopped: Float32Array;
  readonly age: Float32Array;
  /** Seconds left of a fade-out before the slot frees; −1 when not leaving. */
  readonly leaving: Float32Array;
  /** Paint, sRGB 0–255, and a free byte. */
  readonly style: Uint8Array;
  // Where it was drawn last step — what a rebuilt network snaps it back onto.
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly h: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    const ranges = slotRanges(CAR_MODELS, (model) => CAR_MODEL_SPECS[model].share, capacity);
    this.ranges = ranges;
    this.alive = new Uint8Array(capacity);
    this.model = new Uint8Array(capacity);
    for (const [i, model] of CAR_MODELS.entries()) {
      const [a, b] = ranges[model];
      this.model.fill(i, a, b);
    }
    this.path = new Int32Array(capacity).fill(-1);
    this.s = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
    this.length = new Float32Array(capacity);
    this.temper = new Float32Array(capacity);
    this.route = new Int32Array(capacity * ROUTE_LENGTH).fill(-1);
    this.routeLength = new Uint8Array(capacity);
    this.held = new Int32Array(capacity * HELD_MAX).fill(-1);
    this.stopped = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.leaving = new Float32Array(capacity).fill(-1);
    this.style = new Uint8Array(capacity * 4);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.h = new Float32Array(capacity);
  }
}

/**
 * Body colours: soft pastel maquette paints rather than a photograph's — the
 * city is a model, and the traffic says so too. Weighted towards the whites,
 * greys and silvers real fleets are mostly made of.
 */
const PAINTS: readonly [number, number, number, number][] = [
  [246, 244, 240, 4],
  [222, 224, 228, 3],
  [196, 201, 208, 3],
  [128, 136, 148, 2],
  [176, 200, 226, 2],
  [184, 216, 198, 2],
  [240, 200, 180, 2],
  [240, 226, 176, 1],
  [206, 192, 226, 1],
  [232, 170, 160, 1],
  [196, 210, 180, 1],
];
const BUS_PAINTS: readonly [number, number, number][] = [
  [236, 238, 242],
  [196, 216, 236],
  [236, 210, 198],
];

export function pickPaint(rng: Rng, model: CarModel): [number, number, number] {
  if (model === 'bus') return BUS_PAINTS[rng.int(BUS_PAINTS.length)];
  let total = 0;
  for (const paint of PAINTS) total += paint[3];
  let pick = rng.next() * total;
  for (const [r, g, b, weight] of PAINTS) {
    pick -= weight;
    if (pick <= 0) return [r, g, b];
  }
  return [PAINTS[0][0], PAINTS[0][1], PAINTS[0][2]];
}

/** Per-step shared state the car model reads: who is on which path, crossings, signals. */
export interface TrafficContext {
  network: Network;
  cars: Cars;
  rng: Rng;
  /** Simulation clock, s. */
  time: number;
  /** Per path: car slots on it, sorted by `s` ascending. */
  onPath: number[][];
  /** Per connector: cars that hold or occupy it. */
  occupancy: Int32Array;
  /** Per crossing: people on it. */
  crossingOccupancy: Int32Array;
}

/**
 * Choose where a car goes after `lane`: weighted towards straight on, rarely a
 * U-turn, never onto a lane its `user` bit may not drive (`vehicleAccess.ts`),
 * and rarely onto one it may only enter to reach somewhere. -1 when every way
 * on is shut to it.
 */
export function chooseConnector(
  paths: readonly Path[],
  lane: Path,
  rng: Rng,
  user: number,
): number {
  let total = 0;
  const weights = lane.next.map((id) => {
    const connector = paths[id];
    const target = paths[connector.next[0]];
    const entry = target.users & user ? 1 : target.local & user ? LOCAL_ENTRY_WEIGHT : 0;
    const w = entry * (connector.turn === 0 ? 4 : connector.turn === 3 ? 0.05 : 1);
    total += w;
    return w;
  });
  if (total === 0) return -1;
  let pick = rng.next() * total;
  for (let i = 0; i < lane.next.length; i++) {
    if (weights[i] === 0) continue;
    pick -= weights[i];
    if (pick <= 0) return lane.next[i];
  }
  return lane.next[weights.findLastIndex((w) => w > 0)];
}

/** Extend a car's route until it holds `ROUTE_LENGTH` paths or meets the network's edge. */
export function extendRoute(ctx: TrafficContext, car: number): void {
  const { cars, network } = ctx;
  const base = car * ROUTE_LENGTH;
  while (cars.routeLength[car] < ROUTE_LENGTH) {
    const last = network.paths[cars.route[base + cars.routeLength[car] - 1]];
    const next =
      last.kind === 'connector'
        ? last.next[0]
        : chooseConnector(network.paths, last, ctx.rng, modelBit(CAR_MODELS[cars.model[car]]));
    if (next === undefined || next < 0) return;
    cars.route[base + cars.routeLength[car]] = next;
    cars.routeLength[car]++;
  }
}

export function holds(cars: Cars, car: number, connector: number): boolean {
  const base = car * HELD_MAX;
  for (let i = 0; i < HELD_MAX; i++) if (cars.held[base + i] === connector) return true;
  return false;
}

function hold(ctx: TrafficContext, car: number, connector: number): void {
  const base = car * HELD_MAX;
  for (let i = 0; i < HELD_MAX; i++) {
    if (ctx.cars.held[base + i] < 0) {
      ctx.cars.held[base + i] = connector;
      ctx.occupancy[connector]++;
      return;
    }
  }
}

/** Release one held connector (when the car leaves it). */
export function releaseOne(ctx: TrafficContext, car: number, connector: number): void {
  const base = car * HELD_MAX;
  for (let i = 0; i < HELD_MAX; i++) {
    if (ctx.cars.held[base + i] === connector) {
      ctx.cars.held[base + i] = -1;
      ctx.occupancy[connector] = Math.max(0, ctx.occupancy[connector] - 1);
    }
  }
}

/** Release everything a car holds (it left the simulation). */
export function release(ctx: TrafficContext, car: number): void {
  const base = car * HELD_MAX;
  for (let i = 0; i < HELD_MAX; i++) {
    const held = ctx.cars.held[base + i];
    if (held >= 0) {
      ctx.occupancy[held] = Math.max(0, ctx.occupancy[held] - 1);
      ctx.cars.held[base + i] = -1;
    }
  }
}

/**
 * Whether `car` may enter the junction ahead — the connector at route index
 * `k`, plus, through any lane too short to stop on, the connectors after it —
 * and if so reserve them all at once. Only the FIRST connector's signal
 * counts: inside a junction a car finishes its manoeuvre.
 */
function tryReserve(ctx: TrafficContext, car: number, k: number): boolean {
  const { cars, network, occupancy } = ctx;
  const paths = network.paths;
  const base = car * ROUTE_LENGTH;
  const first = cars.route[base + k];
  if (holds(cars, car, first)) return true;
  const connector = paths[first];
  if (
    connector.signal >= 0 &&
    !phaseGreen(network.signals[connector.signal], connector.group, ctx.time)
  ) {
    return false;
  }
  const chain = [first];
  // A lane shorter than this is inside the junction: a car does not stop on it.
  const fits = Math.max(INTERNAL_LANE_M, cars.length[car] + IDM.s0 + 1);
  let refuge = connector.next[0];
  for (let j = k + 1; j + 1 < ROUTE_LENGTH && chain.length < HELD_MAX; j += 2) {
    const lane = paths[cars.route[base + j]];
    if (!lane || lane.id !== refuge || lane.length >= fits) break;
    const after = cars.route[base + j + 1];
    if (after < 0) break;
    chain.push(after);
    refuge = paths[after].next[0];
  }
  for (const id of chain) {
    for (const other of paths[id].conflicts) {
      if (occupancy[other] > 0 && !holds(cars, car, other)) return false;
    }
  }
  // Room beyond: the last car on the lane past the junction must have cleared
  // its start by this car's length — twice that when others already hold the
  // way in and will take the first space. Never block the box.
  const queue = ctx.onPath[refuge];
  if (queue && queue.length > 0) {
    const last = queue[0];
    const room = cars.s[last] - cars.length[last] / 2;
    const need = (cars.length[car] + IDM.s0) * (occupancy[first] > 0 ? 2 : 1);
    if (room < need) return false;
  }
  for (const id of chain) hold(ctx, car, id);
  return true;
}

/** Whether a car approaching a crossing at speed must wait for the people on it. */
function crossingBlocked(ctx: TrafficContext, crossing: number): boolean {
  return ctx.crossingOccupancy[crossing] > 0;
}

/**
 * The gap to the nearest obstacle ahead of `car` and its speed: the car
 * ahead, or a stop line. Reserves the next connector when close enough.
 */
export function lookAhead(
  ctx: TrafficContext,
  car: number,
  index: number,
): { gap: number; leadV: number; v0: number } {
  const { cars, network } = ctx;
  const paths = network.paths;
  const base = car * ROUTE_LENGTH;
  const own = cars.length[car];
  const s = cars.s[car];
  const v = cars.v[car];
  let gap = Number.POSITIVE_INFINITY;
  let leadV = 0;
  let v0 = paths[cars.path[car]].speed * cars.temper[car];

  const consider = (g: number, speed: number) => {
    if (g < gap) {
      gap = g;
      leadV = speed;
    }
  };
  /** A stop line `distance` metres ahead of this car's CENTRE. */
  const stopAt = (distance: number) => {
    // A line the front has already passed is behind it (it ran an amber, or
    // its leader released the junction) — not a reason for an emergency stop.
    if (distance - own / 2 < -0.5) return;
    consider(distance - own / 2 - 0.5, 0);
  };
  const brakingDistance = (v * v) / (2 * IDM.b);

  // Along the current path, then the route ahead.
  let offset = -s; // the path's start, relative to this car's centre
  for (let k = 0; k < cars.routeLength[car]; k++) {
    const path = paths[cars.route[base + k]];
    if (offset > LOOKAHEAD_M) break;
    const queue = ctx.onPath[path.id] ?? [];
    // The first car ahead on this path.
    const from = k === 0 ? index + 1 : 0;
    if (from < queue.length) {
      const leader = queue[from];
      consider(offset + cars.s[leader] - cars.length[leader] / 2 - own / 2, cars.v[leader]);
      break;
    }
    for (const stop of path.crossings) {
      const distance = offset + stop.s;
      if (distance > 0 && crossingBlocked(ctx, stop.crossing)) stopAt(distance);
    }
    for (const stop of path.signals) {
      const distance = offset + stop.s;
      if (distance - own / 2 <= 0) continue;
      const green = phaseGreen(network.signals[stop.signal], stop.group, ctx.time);
      // Too close to stop comfortably: carry on through the amber.
      if (!green && distance - own / 2 > brakingDistance * 0.6) stopAt(distance);
    }
    if (path.kind === 'connector' && path.turn !== 0) {
      // Slow for the turn: the speed from which comfortable braking reaches it.
      const reach = Math.max(0, offset);
      v0 = Math.min(v0, Math.sqrt(path.speed * path.speed + 2 * IDM.b * reach));
    }
    const end = offset + path.length;
    if (path.kind === 'lane') {
      const nextId = k + 1 < cars.routeLength[car] ? cars.route[base + k + 1] : -1;
      if (nextId < 0) {
        // The loaded network ends here: the car drives off it and leaves.
        if (path.terminal) break;
        stopAt(end);
        break;
      }
      const reserveReach = Math.max(8, brakingDistance + 6);
      const mayReserve = k === 0 && end - own / 2 < reserveReach;
      if (!(holds(cars, car, nextId) || (mayReserve && tryReserve(ctx, car, k + 1)))) {
        stopAt(end);
        break;
      }
    }
    offset = end;
  }
  return { gap, leadV, v0 };
}
