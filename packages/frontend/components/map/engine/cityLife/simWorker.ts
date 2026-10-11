/**
 * The city-life simulation worker: fetch road tiles near the camera, build
 * the network, step the simulation at a fixed rate and stream each state to
 * the renderer as transferable buffers.
 *
 * Started by `lifeRenderer.ts` as `new Worker(new URL('./simWorker', import.meta.url))`
 * — the spelling Expo's Metro bundles as a SEALED worker chunk (see
 * `city3d/meshWorker.ts`), so nothing here is in the main bundle and this
 * file imports only pure modules: no three.js, no engine.
 *
 * Nothing leaves this worker but positions and paint for drawing. The
 * simulation is never read back, summarised, sent to a server, or used for
 * anything else — not routing, not ETAs, not "traffic" (docs/MAP_CITY_LIFE.md
 * → Honesty).
 */
import { CITY_TILE_ZOOM } from '@/lib/map/cityTiles';

import { mercatorXFromLng, mercatorYFromLat, tileKey } from '../city3d/tileMath';
import type { SimWorkerRequest, SimWorkerResponse } from './protocol';
import { type DecodedRoadTile, decodeRoadTile } from './roadTiles';
import { drivingSideAt } from './sim/drivingSide';
import { taxiLiveryAt } from './sim/liveries';
import { buildNetwork, type SimFrame, simFrame } from './sim/network';
import { activeRadius, CitySimulation, type SimBudget, STEP_S } from './sim/simulation';

interface WorkerScope {
  onmessage: ((event: MessageEvent<SimWorkerRequest>) => void) | null;
  postMessage(message: SimWorkerResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** The simulation does nothing below this zoom (the buildings have faded out). */
const MIN_ZOOM = 15;
/** Road tiles loaded beyond the active radius, so cars leave by fading, not by the road ending. */
const MARGIN_M = 400;
/** Most road tiles in the network at once. */
const MAX_TILES = 25;
/** Concurrent tile fetches. */
const FETCHES = 4;
/** A pan this far from the origin restarts the simulation around the new view. */
const REBASE_M = 6000;
/** Wait for more tiles before rebuilding, ms. */
const REBUILD_DEBOUNCE_MS = 250;

let template = '';
let seed = 1;
let budget: SimBudget = { cars: 0, people: 0 };
let frame: SimFrame | null = null;
let sim: CitySimulation | null = null;
let paused = false;
let lastView: Extract<SimWorkerRequest, { type: 'view' }> | null = null;

const tiles = new Map<
  string,
  { x: number; y: number; data: DecodedRoadTile | null; failed?: boolean }
>();
const inflight = new Map<string, AbortController>();
let wanted: { x: number; y: number }[] = [];
let networkKey = '';
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

const now = () => performance.timeOrigin + performance.now();

function wantedTiles(lng: number, lat: number, zoom: number): { x: number; y: number }[] {
  if (!frame) return [];
  const n = 2 ** CITY_TILE_ZOOM;
  const fx = mercatorXFromLng(lng) * n;
  const fy = mercatorYFromLat(lat) * n;
  const tileMetres = 4096 * frame.metresPerUnit;
  const reach = (activeRadius(zoom) + MARGIN_M) / tileMetres;
  const out: { x: number; y: number; d: number }[] = [];
  for (let x = Math.floor(fx - reach); x <= Math.floor(fx + reach); x++) {
    for (let y = Math.floor(fy - reach); y <= Math.floor(fy + reach); y++) {
      const dx = Math.max(x - fx, 0, fx - (x + 1));
      const dy = Math.max(y - fy, 0, fy - (y + 1));
      const d = Math.hypot(dx, dy);
      if (d <= reach) out.push({ x, y, d });
    }
  }
  out.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return out.slice(0, MAX_TILES).map(({ x, y }) => ({ x, y }));
}

function fetchTiles(): void {
  for (const tile of wanted) {
    if (inflight.size >= FETCHES) return;
    const key = tileKey({ z: CITY_TILE_ZOOM, ...tile });
    if (tiles.has(key) || inflight.has(key)) continue;
    const controller = new AbortController();
    inflight.set(key, controller);
    const url = template
      .replace('{z}', String(CITY_TILE_ZOOM))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 204 || response.status === 404) return null;
        if (!response.ok) throw new Error(`road tile ${url}: ${response.status}`);
        return decodeRoadTile(await response.arrayBuffer(), tile);
      })
      .then((data) => {
        tiles.set(key, { ...tile, data });
        scheduleRebuild();
      })
      .catch(() => {
        // A failed tile is a hole in the network, retried on the next view change.
        if (!controller.signal.aborted) tiles.set(key, { ...tile, data: null, failed: true });
      })
      .finally(() => {
        inflight.delete(key);
        fetchTiles();
      });
  }
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  // The first network as soon as anything is in; later ones once arrivals settle.
  const delay = sim?.network ? REBUILD_DEBOUNCE_MS : inflight.size > 1 ? 60 : 0;
  rebuildTimer = setTimeout(rebuild, delay);
}

function rebuild(): void {
  rebuildTimer = null;
  if (!frame || !lastView) return;
  const loaded = wanted
    .map((t) => tiles.get(tileKey({ z: CITY_TILE_ZOOM, ...t })))
    .filter((t): t is { x: number; y: number; data: DecodedRoadTile } => Boolean(t?.data));
  const key = loaded.map((t) => `${t.x}/${t.y}`).join(',');
  if (key === networkKey) return;
  networkKey = key;
  const network = buildNetwork({
    tiles: loaded,
    frame,
    drivingSide: drivingSideAt(lastView.center.lng, lastView.center.lat),
    seed,
  });
  if (!sim) sim = new CitySimulation(budget, seed);
  sim.taxiLivery = taxiLiveryAt(lastView.center.lng, lastView.center.lat);
  sim.setNetwork(network);
  applyView();
}

/** The camera in simulation metres. */
function applyView(): void {
  if (!sim || !frame || !lastView) return;
  const n = 2 ** CITY_TILE_ZOOM;
  const m = frame.metresPerUnit * 4096;
  const { originX, originY } = frame;
  const toX = (lng: number) => (mercatorXFromLng(lng) * n - originX) * m;
  const toY = (lat: number) => -(mercatorYFromLat(lat) * n - originY) * m;
  const { bounds, center, zoom } = lastView;
  sim.setView({
    cx: toX(center.lng),
    cy: toY(center.lat),
    zoom,
    box: {
      x0: toX(bounds.west),
      x1: toX(bounds.east),
      y0: toY(bounds.south),
      y1: toY(bounds.north),
    },
  });
}

function onView(view: Extract<SimWorkerRequest, { type: 'view' }>): void {
  lastView = view;
  if (view.zoom < MIN_ZOOM) return;
  const n = 2 ** CITY_TILE_ZOOM;
  const tx = Math.floor(mercatorXFromLng(view.center.lng) * n);
  const ty = Math.floor(mercatorYFromLat(view.center.lat) * n);
  if (frame) {
    const m = frame.metresPerUnit * 4096;
    const far = Math.hypot(tx - frame.originX, ty - frame.originY) * m > REBASE_M;
    if (far) {
      // Somewhere else entirely: a fresh city around the new view.
      frame = null;
      sim = null;
      networkKey = '';
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    }
  }
  if (!frame) frame = simFrame(tx, ty);
  wanted = wantedTiles(view.center.lng, view.center.lat, view.zoom);
  // Retry failures on a view change.
  for (const [key, tile] of tiles) if (tile.failed) tiles.delete(key);
  // Bounded cache: forget tiles far from the view.
  if (tiles.size > 64) {
    const keep = new Set(wanted.map((t) => tileKey({ z: CITY_TILE_ZOOM, ...t })));
    for (const key of tiles.keys()) if (!keep.has(key)) tiles.delete(key);
  }
  fetchTiles();
  scheduleRebuild();
  applyView();
}

// ── The fixed-step loop ──
let nextStep = now();
let lastStats = 0;
function loop(): void {
  const t = now();
  const running = sim;
  const active = !paused && running?.network && lastView && lastView.zoom >= MIN_ZOOM;
  if (!active || !running) {
    nextStep = t + STEP_S * 1000;
    setTimeout(loop, 100);
    return;
  }
  // Behind by more than a few steps (a rebuild, a busy machine): skip, never spiral.
  if (t - nextStep > STEP_S * 1000 * 5) nextStep = t;
  while (nextStep <= t) {
    running.step();
    nextStep += STEP_S * 1000;
  }
  post();
  if (t - lastStats > 1000) {
    lastStats = t;
    const network = running.network;
    scope.postMessage({
      type: 'stats',
      stats: { ...running.stats },
      network: network
        ? {
            lanes: network.stats.lanes,
            connectors: network.stats.connectors,
            signals: network.stats.signals,
            crossings: network.stats.crossings,
            pedEdges: network.stats.pedEdges,
            buildMs: Math.round(network.stats.buildMs),
          }
        : null,
      tiles: {
        wanted: wanted.length,
        loaded: wanted.filter((w) => tiles.get(tileKey({ z: CITY_TILE_ZOOM, ...w }))?.data).length,
        failed: [...tiles.values()].filter((w) => w.failed).length,
      },
    });
  }
  setTimeout(loop, Math.max(0, nextStep - now()));
}

function post(): void {
  if (!sim || !frame) return;
  const snapshot = sim.snapshot();
  scope.postMessage(
    {
      type: 'frame',
      // The state just computed is the one for the most recent step boundary.
      time: nextStep - STEP_S * 1000,
      origin: { x: frame.originX, y: frame.originY },
      cars: snapshot.cars,
      carStyle: snapshot.carStyle,
      ranges: sim.cars.ranges,
      taxiDoors: sim.taxiLivery?.doors ?? null,
      people: snapshot.people,
      peopleStyle: snapshot.peopleStyle,
    },
    [
      snapshot.cars.buffer as ArrayBuffer,
      snapshot.carStyle.buffer as ArrayBuffer,
      snapshot.people.buffer as ArrayBuffer,
      snapshot.peopleStyle.buffer as ArrayBuffer,
    ],
  );
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'init') {
    template = message.template;
    seed = message.seed;
    budget = message.budget;
    loop();
  } else if (message.type === 'view') onView(message);
  else if (message.type === 'pause') paused = true;
  else if (message.type === 'resume') paused = false;
};
