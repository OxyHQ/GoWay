/**
 * Simulated people: walkers on the footway graph (`network.ts`).
 *
 * A person walks an edge at their own pace, a little to one side of its
 * centre line so a busy pavement reads as two streams rather than one file,
 * and at its end picks another edge at random — never straight back the way
 * they came unless it is a dead end. Where the next edge is a CROSSING they
 * wait at the kerb until it is theirs to take: a signalled crossing while the
 * road it crosses has red, an uncontrolled one while no car is about to pass.
 * While anyone is on a crossing, cars yield to it (`traffic.ts`).
 *
 * Moving between two edges whose ends do not meet (a virtual sidewalk beside
 * a road ends a few metres from the junction's centre) is a short straight
 * walk between them, at the same pace.
 *
 * People do not avoid each other; at pavement densities and a person's size
 * on the map, the lateral offset is what keeps them from visibly overlapping.
 */
import {
  PERSON_MODEL_SPECS,
  PERSON_MODELS,
  type PersonModel,
  slotRanges,
  WHEELCHAIR,
} from './fleet';
import { type Network, type PedEdge, phaseGreen } from './network';
import type { Rng } from './rng';
import type { TrafficContext } from './traffic';

/** How far each side of an edge's centre line people keep, m. */
const LATERAL_M = 0.9;

/** Seconds waiting at a crossing before giving up on it and turning elsewhere. */
const PATIENCE_S = 70;

export const PERSON_STATE = { walking: 0, waiting: 1, transfer: 2 } as const;

export class People {
  readonly capacity: number;
  readonly alive: Uint8Array;
  readonly edge: Int32Array;
  readonly s: Float64Array;
  /** `1` along the edge, `−1` against it. */
  readonly dir: Int8Array;
  readonly speed: Float32Array;
  readonly lateral: Float32Array;
  readonly state: Uint8Array;
  /** Waiting / transfer: the edge to take next, and which way. */
  readonly nextEdge: Int32Array;
  readonly nextDir: Int8Array;
  readonly wait: Float32Array;
  /** Transfer: where it started, how far, and how far walked. */
  readonly tx0: Float32Array;
  readonly ty0: Float32Array;
  readonly transferLength: Float32Array;
  readonly age: Float32Array;
  readonly leaving: Float32Array;
  /** Which library model each slot draws (`models.ts`), fixed per slot. */
  readonly model: Uint8Array;
  /** Slot ranges per model: `[start, end)`. */
  readonly ranges: Record<PersonModel, [number, number]>;
  /** Three free bytes and the animation phase (`lifeShaders.ts`). */
  readonly style: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly h: Float32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.alive = new Uint8Array(capacity);
    this.edge = new Int32Array(capacity).fill(-1);
    this.s = new Float64Array(capacity);
    this.dir = new Int8Array(capacity);
    this.speed = new Float32Array(capacity);
    this.lateral = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.nextEdge = new Int32Array(capacity).fill(-1);
    this.nextDir = new Int8Array(capacity);
    this.wait = new Float32Array(capacity);
    this.tx0 = new Float32Array(capacity);
    this.ty0 = new Float32Array(capacity);
    this.transferLength = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.leaving = new Float32Array(capacity).fill(-1);
    this.ranges = slotRanges(PERSON_MODELS, (model) => PERSON_MODEL_SPECS[model].share, capacity);
    this.model = new Uint8Array(capacity);
    for (const [i, model] of PERSON_MODELS.entries()) {
      const [a, b] = this.ranges[model];
      this.model.fill(i, a, b);
    }
    this.style = new Uint8Array(capacity * 4);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.h = new Float32Array(capacity);
  }
}

/** Where an edge is entered from `node`: its start when it begins there, else its end. */
function entryDir(edge: PedEdge, node: number): 1 | -1 {
  return edge.a === node ? 1 : -1;
}

/** Is it this person's turn to step onto crossing edge `edgeId`? */
export function mayCross(
  network: Network,
  traffic: TrafficContext,
  edgeId: number,
  time: number,
): boolean {
  const edge = network.pedEdges[edgeId];
  if (edge.crossing < 0) return true;
  const crossing = network.crossings[edge.crossing];
  if (crossing.signal >= 0) {
    const controller = network.signals[crossing.signal];
    // People walk while the road they cross has red: the other phase.
    return phaseGreen(controller, 1 - crossing.group, time);
  }
  // Uncontrolled: wait while a car is close to passing over it.
  const { cars } = traffic;
  for (const { path, s } of crossing.lanes) {
    for (const car of traffic.onPath[path] ?? []) {
      const ahead = s - cars.s[car];
      if (ahead > -cars.length[car] / 2 - 1 && ahead < 6 + cars.v[car] * 2) return false;
    }
  }
  return true;
}

/**
 * Choose the next edge from `node`, not the one just walked unless it is the
 * only one. `stepFree`: never steps (a wheelchair user turns back instead).
 */
export function chooseEdge(
  network: Network,
  node: number,
  from: number,
  rng: Rng,
  stepFree = false,
): number {
  const around = network.pedAdjacency[node] ?? [];
  if (around.length === 0) return -1;
  const options = around.filter((e) => e !== from && !(stepFree && network.pedEdges[e].steps));
  if (options.length === 0) return from;
  return options[rng.int(options.length)];
}

export interface PedestrianContext {
  network: Network;
  people: People;
  rng: Rng;
  time: number;
  traffic: TrafficContext;
}

/** One fixed step for every person. */
export function stepPeople(ctx: PedestrianContext, dt: number): void {
  const { network, people, rng } = ctx;
  const edges = network.pedEdges;
  const occupancy = ctx.traffic.crossingOccupancy;

  const start = (p: number, edgeId: number, dir: 1 | -1) => {
    const edge = edges[edgeId];
    people.edge[p] = edgeId;
    people.dir[p] = dir;
    people.s[p] = dir === 1 ? 0 : edge.length;
    people.state[p] = PERSON_STATE.walking;
    people.wait[p] = 0;
    if (edge.crossing >= 0) occupancy[edge.crossing]++;
  };
  const leaveEdge = (p: number) => {
    const edge = edges[people.edge[p]];
    if (edge && edge.crossing >= 0)
      occupancy[edge.crossing] = Math.max(0, occupancy[edge.crossing] - 1);
  };

  for (let p = 0; p < people.capacity; p++) {
    if (!people.alive[p]) continue;
    people.age[p] += dt;
    const state = people.state[p];
    if (state === PERSON_STATE.waiting) {
      people.wait[p] += dt;
      const next = people.nextEdge[p];
      if (mayCross(network, ctx.traffic, next, ctx.time)) {
        start(p, next, people.nextDir[p] as 1 | -1);
      } else if (people.wait[p] > PATIENCE_S && people.leaving[p] < 0) {
        // An uncontrolled crossing that never clears: they go elsewhere —
        // which, here, is out of the simulation (faded, `simulation.ts`).
        people.leaving[p] = 0.6;
      }
      continue;
    }
    if (state === PERSON_STATE.transfer) {
      people.s[p] += people.speed[p] * dt;
      if (people.s[p] >= people.transferLength[p]) {
        const next = people.nextEdge[p];
        if (edges[next].crossing >= 0 && !mayCross(network, ctx.traffic, next, ctx.time)) {
          // Arrived at the kerb on a red: wait at the crossing's start. Its
          // edge is named for placement only; they are not ON it (its
          // occupancy is counted by `start`, when they step off the kerb).
          people.state[p] = PERSON_STATE.waiting;
          people.edge[p] = next;
          people.dir[p] = people.nextDir[p];
          people.s[p] = people.nextDir[p] === 1 ? 0 : edges[next].length;
          people.wait[p] = 0;
          continue;
        }
        start(p, next, people.nextDir[p] as 1 | -1);
      }
      continue;
    }

    const edge = edges[people.edge[p]];
    people.s[p] += people.dir[p] * people.speed[p] * dt;
    if (people.s[p] >= 0 && people.s[p] <= edge.length) continue;

    // The end of the edge: pick the next.
    const node = people.dir[p] === 1 ? edge.b : edge.a;
    leaveEdge(p);
    const nextId = chooseEdge(network, node, edge.id, rng, people.model[p] === WHEELCHAIR);
    if (nextId < 0) {
      people.dir[p] = -people.dir[p] as 1 | -1;
      people.s[p] = people.dir[p] === 1 ? 0 : edge.length;
      continue;
    }
    const next = edges[nextId];
    const dir = nextId === edge.id ? (-people.dir[p] as 1 | -1) : entryDir(next, node);
    // Where this edge ends and the next begins, laterally offset as walked.
    const endX = people.x[p];
    const endY = people.y[p];
    const startIndex = dir === 1 ? 0 : next.xs.length - 1;
    const gap = Math.hypot(next.xs[startIndex] - endX, next.ys[startIndex] - endY);
    people.nextEdge[p] = nextId;
    people.nextDir[p] = dir;
    if (gap > LATERAL_M * 2 + 0.5) {
      people.state[p] = PERSON_STATE.transfer;
      people.tx0[p] = endX;
      people.ty0[p] = endY;
      people.transferLength[p] = gap;
      people.s[p] = 0;
      people.edge[p] = nextId;
      people.dir[p] = dir;
      continue;
    }
    // The second half of the crossing they are on is never a reason to stop mid-road.
    if (
      next.crossing >= 0 &&
      next.crossing !== edge.crossing &&
      !mayCross(network, ctx.traffic, nextId, ctx.time)
    ) {
      people.state[p] = PERSON_STATE.waiting;
      people.wait[p] = 0;
      people.s[p] = people.dir[p] === 1 ? edge.length : 0;
      continue;
    }
    start(p, nextId, dir);
  }
}

/** Where a person is drawn: on their edge, offset to their side; or between two edges. */
export function placePerson(
  network: Network,
  people: People,
  p: number,
  scratch: { x: number; y: number; h: number },
): void {
  const state = people.state[p];
  if (state === PERSON_STATE.transfer) {
    const edge = network.pedEdges[people.nextEdge[p]];
    const i = people.nextDir[p] === 1 ? 0 : edge.xs.length - 1;
    const t = Math.min(1, people.s[p] / Math.max(people.transferLength[p], 0.01));
    const x0 = people.tx0[p];
    const y0 = people.ty0[p];
    scratch.x = x0 + (edge.xs[i] - x0) * t;
    scratch.y = y0 + (edge.ys[i] - y0) * t;
    scratch.h = Math.atan2(edge.ys[i] - y0, edge.xs[i] - x0);
    return;
  }
  const edge = network.pedEdges[people.edge[p]];
  const dir = people.dir[p];
  const n = edge.xs.length;
  // Waiting: at the kerb end of the edge they wait for, or of their own.
  let s = people.s[p];
  if (s < 0) s = 0;
  if (s > edge.length) s = edge.length;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (edge.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = edge.cum[hi] - edge.cum[lo];
  const t = span > 0 ? (s - edge.cum[lo]) / span : 0;
  const dx = edge.xs[hi] - edge.xs[lo];
  const dy = edge.ys[hi] - edge.ys[lo];
  const len = Math.hypot(dx, dy) || 1;
  // Keep to the right of the walking direction (each person's own offset).
  const side = people.lateral[p] * dir;
  scratch.x = edge.xs[lo] + dx * t + (dy / len) * side;
  scratch.y = edge.ys[lo] + dy * t - (dx / len) * side;
  scratch.h = Math.atan2(dy * dir, dx * dir);
}

export { LATERAL_M };
