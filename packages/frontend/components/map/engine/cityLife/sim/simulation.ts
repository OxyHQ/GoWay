/**
 * The city-life simulation: cars and people on the network, stepped at a
 * fixed rate, with a budget, inside a radius around the camera.
 *
 * Owned by the simulation worker (`simWorker.ts`); pure and deterministic, so
 * the tests drive it directly. One {@link CitySimulation.step} is
 * {@link STEP_S} of simulated time whatever the frame rate; the renderer
 * interpolates between steps.
 *
 * ## Density, budget, and where agents appear
 *
 * The camera's zoom sets an ACTIVE RADIUS ({@link activeRadius}) and a density
 * factor: zoomed in, a smaller neighbourhood at full density; zoomed out, a
 * wider one, thinner. Within it the target is a density per lane-kilometre
 * (cars) and per footway-kilometre (people), capped by the budget. New agents
 * appear OUTSIDE the visible box when there is road there, fading in over
 * {@link FADE_S}; surplus ones leave from outside it first, fading out. The
 * first fill after the network loads places everyone at once and runs
 * {@link WARMUP_S} of simulated time before the first frame, so the city
 * opens already moving, with queues at the lights.
 *
 * ## A changing network
 *
 * Panning loads new road tiles and drops old ones, and the network is rebuilt
 * from whatever is loaded. Agents are carried across a rebuild by POSITION:
 * each is snapped to the nearest path heading its way within a few metres; one
 * that has none (its road is no longer loaded) is removed.
 */
import type { TaxiLivery } from './liveries';
import { createRng, type Rng } from './rng';
import { type Network, type Path, pointAt, project } from './network';
import {
  CAR_MODEL_SPECS,
  CAR_MODELS,
  type CarModel,
  Cars,
  extendRoute,
  HELD_MAX,
  holds,
  idmAcceleration,
  lookAhead,
  pickPaint,
  release,
  releaseOne,
  ROUTE_LENGTH,
  STUCK_S,
  type TrafficContext,
} from './traffic';
import {
  LATERAL_M,
  People,
  PERSON_STATE,
  pickClothes,
  placePerson,
  stepPeople,
  WALK_SPEED,
} from './pedestrians';

/** Simulated seconds per step. */
export const STEP_S = 0.05;
/** Seconds an agent takes to fade in or out. */
export const FADE_S = 0.6;
/** Simulated seconds run before the first frame of a fresh network. */
export const WARMUP_S = 12;

/** Cars per kilometre of lane inside the active radius, at full density. */
export const CAR_DENSITY_PER_KM = 22;
/** People per kilometre of footway inside the active radius, at full density. */
export const PEOPLE_DENSITY_PER_KM = 26;

/** Most agents spawned (or sent away) per step, so changes ramp rather than pop. */
const SPAWN_PER_STEP = 30;

export interface SimBudget {
  cars: number;
  people: number;
}

/** The camera, in simulation metres. */
export interface SimView {
  cx: number;
  cy: number;
  /** Visible ground box (axis-aligned bound of what the camera sees). */
  box: { x0: number; y0: number; x1: number; y1: number };
  zoom: number;
}

/** The active radius for a zoom: ~800 m at z17, doubling per zoom out. */
export function activeRadius(zoom: number): number {
  return Math.max(250, Math.min(1800, 800 * 2 ** (17 - zoom)));
}

/** Density factor for a zoom: full from z17, a fifth at z15.5. */
export function densityFactor(zoom: number): number {
  return Math.max(0.2, Math.min(1, (zoom - 15) / 2));
}

export interface SimStats {
  cars: number;
  people: number;
  carTarget: number;
  peopleTarget: number;
  stepMs: number;
  carsLeftStuck: number;
}

export class CitySimulation {
  readonly cars: Cars;
  readonly people: People;
  readonly rng: Rng;
  network: Network | null = null;
  time = 0;
  /** The taxis' livery where the city has one, else `null`: no taxis. */
  taxiLivery: TaxiLivery | null = null;
  view: SimView | null = null;
  readonly stats: SimStats = {
    cars: 0,
    people: 0,
    carTarget: 0,
    peopleTarget: 0,
    stepMs: 0,
    carsLeftStuck: 0,
  };

  private traffic: TrafficContext | null = null;
  private spawnLanes: number[] = [];
  private spawnLaneCum: number[] = [];
  private spawnEdges: number[] = [];
  private spawnEdgeCum: number[] = [];
  private laneKm = 0;
  private pedKm = 0;
  private spawnFor: { cx: number; cy: number; r: number } | null = null;
  private warm = false;
  private readonly accel: Float64Array;
  private readonly gaps: Float64Array;
  private readonly scratch = { x: 0, y: 0, h: 0 };

  constructor(
    readonly budget: SimBudget,
    seed: number,
  ) {
    this.cars = new Cars(budget.cars);
    this.people = new People(budget.people);
    this.rng = createRng(seed);
    this.accel = new Float64Array(budget.cars);
    this.gaps = new Float64Array(budget.cars);
  }

  /** Replace the network, carrying every agent that still has a road under it. */
  setNetwork(network: Network): void {
    const previous = this.network;
    this.network = network;
    this.traffic = {
      network,
      cars: this.cars,
      rng: this.rng,
      time: this.time,
      onPath: network.paths.map(() => []),
      occupancy: new Int32Array(network.paths.length),
      crossingOccupancy: new Int32Array(network.crossings.length),
    };
    this.spawnFor = null;
    if (previous) this.migrate(network);
    else this.warm = false;
    this.bucket();
  }

  setView(view: SimView): void {
    this.view = view;
  }

  /** One fixed step. */
  step(): void {
    const started = typeof performance !== 'undefined' ? performance.now() : 0;
    const network = this.network;
    const traffic = this.traffic;
    const view = this.view;
    if (!network || !traffic || !view) return;
    if (!this.warm) {
      this.warm = true;
      this.refreshSpawnSets(view);
      this.fill(view, true);
      for (let t = 0; t < WARMUP_S; t += STEP_S) this.advance(view, false);
    }
    this.advance(view, true);
    this.stats.stepMs = typeof performance !== 'undefined' ? performance.now() - started : 0;
  }

  private advance(view: SimView, spawn: boolean): void {
    const traffic = this.traffic as TrafficContext;
    const network = this.network as Network;
    const { cars, people } = this;
    const dt = STEP_S;
    this.time += dt;
    traffic.time = this.time;
    this.bucket();

    // 1. Accelerations, all from the same instant.
    for (const queue of traffic.onPath) {
      for (let k = 0; k < queue.length; k++) {
        const car = queue[k];
        const { gap, leadV, v0 } = lookAhead(traffic, car, k);
        this.accel[car] = idmAcceleration(cars.v[car], v0, gap, leadV);
        this.gaps[car] = gap;
      }
    }
    // 2. Integrate and move along the route. The advance never exceeds the
    // gap measured at the start of the step — the leader only moves forward,
    // so this is what guarantees no two cars overlap.
    for (let car = 0; car < cars.capacity; car++) {
      if (!cars.alive[car]) continue;
      cars.age[car] += dt;
      const v = cars.v[car];
      const a = this.accel[car];
      let next = v + a * dt;
      let ds: number;
      if (next < 0) {
        ds = a < 0 ? (v * v) / (-2 * a) : 0;
        next = 0;
      } else {
        ds = v * dt + 0.5 * a * dt * dt;
      }
      const gap = this.gaps[car];
      if (ds > gap - 0.05) {
        ds = Math.max(0, gap - 0.05);
        next = Math.min(next, ds / dt);
      }
      cars.v[car] = next;
      cars.s[car] += ds;
      cars.stopped[car] = next < 0.1 ? cars.stopped[car] + dt : 0;
      this.moveAlong(car);
    }

    // 3. People.
    stepPeople({ network, people, rng: this.rng, time: this.time, traffic }, dt);

    // 4. Leaving, budget, radius.
    this.lifecycle(view, dt, spawn);

    // 5. Where everyone is.
    this.place();
  }

  /** Move a car along its route past the ends of paths. */
  private moveAlong(car: number): void {
    const { cars } = this;
    const traffic = this.traffic as TrafficContext;
    const paths = (this.network as Network).paths;
    const base = car * ROUTE_LENGTH;
    for (;;) {
      const path = paths[cars.path[car]];
      if (cars.s[car] <= path.length) return;
      if (cars.routeLength[car] <= 1) {
        // Off the edge of the loaded network: gone.
        if (path.kind === 'lane' && path.terminal) this.removeCar(car);
        else cars.s[car] = path.length;
        return;
      }
      const nextId = cars.route[base + 1];
      if (path.kind === 'lane' && !holds(cars, car, nextId)) {
        // Not reserved (cannot happen with the gap clamp; kept as a guard).
        cars.s[car] = path.length;
        cars.v[car] = 0;
        return;
      }
      cars.s[car] -= path.length;
      if (path.kind === 'connector') releaseOne(traffic, car, path.id);
      cars.route.copyWithin(base, base + 1, base + ROUTE_LENGTH);
      cars.route[base + ROUTE_LENGTH - 1] = -1;
      cars.routeLength[car]--;
      cars.path[car] = nextId;
      extendRoute(traffic, car);
    }
  }

  private bucket(): void {
    const traffic = this.traffic as TrafficContext;
    for (const queue of traffic.onPath) queue.length = 0;
    const { cars } = this;
    for (let car = 0; car < cars.capacity; car++) {
      if (cars.alive[car]) traffic.onPath[cars.path[car]].push(car);
    }
    for (const queue of traffic.onPath) {
      if (queue.length > 1) queue.sort((a, b) => cars.s[a] - cars.s[b] || a - b);
    }
  }

  private inView(view: SimView, x: number, y: number): boolean {
    const { box } = view;
    return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  }

  private targets(view: SimView): { cars: number; people: number } {
    const factor = densityFactor(view.zoom);
    return {
      cars: Math.round(Math.min(this.budget.cars, this.laneKm * CAR_DENSITY_PER_KM) * factor),
      people: Math.round(Math.min(this.budget.people, this.pedKm * PEOPLE_DENSITY_PER_KM) * factor),
    };
  }

  private lifecycle(view: SimView, dt: number, spawn: boolean): void {
    const { cars, people } = this;
    const r = activeRadius(view.zoom);
    const far = (r * 1.15) ** 2;
    let carCount = 0;
    for (let car = 0; car < cars.capacity; car++) {
      if (!cars.alive[car]) continue;
      if (cars.leaving[car] >= 0) {
        cars.leaving[car] -= dt;
        if (cars.leaving[car] <= 0) this.removeCar(car);
        continue;
      }
      carCount++;
      const dx = cars.x[car] - view.cx;
      const dy = cars.y[car] - view.cy;
      const visible = this.inView(view, cars.x[car], cars.y[car]);
      if (dx * dx + dy * dy > far) cars.leaving[car] = FADE_S;
      else if (cars.stopped[car] > (visible ? 2 : 1) * STUCK_S) {
        cars.leaving[car] = FADE_S;
        this.stats.carsLeftStuck++;
      }
    }
    let peopleCount = 0;
    for (let p = 0; p < people.capacity; p++) {
      if (!people.alive[p]) continue;
      if (people.leaving[p] >= 0) {
        people.leaving[p] -= dt;
        if (people.leaving[p] <= 0) this.removePerson(p);
        continue;
      }
      peopleCount++;
      const dx = people.x[p] - view.cx;
      const dy = people.y[p] - view.cy;
      if (dx * dx + dy * dy > far) people.leaving[p] = FADE_S;
    }
    this.stats.cars = carCount;
    this.stats.people = peopleCount;
    if (!spawn) return;

    this.refreshSpawnSets(view);
    const target = this.targets(view);
    this.stats.carTarget = target.cars;
    this.stats.peopleTarget = target.people;
    if (carCount < target.cars) {
      for (let i = 0; i < Math.min(SPAWN_PER_STEP, target.cars - carCount); i++) {
        this.spawnCar(view, false);
      }
    } else if (carCount > target.cars * 1.05 + 2) {
      this.sendAway(view, carCount - target.cars, true);
    }
    if (peopleCount < target.people) {
      for (let i = 0; i < Math.min(SPAWN_PER_STEP, target.people - peopleCount); i++) {
        this.spawnPerson(view, false);
      }
    } else if (peopleCount > target.people * 1.05 + 2) {
      this.sendAway(view, peopleCount - target.people, false);
    }
  }

  /** Fade out up to `count` agents, those out of view first. */
  private sendAway(view: SimView, count: number, isCars: boolean): void {
    const pool = isCars ? this.cars : this.people;
    let left = Math.min(count, SPAWN_PER_STEP);
    for (const wantHidden of [true, false]) {
      for (let i = 0; i < pool.capacity && left > 0; i++) {
        if (!pool.alive[i] || pool.leaving[i] >= 0) continue;
        if (this.inView(view, pool.x[i], pool.y[i]) === wantHidden) continue;
        pool.leaving[i] = FADE_S;
        left--;
      }
    }
  }

  private fill(view: SimView, anywhere: boolean): void {
    const target = this.targets(view);
    for (let i = 0; i < target.cars; i++) this.spawnCar(view, anywhere);
    for (let i = 0; i < target.people; i++) this.spawnPerson(view, anywhere);
    this.place();
  }

  /** Lanes and footways inside the active radius, length-weighted for sampling. */
  private refreshSpawnSets(view: SimView): void {
    const network = this.network as Network;
    const r = activeRadius(view.zoom);
    const last = this.spawnFor;
    if (last && last.r === r && Math.hypot(last.cx - view.cx, last.cy - view.cy) < 60) return;
    this.spawnFor = { cx: view.cx, cy: view.cy, r };
    const within = (line: { xs: Float64Array; ys: Float64Array }) => {
      const mid = line.xs.length >> 1;
      return Math.hypot(line.xs[mid] - view.cx, line.ys[mid] - view.cy) < r;
    };
    this.spawnLanes = [];
    this.spawnLaneCum = [];
    let total = 0;
    for (const id of network.lanes) {
      const lane = network.paths[id];
      if (lane.hidden || lane.length < 12 || !within(lane)) continue;
      total += lane.length;
      this.spawnLanes.push(id);
      this.spawnLaneCum.push(total);
    }
    this.laneKm = total / 1000;
    this.spawnEdges = [];
    this.spawnEdgeCum = [];
    total = 0;
    for (const edge of network.pedEdges) {
      if (edge.hidden || edge.crossing >= 0 || edge.length < 3 || !within(edge)) continue;
      total += edge.length;
      this.spawnEdges.push(edge.id);
      this.spawnEdgeCum.push(total);
    }
    this.pedKm = total / 1000;
  }

  private sample(ids: number[], cum: number[]): number {
    if (ids.length === 0) return -1;
    const pick = this.rng.next() * cum[cum.length - 1];
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    return ids[lo];
  }

  private spawnCar(view: SimView, anywhere: boolean): boolean {
    const network = this.network as Network;
    const traffic = this.traffic as TrafficContext;
    const { cars, rng } = this;
    // A model by share, then a free slot of it.
    let pick = rng.next();
    let model: CarModel = 'hatchback';
    for (const m of CAR_MODELS) {
      pick -= CAR_MODEL_SPECS[m].share;
      if (pick <= 0) {
        model = m;
        break;
      }
    }
    // No statutory taxi livery here: no taxis (`liveries.ts`).
    if (model === 'taxi' && !this.taxiLivery) model = 'sedan';
    const [from, to] = cars.ranges[model];
    let slot = -1;
    for (let i = from; i < to; i++) {
      if (!cars.alive[i]) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return false;
    const spec = CAR_MODEL_SPECS[model];
    const length = rng.range(spec.length[0], spec.length[1]);
    for (let attempt = 0; attempt < 8; attempt++) {
      const laneId = this.sample(this.spawnLanes, this.spawnLaneCum);
      if (laneId < 0) return false;
      const lane = network.paths[laneId];
      if (model === 'bus' && lane.speed < 8) continue;
      if (lane.length < length * 2 + 8) continue;
      const s = rng.range(length + 2, lane.length - length - 4);
      pointAt(lane, s, this.scratch);
      if (!anywhere && attempt < 6 && this.inView(view, this.scratch.x, this.scratch.y)) continue;
      // Room: nobody within 14 m either side.
      const queue = traffic.onPath[laneId];
      let clear = true;
      for (const other of queue) {
        if (Math.abs(cars.s[other] - s) < 14 + (length + cars.length[other]) / 2) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      cars.alive[slot] = 1;
      cars.path[slot] = laneId;
      cars.s[slot] = s;
      cars.length[slot] = length;
      cars.temper[slot] = rng.range(0.85, 1.08);
      cars.v[slot] = lane.speed * 0.5;
      cars.route.fill(-1, slot * ROUTE_LENGTH, (slot + 1) * ROUTE_LENGTH);
      cars.route[slot * ROUTE_LENGTH] = laneId;
      cars.routeLength[slot] = 1;
      cars.held.fill(-1, slot * HELD_MAX, (slot + 1) * HELD_MAX);
      cars.stopped[slot] = 0;
      cars.age[slot] = anywhere ? FADE_S : 0;
      cars.leaving[slot] = -1;
      const [r, g, b] =
        model === 'taxi' && this.taxiLivery ? this.taxiLivery.body : pickPaint(rng, model);
      cars.style.set([r, g, b, Math.round((length / spec.length[1]) * 255)], slot * 4);
      cars.x[slot] = this.scratch.x;
      cars.y[slot] = this.scratch.y;
      cars.h[slot] = this.scratch.h;
      extendRoute(traffic, slot);
      // Keep the lane's queue sorted for the next spawn's room check.
      let at = 0;
      while (at < queue.length && cars.s[queue[at]] < s) at++;
      queue.splice(at, 0, slot);
      return true;
    }
    return false;
  }

  private spawnPerson(view: SimView, anywhere: boolean): boolean {
    const network = this.network as Network;
    const { people, rng } = this;
    let slot = -1;
    for (let i = 0; i < people.capacity; i++) {
      if (!people.alive[i]) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const edgeId = this.sample(this.spawnEdges, this.spawnEdgeCum);
      if (edgeId < 0) return false;
      const edge = network.pedEdges[edgeId];
      const s = rng.range(0, edge.length);
      pointAt(edge, s, this.scratch);
      if (!anywhere && attempt < 6 && this.inView(view, this.scratch.x, this.scratch.y)) continue;
      people.alive[slot] = 1;
      people.edge[slot] = edgeId;
      people.s[slot] = s;
      people.dir[slot] = rng.next() < 0.5 ? 1 : -1;
      people.speed[slot] = rng.range(WALK_SPEED[0], WALK_SPEED[1]);
      people.lateral[slot] = rng.range(0.25, LATERAL_M);
      people.state[slot] = PERSON_STATE.walking;
      people.nextEdge[slot] = -1;
      people.wait[slot] = 0;
      people.age[slot] = anywhere ? FADE_S : 0;
      people.leaving[slot] = -1;
      const [r, g, b] = pickClothes(rng);
      people.style.set([r, g, b, rng.int(256)], slot * 4);
      placePerson(network, people, slot, this.scratch);
      people.x[slot] = this.scratch.x;
      people.y[slot] = this.scratch.y;
      people.h[slot] = this.scratch.h;
      return true;
    }
    return false;
  }

  private removeCar(car: number): void {
    const traffic = this.traffic as TrafficContext;
    release(traffic, car);
    this.cars.alive[car] = 0;
    this.cars.leaving[car] = -1;
  }

  private removePerson(p: number): void {
    const { people } = this;
    const network = this.network as Network;
    const traffic = this.traffic as TrafficContext;
    if (people.state[p] === PERSON_STATE.walking) {
      const edge = network.pedEdges[people.edge[p]];
      if (edge && edge.crossing >= 0) {
        traffic.crossingOccupancy[edge.crossing] = Math.max(
          0,
          traffic.crossingOccupancy[edge.crossing] - 1,
        );
      }
    }
    people.alive[p] = 0;
    people.leaving[p] = -1;
  }

  /** Positions and headings for every live agent. */
  private place(): void {
    const network = this.network as Network;
    const { cars, people, scratch } = this;
    for (let car = 0; car < cars.capacity; car++) {
      if (!cars.alive[car]) continue;
      pointAt(network.paths[cars.path[car]], cars.s[car], scratch);
      cars.x[car] = scratch.x;
      cars.y[car] = scratch.y;
      cars.h[car] = scratch.h;
    }
    for (let p = 0; p < people.capacity; p++) {
      if (!people.alive[p]) continue;
      placePerson(network, people, p, scratch);
      people.x[p] = scratch.x;
      people.y[p] = scratch.y;
      people.h[p] = scratch.h;
    }
  }

  /** Carry agents onto a rebuilt network by position (see the module header). */
  private migrate(network: Network): void {
    const traffic = this.traffic as TrafficContext;
    const { cars, people } = this;
    const grid = new SegmentGrid(25);
    for (const path of network.paths) grid.add(path.id, path);
    for (let car = 0; car < cars.capacity; car++) {
      if (!cars.alive[car]) continue;
      cars.held.fill(-1, car * HELD_MAX, (car + 1) * HELD_MAX);
      const hit = grid.nearest(network.paths, cars.x[car], cars.y[car], cars.h[car], 3);
      if (!hit) {
        cars.alive[car] = 0;
        cars.leaving[car] = -1;
        continue;
      }
      const path = network.paths[hit.id];
      cars.path[car] = hit.id;
      cars.s[car] = hit.s;
      cars.route.fill(-1, car * ROUTE_LENGTH, (car + 1) * ROUTE_LENGTH);
      cars.route[car * ROUTE_LENGTH] = hit.id;
      cars.routeLength[car] = 1;
      if (path.kind === 'connector') {
        // Already in the junction: it holds what it is on.
        cars.held[car * HELD_MAX] = hit.id;
        traffic.occupancy[hit.id]++;
      }
      extendRoute(traffic, car);
    }
    const pedGrid = new SegmentGrid(25);
    for (const edge of network.pedEdges) pedGrid.add(edge.id, edge);
    for (let p = 0; p < people.capacity; p++) {
      if (!people.alive[p]) continue;
      const hit = pedGrid.nearest(network.pedEdges, people.x[p], people.y[p], null, 3);
      if (!hit) {
        people.alive[p] = 0;
        people.leaving[p] = -1;
        continue;
      }
      const edge = network.pedEdges[hit.id];
      pointAt(edge, hit.s, this.scratch);
      const along = Math.cos(this.scratch.h - people.h[p]) >= 0;
      people.edge[p] = hit.id;
      people.s[p] = hit.s;
      people.dir[p] = along ? 1 : -1;
      people.state[p] = PERSON_STATE.walking;
      people.nextEdge[p] = -1;
      if (edge.crossing >= 0) traffic.crossingOccupancy[edge.crossing]++;
    }
  }

  /**
   * The frame for the renderer: per slot `x, y, heading, scale` (scale 0:
   * nothing to draw — free, or in a tunnel), and per slot paint bytes.
   */
  snapshot(): {
    cars: Float32Array;
    carStyle: Uint8Array;
    people: Float32Array;
    peopleStyle: Uint8Array;
  } {
    const network = this.network;
    const { cars, people } = this;
    const carOut = new Float32Array(cars.capacity * 4);
    const peopleOut = new Float32Array(people.capacity * 4);
    const fade = (age: number, leaving: number) =>
      Math.min(1, age / FADE_S) * (leaving >= 0 ? Math.max(0, leaving / FADE_S) : 1);
    if (network) {
      for (let car = 0; car < cars.capacity; car++) {
        if (!cars.alive[car]) continue;
        const o = car * 4;
        carOut[o] = cars.x[car];
        carOut[o + 1] = cars.y[car];
        carOut[o + 2] = cars.h[car];
        carOut[o + 3] = network.paths[cars.path[car]].hidden
          ? 0
          : fade(cars.age[car], cars.leaving[car]);
      }
      for (let p = 0; p < people.capacity; p++) {
        if (!people.alive[p]) continue;
        const o = p * 4;
        const edge = network.pedEdges[people.edge[p]];
        peopleOut[o] = people.x[p];
        peopleOut[o + 1] = people.y[p];
        peopleOut[o + 2] = people.h[p];
        peopleOut[o + 3] = edge?.hidden ? 0 : fade(people.age[p], people.leaving[p]);
      }
    }
    return {
      cars: carOut,
      carStyle: cars.style.slice(),
      people: peopleOut,
      peopleStyle: people.style.slice(),
    };
  }
}

/** A uniform grid of polyline segments, for snapping a position onto the nearest path. */
class SegmentGrid {
  private cells = new Map<number, number[]>();

  constructor(private readonly size: number) {}

  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  add(id: number, line: { xs: Float64Array; ys: Float64Array }): void {
    const seen = new Set<number>();
    const mark = (x: number, y: number) => {
      const key = this.key(Math.floor(x / this.size), Math.floor(y / this.size));
      if (seen.has(key)) return;
      seen.add(key);
      const list = this.cells.get(key);
      if (list) list.push(id);
      else this.cells.set(key, [id]);
    };
    // Every cell a segment passes through, sampled at half a cell.
    for (let i = 0; i < line.xs.length; i++) {
      mark(line.xs[i], line.ys[i]);
      if (i + 1 === line.xs.length) break;
      const dx = line.xs[i + 1] - line.xs[i];
      const dy = line.ys[i + 1] - line.ys[i];
      const steps = Math.ceil(Math.hypot(dx, dy) / (this.size / 2));
      for (let k = 1; k < steps; k++)
        mark(line.xs[i] + (dx * k) / steps, line.ys[i] + (dy * k) / steps);
    }
  }

  nearest(
    lines: readonly (
      | Path
      | { xs: Float64Array; ys: Float64Array; cum: Float64Array; length: number }
    )[],
    x: number,
    y: number,
    heading: number | null,
    maxDistance: number,
  ): { id: number; s: number } | null {
    const cx = Math.floor(x / this.size);
    const cy = Math.floor(y / this.size);
    let best: { id: number; s: number; d: number } | null = null;
    const at = { x: 0, y: 0, h: 0 };
    const tried = new Set<number>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
          if (tried.has(id)) continue;
          tried.add(id);
          const line = lines[id];
          const hit = project(line, x, y);
          if (hit.d > maxDistance || (best && hit.d >= best.d)) continue;
          if (heading !== null) {
            pointAt(line, hit.s, at);
            if (Math.cos(at.h - heading) < 0.75) continue;
          }
          best = { id, s: hit.s, d: hit.d };
        }
      }
    }
    return best ? { id: best.id, s: best.s } : null;
  }
}
