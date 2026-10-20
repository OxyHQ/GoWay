/**
 * The city-life simulation on hand-built road tiles: the lane graph (one-way,
 * driving side, turns, U-turns, restrictions, conflicts, the cut edge), the
 * signal cycle, the car-following model (never an overlap, queues at a red),
 * pedestrians at a signalled crossing, the spawn budget, and determinism.
 */
import { describe, expect, test } from 'bun:test';

import { buildNetwork, type Network, phaseGreen } from '../engine/cityLife/sim/network';
import { PERSON_STATE } from '../engine/cityLife/sim/pedestrians';
import {
  activeRadius,
  CitySimulation,
  densityFactor,
  STEP_S,
} from '../engine/cityLife/sim/simulation';
import { CAR_MODELS } from '../engine/cityLife/sim/fleet';
import { modelBit } from '../engine/cityLife/sim/vehicleAccess';
import { holds, IDM, idmAcceleration, ROUTE_LENGTH } from '../engine/cityLife/sim/traffic';
import { drivingSideAt } from '../engine/roads/drivingSide';
import { offsetPolyline, simFrame } from '../engine/roads/roadGraph';
import type { DecodedRoadTile, RoadPiece } from '../engine/roads/roadTiles';

// ── Building tiles by hand ───────────────────────────────────────────────

/** An Eixample tile, so metres-per-unit is Barcelona's. */
const ORIGIN = { x: 16584, y: 12231 };
const frame = simFrame(ORIGIN.x, ORIGIN.y);
const EXTENT = 4096;

/** Local metres (x east, y north from the origin tile's NW corner) → global tile units. */
function g(x: number, y: number): [number, number] {
  return [
    Math.round(ORIGIN.x * EXTENT + x / frame.metresPerUnit),
    Math.round(ORIGIN.y * EXTENT - y / frame.metresPerUnit),
  ];
}

function road(points: [number, number][], props: Partial<RoadPiece> = {}): RoadPiece {
  return {
    way: 0,
    highway: 'residential',
    car: true,
    foot: false,
    roundabout: false,
    tunnel: false,
    ...props,
    points: points.map(([x, y]) => g(x, y)),
  };
}

function tileOf(
  pieces: RoadPiece[],
  extra: Partial<Omit<DecodedRoadTile, 'pieces'>> = {},
): { x: number; y: number; data: DecodedRoadTile }[] {
  return [{ ...ORIGIN, data: { pieces, nodes: [], restrictions: [], ...extra } }];
}

function build(
  pieces: RoadPiece[],
  extra: Partial<Omit<DecodedRoadTile, 'pieces'>> = {},
  side: 'left' | 'right' = 'right',
): Network {
  return buildNetwork({ tiles: tileOf(pieces, extra), frame, drivingSide: side, seed: 1 });
}

/** A + junction at (400, −400) with four 200 m arms. */
const C: [number, number] = [400, -400];
const arm = (dx: number, dy: number): [number, number] => [C[0] + dx, C[1] + dy];
function cross(props: { ew?: Partial<RoadPiece>; ns?: Partial<RoadPiece> } = {}): RoadPiece[] {
  return [
    road([arm(-200, 0), C], { way: 1, ...props.ew }),
    road([C, arm(200, 0)], { way: 2, ...props.ew }),
    road([arm(0, -200), C], { way: 3, ...props.ns }),
    road([C, arm(0, 200)], { way: 4, ...props.ns }),
  ];
}

const lanesOf = (network: Network) => network.lanes.map((id) => network.paths[id]);
const heading = (path: { xs: Float64Array; ys: Float64Array }) => {
  const n = path.xs.length;
  return Math.atan2(path.ys[n - 1] - path.ys[0], path.xs[n - 1] - path.xs[0]);
};

// ── The graph ────────────────────────────────────────────────────────────

describe('the lane graph', () => {
  test('nodes join exactly where pieces share an end, and nowhere else', () => {
    const network = build(cross());
    // 4 arm ends + the centre.
    expect(network.nodes.length).toBe(5);
    expect(network.nodes.filter((n) => n.carDegree === 4).length).toBe(1);
    // A bridge over it shares no node: it stays its own link.
    const bridged = build([...cross(), road([arm(-50, -150), arm(50, 150)], { way: 9 })]);
    expect(bridged.nodes.length).toBe(7);
    expect(bridged.stats.links).toBe(5);
  });

  test('a two-way street gets lanes both ways; a one-way street only its own way', () => {
    const network = build([
      road(
        [
          [0, -100],
          [300, -100],
        ],
        { way: 1 },
      ),
      road(
        [
          [0, -300],
          [300, -300],
        ],
        { way: 2, oneway: 1 },
      ),
      road(
        [
          [0, -500],
          [300, -500],
        ],
        { way: 3, oneway: -1 },
      ),
    ]);
    const on = (y: number) => lanesOf(network).filter((l) => Math.abs(l.ys[0] - y) < 10);
    expect(on(-100).map(heading).map(Math.cos).sort()).toEqual(
      [-1, 1].map((v) => expect.closeTo(v, 5)) as never,
    );
    expect(on(-300).every((l) => Math.cos(heading(l)) > 0.99)).toBe(true);
    // `oneway=-1` runs against the drawn direction: westwards.
    expect(on(-500).every((l) => Math.cos(heading(l)) < -0.99)).toBe(true);
    expect(on(-300).length).toBe(1);
    expect(on(-500).length).toBe(1);
  });

  test('lanes keep to the right, or to the left where the country drives left', () => {
    const pieces = [
      road(
        [
          [0, -100],
          [300, -100],
        ],
        { way: 1 },
      ),
    ];
    for (const [side, sign] of [
      ['right', -1],
      ['left', 1],
    ] as const) {
      const network = build(pieces, {}, side);
      const eastbound = lanesOf(network).find((l) => Math.cos(heading(l)) > 0.99);
      expect(eastbound).toBeDefined();
      // Eastbound on the right is south of the centre line (y < −100).
      expect(Math.sign((eastbound?.ys[0] ?? 0) + 100)).toBe(sign);
    }
  });

  test('recorded lane counts are used; defaults only where nothing is recorded', () => {
    const network = build([
      road(
        [
          [0, -100],
          [300, -100],
        ],
        { way: 1, lanes: 4 },
      ),
      road(
        [
          [0, -300],
          [300, -300],
        ],
        { way: 2, oneway: 1, lanes: 3 },
      ),
      road(
        [
          [0, -500],
          [300, -500],
        ],
        { way: 3, highway: 'motorway', oneway: 1 },
      ),
    ]);
    const on = (y: number) => lanesOf(network).filter((l) => Math.abs(l.ys[0] - y) < 12).length;
    expect(on(-100)).toBe(4);
    expect(on(-300)).toBe(3);
    expect(on(-500)).toBe(2);
  });

  test('at a junction: every way on, no U-turn; kerb lane turns kerb-side', () => {
    const network = build(cross());
    // At the centre (each arm's far end is a cul-de-sac with its own U-turn).
    const connectors = network.paths.filter(
      (p) => p.kind === 'connector' && network.nodes[p.node].carDegree === 4,
    );
    // 4 approaches × 3 ways on.
    expect(connectors.length).toBe(12);
    expect(connectors.some((c) => c.turn === 3)).toBe(false);
    const turns = connectors.map((c) => c.turn).sort();
    expect(turns.filter((t) => t === 0).length).toBe(4);
    expect(turns.filter((t) => t === 1).length).toBe(4);
    expect(turns.filter((t) => t === 2).length).toBe(4);
    // Right-hand traffic: the kerb-side turn is a RIGHT turn (clockwise).
    for (const c of connectors.filter((c) => c.turn === 1)) {
      const from = network.paths[c.from];
      const to = network.paths[c.next[0]];
      const turn = Math.atan2(
        Math.sin(heading(to) - heading(from)),
        Math.cos(heading(to) - heading(from)),
      );
      expect(turn).toBeLessThan(0);
    }
  });

  test('a cul-de-sac turns cars round; the edge of the loaded tiles lets them leave', () => {
    // An end inside the tile: a dead end.
    const deadEnd = build([
      road(
        [
          [100, -100],
          [300, -100],
        ],
        { way: 1 },
      ),
    ]);
    expect(deadEnd.paths.some((p) => p.kind === 'connector' && p.turn === 3)).toBe(true);
    expect(lanesOf(deadEnd).some((l) => l.terminal)).toBe(false);
    // An end ON the tile's west edge, with no tile loaded beyond it: cut.
    const cut = build([
      road(
        [
          [0, -100],
          [300, -100],
        ],
        { way: 1 },
      ),
    ]);
    const westbound = lanesOf(cut).find((l) => Math.cos(heading(l)) < -0.99);
    expect(westbound?.terminal).toBe(true);
  });

  test('turn restrictions remove the turns they name', () => {
    const [x, y] = g(...C);
    const free = build(cross());
    // From way 1 (eastbound into the centre), no left turn into way 4 (north).
    const restricted = build(cross(), { restrictions: [{ from: 1, to: 4, type: 'no', x, y }] });
    const fromWay1 = (network: Network) =>
      network.paths.filter((p) => {
        if (p.kind !== 'connector' || network.nodes[p.node].carDegree !== 4) return false;
        const from = network.paths[p.from];
        return Math.cos(heading(from)) > 0.99; // eastbound approach
      });
    expect(fromWay1(free).length).toBe(3);
    expect(fromWay1(restricted).length).toBe(2);
    expect(
      fromWay1(restricted).some((c) => Math.sin(heading(restricted.paths[c.next[0]])) > 0.99),
    ).toBe(false);
    const only = build(cross(), { restrictions: [{ from: 1, to: 2, type: 'only', x, y }] });
    expect(fromWay1(only).map((c) => c.turn)).toEqual([0]);
    expect(only.stats.restrictionsApplied).toBe(1);
  });

  test('crossing movements conflict; two turns out of one lane do not', () => {
    const network = build(cross());
    const connectors = network.paths.filter(
      (p) => p.kind === 'connector' && network.nodes[p.node].carDegree === 4,
    );
    const straight = connectors.filter((c) => c.turn === 0);
    const eastWest = straight.find(
      (c) => Math.abs(Math.cos(heading(network.paths[c.from]))) > 0.99,
    );
    const northSouth = straight.find(
      (c) => Math.abs(Math.sin(heading(network.paths[c.from]))) > 0.99,
    );
    expect(eastWest?.conflicts).toContain(northSouth?.id ?? -1);
    for (const c of connectors) {
      for (const other of c.conflicts) expect(network.paths[other].from).not.toBe(c.from);
    }
  });

  test('a signal node near a junction signals the junction, by approach axis', () => {
    // OSM often tags the stop line 15 m before the junction, not the junction.
    const pieces = cross({ ew: {}, ns: {} });
    const [sx, sy] = g(C[0] - 15, C[1]);
    // Split the west arm at the signal node so it is a node of the graph.
    pieces[0] = road([arm(-200, 0), [C[0] - 15, C[1]]], { way: 1 });
    pieces.push(road([[C[0] - 15, C[1]], C], { way: 1 }));
    const network = build(pieces, { nodes: [{ kind: 'signals', x: sx, y: sy }] });
    expect(network.signals.length).toBe(1);
    const connectors = network.paths.filter(
      (p) => p.kind === 'connector' && p.node >= 0 && network.nodes[p.node].carDegree === 4,
    );
    expect(connectors.every((c) => c.signal === 0)).toBe(true);
    const groupOf = (c: (typeof connectors)[number]) => c.group;
    const ew = connectors.filter((c) => Math.abs(Math.cos(heading(network.paths[c.from]))) > 0.99);
    const ns = connectors.filter((c) => Math.abs(Math.sin(heading(network.paths[c.from]))) > 0.99);
    expect(new Set(ew.map(groupOf)).size).toBe(1);
    expect(new Set(ns.map(groupOf)).size).toBe(1);
    expect(groupOf(ew[0])).not.toBe(groupOf(ns[0]));
  });

  test('offsetPolyline keeps a constant distance on straight runs', () => {
    const out = offsetPolyline(
      [
        [0, 0],
        [10, 0],
        [20, 0],
      ],
      3,
    );
    expect(out.map(([, y]) => y)).toEqual([-3, -3, -3]);
  });
});

describe('the signal cycle', () => {
  const controller = {
    node: 0,
    greenA: 20,
    greenB: 25,
    clearance: 4,
    cycle: 53,
    offset: 7,
    midLink: false,
  };

  test('the two phases are never green together, and each gets its turn', () => {
    let aGreen = 0;
    let bGreen = 0;
    let allRed = 0;
    for (let t = 0; t < controller.cycle * 3; t += 0.25) {
      const a = phaseGreen(controller, 0, t);
      const b = phaseGreen(controller, 1, t);
      expect(a && b).toBe(false);
      if (a) aGreen++;
      if (b) bGreen++;
      if (!a && !b) allRed++;
    }
    const per = controller.cycle * 3 * 4;
    expect(aGreen / per).toBeCloseTo(20 / 53, 2);
    expect(bGreen / per).toBeCloseTo(25 / 53, 2);
    expect(allRed / per).toBeCloseTo(8 / 53, 2);
  });

  test('the cycle repeats', () => {
    for (let t = 0; t < 60; t += 1.3) {
      expect(phaseGreen(controller, 0, t)).toBe(phaseGreen(controller, 0, t + controller.cycle));
    }
  });
});

// ── Car following ────────────────────────────────────────────────────────

describe('the Intelligent Driver Model', () => {
  test('accelerates on a free road and stops for an obstacle at zero gap', () => {
    expect(idmAcceleration(0, 14, Number.POSITIVE_INFINITY, 0)).toBeCloseTo(IDM.a, 5);
    expect(idmAcceleration(14, 14, Number.POSITIVE_INFINITY, 0)).toBeCloseTo(0, 5);
    expect(idmAcceleration(10, 14, 0, 0)).toBe(-IDM.maxBrake);
    // Closing on a stopped car brakes; following at speed at a long gap does not.
    expect(idmAcceleration(10, 14, 15, 0)).toBeLessThan(-1);
    expect(idmAcceleration(10, 14, 200, 10)).toBeGreaterThan(0);
  });
});

/** A 3 × 3 grid of two-way streets, 150 m apart, every junction signalled. */
function grid(): Network {
  const pieces: RoadPiece[] = [];
  const nodes: DecodedRoadTile['nodes'] = [];
  const at = (i: number) => 150 + i * 150;
  let way = 1;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      pieces.push(
        road(
          [
            [at(j), -at(i)],
            [at(j + 1), -at(i)],
          ],
          { way: way++, lanes: 2 },
        ),
      );
      pieces.push(
        road(
          [
            [at(i), -at(j)],
            [at(i), -at(j + 1)],
          ],
          { way: way++, lanes: 2 },
        ),
      );
    }
    // Arms out to cul-de-sacs, so the grid has somewhere to go.
    pieces.push(
      road(
        [
          [at(i), -at(2)],
          [at(i), -at(2) - 120],
        ],
        { way: way++ },
      ),
    );
    pieces.push(
      road(
        [
          [at(2), -at(i)],
          [at(2) + 120, -at(i)],
        ],
        { way: way++ },
      ),
    );
  }
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const [x, y] = g(at(i), -at(j));
      nodes.push({ kind: 'signals', x, y });
    }
  }
  return build(pieces, { nodes });
}

const view = { cx: 300, cy: -300, zoom: 18, box: { x0: 250, y0: -350, x1: 350, y1: -250 } };

function runSim(seed: number, steps: number, budget = { cars: 120, people: 80 }) {
  const sim = new CitySimulation(budget, seed);
  sim.setNetwork(grid());
  sim.setView(view);
  for (let i = 0; i < steps; i++) sim.step();
  return sim;
}

describe('the traffic simulation', () => {
  test('no two cars ever overlap on a path, over thousands of steps', () => {
    const sim = new CitySimulation({ cars: 200, people: 0 }, 3);
    sim.setNetwork(grid());
    sim.setView(view);
    let checked = 0;
    for (let step = 0; step < 2400; step++) {
      sim.step();
      const byPath = new Map<number, number[]>();
      for (let car = 0; car < sim.cars.capacity; car++) {
        if (!sim.cars.alive[car]) continue;
        const list = byPath.get(sim.cars.path[car]) ?? [];
        list.push(car);
        byPath.set(sim.cars.path[car], list);
      }
      for (const list of byPath.values()) {
        list.sort((a, b) => sim.cars.s[a] - sim.cars.s[b]);
        for (let k = 1; k < list.length; k++) {
          const a = list[k - 1];
          const b = list[k];
          const gap = sim.cars.s[b] - sim.cars.s[a] - (sim.cars.length[a] + sim.cars.length[b]) / 2;
          expect(gap).toBeGreaterThan(-0.01);
          checked++;
        }
      }
    }
    // Vacuity: there were queues to check.
    expect(checked).toBeGreaterThan(1000);
  });

  test('cars move, and a red light holds a queue that the green releases', () => {
    const sim = runSim(5, 1200);
    const moving = Array.from({ length: sim.cars.capacity }, (_, i) => i).filter(
      (i) => sim.cars.alive[i] && sim.cars.v[i] > 1,
    );
    expect(moving.length).toBeGreaterThan(sim.stats.cars * 0.3);
    // Every car without the junction ahead reserved stays BEFORE the line.
    const network = sim.network as Network;
    for (let car = 0; car < sim.cars.capacity; car++) {
      if (!sim.cars.alive[car]) continue;
      const path = network.paths[sim.cars.path[car]];
      // A car that holds the junction ahead may already nose into it.
      const next = sim.cars.route[car * ROUTE_LENGTH + 1];
      if (path.kind === 'lane' && !(next >= 0 && holds(sim.cars, car, next))) {
        expect(sim.cars.s[car] + sim.cars.length[car] / 2).toBeLessThanOrEqual(path.length + 0.01);
      }
    }
  });

  test('one-way is respected: on a clockwise one-way ring every car drives clockwise', () => {
    const corners: [number, number][] = [
      [150, -150],
      [450, -150],
      [450, -450],
      [150, -450],
    ];
    const pieces = corners.map((corner, i) =>
      road([corner, corners[(i + 1) % 4]], { way: i + 1, oneway: 1, lanes: 2 }),
    );
    const sim = new CitySimulation({ cars: 40, people: 0 }, 9);
    sim.setNetwork(build(pieces));
    sim.setView({ cx: 300, cy: -300, zoom: 18, box: { x0: 0, y0: -600, x1: 600, y1: 0 } });
    let checked = 0;
    for (let step = 0; step < 600; step++) {
      sim.step();
      for (let car = 0; car < sim.cars.capacity; car++) {
        if (!sim.cars.alive[car]) continue;
        const rx = sim.cars.x[car] - 300;
        const ry = sim.cars.y[car] + 300;
        // Clockwise in a y-north frame: the heading crosses the radius negatively.
        const cross = rx * Math.sin(sim.cars.h[car]) - ry * Math.cos(sim.cars.h[car]);
        expect(cross).toBeLessThan(1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  test('the budget caps agents, and density follows the zoom', () => {
    const sim = runSim(2, 200, { cars: 40, people: 30 });
    expect(sim.stats.cars).toBeLessThanOrEqual(40);
    expect(sim.stats.people).toBeLessThanOrEqual(30);
    expect(sim.stats.carTarget).toBeLessThanOrEqual(40);
    expect(densityFactor(15.5)).toBeLessThan(densityFactor(17));
    expect(densityFactor(19)).toBe(1);
    expect(activeRadius(16)).toBeGreaterThan(activeRadius(18));
  });

  test('zooming out thins the city: the target drops and agents leave', () => {
    const sim = runSim(4, 300, { cars: 200, people: 100 });
    const before = sim.stats.cars;
    sim.setView({ ...view, zoom: 15.6 });
    for (let i = 0; i < 400; i++) sim.step();
    expect(sim.stats.carTarget).toBeLessThan(before);
    expect(sim.stats.cars).toBeLessThanOrEqual(Math.ceil(sim.stats.carTarget * 1.05) + 2);
  });

  test('no taxis where the city has no taxi livery; taxis in its paint where it does', () => {
    const plain = runSim(12, 200, { cars: 200, people: 0 });
    const [from, to] = plain.cars.ranges.taxi;
    for (let i = from; i < to; i++) expect(plain.cars.alive[i]).toBe(0);
    const sim = new CitySimulation({ cars: 200, people: 0 }, 12);
    sim.taxiLivery = { body: [40, 40, 44], doors: [238, 200, 70] };
    sim.setNetwork(grid());
    sim.setView(view);
    for (let i = 0; i < 200; i++) sim.step();
    let taxis = 0;
    for (let i = from; i < to; i++) {
      if (!sim.cars.alive[i]) continue;
      taxis++;
      expect(Array.from(sim.cars.style.subarray(i * 4, i * 4 + 3))).toEqual([40, 40, 44]);
    }
    expect(taxis).toBeGreaterThan(0);
  });

  test('deterministic: the same seed gives the same city, another seed another', () => {
    const a = runSim(42, 300).snapshot();
    const b = runSim(42, 300).snapshot();
    const c = runSim(43, 300).snapshot();
    expect(Array.from(a.cars)).toEqual(Array.from(b.cars));
    expect(Array.from(a.people)).toEqual(Array.from(b.people));
    expect(Array.from(a.carStyle)).toEqual(Array.from(b.carStyle));
    expect(Array.from(a.cars)).not.toEqual(Array.from(c.cars));
  });

  test('a rebuilt network carries cars across by position', () => {
    const sim = runSim(8, 200);
    const alive = sim.stats.cars;
    sim.setNetwork(grid());
    sim.step();
    expect(sim.stats.cars).toBeGreaterThanOrEqual(alive * 0.9);
  });

  test('one step stays well inside its time budget', () => {
    const sim = runSim(6, 50, { cars: 200, people: 200 });
    const started = performance.now();
    for (let i = 0; i < 100; i++) sim.step();
    expect((performance.now() - started) / 100).toBeLessThan(STEP_S * 1000);
  });
});

describe('pedestrians', () => {
  test('wait at a signalled crossing while the road is green, cross on its red', () => {
    // A north–south footway crossing an east–west road at a signalled junction.
    const pieces = [
      ...cross(),
      road(
        [
          [C[0] + 20, C[1] - 60],
          [C[0] + 20, C[1]],
        ],
        { way: 20, car: false, foot: true, highway: 'footway', footway: 'crossing' },
      ),
    ];
    // The crossing joins the road at a node 20 m east of the junction.
    pieces[1] = road([C, [C[0] + 20, C[1]]], { way: 2 });
    pieces.push(road([[C[0] + 20, C[1]], arm(200, 0)], { way: 2 }));
    pieces.push(
      road(
        [
          [C[0] + 20, C[1]],
          [C[0] + 20, C[1] + 60],
        ],
        { way: 21, car: false, foot: true, highway: 'footway', footway: 'crossing' },
      ),
    );
    const [sx, sy] = g(...C);
    const network = build(pieces, { nodes: [{ kind: 'signals', x: sx, y: sy }] });
    const crossing = network.crossings.find((c) => c.pedEdges.length > 0);
    expect(crossing).toBeDefined();
    expect(crossing?.signal).toBe(0);
    // The road it crosses runs east–west; people walk only while that phase is red.
    const controller = network.signals[0];
    let walkWhileGreen = 0;
    for (let t = 0; t < controller.cycle; t += 0.5) {
      const roadGreen = phaseGreen(controller, crossing?.group ?? 0, t);
      const walk = phaseGreen(controller, 1 - (crossing?.group ?? 0), t);
      if (roadGreen && walk) walkWhileGreen++;
    }
    expect(walkWhileGreen).toBe(0);
    // And lanes over it carry a stop for whoever is on it.
    expect(crossing?.lanes.length).toBeGreaterThan(0);
  });

  test('people walk the footways and are drawn on them', () => {
    const pieces = [
      road(
        [
          [100, -100],
          [400, -100],
        ],
        { car: false, foot: true, highway: 'footway' },
      ),
      road(
        [
          [400, -100],
          [400, -400],
        ],
        { car: false, foot: true, highway: 'footway' },
      ),
      road(
        [
          [400, -400],
          [100, -100],
        ],
        { car: false, foot: true, highway: 'footway' },
      ),
    ];
    const sim = new CitySimulation({ cars: 0, people: 20 }, 1);
    sim.setNetwork(build(pieces));
    sim.setView({ cx: 250, cy: -250, zoom: 18, box: { x0: 0, y0: -500, x1: 500, y1: 0 } });
    for (let i = 0; i < 200; i++) sim.step();
    expect(sim.stats.people).toBeGreaterThan(0);
    for (let p = 0; p < sim.people.capacity; p++) {
      if (!sim.people.alive[p]) continue;
      expect<number[]>([
        PERSON_STATE.walking,
        PERSON_STATE.transfer,
        PERSON_STATE.waiting,
      ]).toContain(sim.people.state[p]);
      // Within a metre and a bit of the triangle's sides (the lateral offset).
      const { x, y } = { x: sim.people.x[p], y: sim.people.y[p] };
      const toSeg = (ax: number, ay: number, bx: number, by: number) => {
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2),
          ),
        );
        return Math.hypot(ax + (bx - ax) * t - x, ay + (by - ay) * t - y);
      };
      const d = Math.min(
        toSeg(100, -100, 400, -100),
        toSeg(400, -100, 400, -400),
        toSeg(400, -400, 100, -100),
      );
      expect(d).toBeLessThan(1.5);
    }
  });
});

describe('driving side', () => {
  test('a coarse table, right everywhere it is not left', () => {
    expect(drivingSideAt(2.164, 41.392)).toBe('right'); // Barcelona
    expect(drivingSideAt(-74.01, 40.71)).toBe('right'); // New York
    expect(drivingSideAt(-0.12, 51.5)).toBe('left'); // London
    expect(drivingSideAt(139.77, 35.68)).toBe('left'); // Tokyo
    expect(drivingSideAt(126.98, 37.57)).toBe('right'); // Seoul
    expect(drivingSideAt(129.07, 35.18)).toBe('right'); // Busan
    expect(drivingSideAt(69.2, 34.5)).toBe('right'); // Kabul
    expect(drivingSideAt(104.9, 11.55)).toBe('right'); // Phnom Penh
    expect(drivingSideAt(30.06, -1.95)).toBe('right'); // Kigali
    expect(drivingSideAt(77.2, 28.6)).toBe('left'); // Delhi
    expect(drivingSideAt(100.5, 13.75)).toBe('left'); // Bangkok
    expect(drivingSideAt(18.42, -33.92)).toBe('left'); // Cape Town
  });
});

describe('who may drive where', () => {
  const car = modelBit('sedan');
  const bus = modelBit('bus');

  /** A cross whose east-west road has a recorded bus lane at each kerb. */
  const busLaneCross = () =>
    build(
      cross({
        ew: {
          lanes: 4,
          lanesForward: 2,
          lanesBackward: 2,
          busLanesForward: [false, true],
          busLanesBackward: [false, true],
        },
      }),
    );

  test("a recorded bus lane is the buses' alone; the lanes beside it are the road's", () => {
    const network = busLaneCross();
    const ew = lanesOf(network).filter((lane) => lane.users === bus);
    // One bus lane per direction on each of the two east-west pieces' links.
    expect(ew.length).toBeGreaterThanOrEqual(2);
    for (const lane of ew) expect(lane.laneIndex).toBe(0);
    const open = lanesOf(network).filter((lane) => lane.users & car && lane.laneIndex === 1);
    expect(open.length).toBeGreaterThanOrEqual(2);
  });

  test('a road shut to cars but open to buses carries buses and nothing else', () => {
    const network = build(
      cross({ ew: { access: { car: 'no', taxi: 'no', van: 'no', hgv: 'no', bus: 'designated' } } }),
    );
    const busOnly = lanesOf(network).filter((lane) => lane.users === bus);
    expect(busOnly.length).toBeGreaterThan(0);
    // The north-south road stays the cars'; the bus street is no one else's.
    expect(lanesOf(network).some((lane) => lane.users & car)).toBe(true);
    for (const lane of lanesOf(network))
      expect(lane.users === bus || lane.users & car).toBeTruthy();
  });

  test('over thousands of steps no vehicle is ever in a lane its class may not drive', () => {
    const sim = new CitySimulation({ cars: 200, people: 0 }, 9);
    sim.setNetwork(busLaneCross());
    sim.setView(view);
    let checked = 0;
    for (let step = 0; step < 1800; step++) {
      sim.step();
      for (let slot = 0; slot < sim.cars.capacity; slot++) {
        if (!sim.cars.alive[slot]) continue;
        const path = sim.network?.paths[sim.cars.path[slot]];
        if (path?.kind !== 'lane') continue;
        const bit = modelBit(CAR_MODELS[sim.cars.model[slot]]);
        expect((path.users | path.local) & bit).toBeTruthy();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  test("a service lane carries a fraction of an avenue's traffic", () => {
    const avenue = lanesOf(build(cross({ ew: { highway: 'primary' } }))).find(
      (lane) => lane.weight > 0,
    );
    const service = lanesOf(build(cross({ ew: { highway: 'service' } }))).find(
      (lane) => lane.weight > 0,
    );
    expect(avenue?.weight).toBe(1);
    expect(service?.weight).toBeLessThan(0.1);
  });

  test("a service road in a park keeps a tenth of a service road's traffic", () => {
    const weightOf = (park: boolean) =>
      lanesOf(build(cross({ ew: { highway: 'service', park } }))).find((lane) => lane.weight > 0)
        ?.weight;
    expect(weightOf(false)).toBe(0.06);
    expect(weightOf(true)).toBeCloseTo(0.006, 6);
  });

  test('a destination-only street admits cars to arrive, never to pass', () => {
    const network = build(cross({ ew: { highway: 'living_street' } }));
    const lanes = lanesOf(network).filter((lane) => lane.local & car);
    expect(lanes.length).toBeGreaterThan(0);
    for (const lane of lanes) expect(lane.users & car).toBe(0);
  });
});
