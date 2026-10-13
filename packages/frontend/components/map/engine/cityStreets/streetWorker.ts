/**
 * The street-detail worker: fetch a road tile and its eight neighbours
 * (`decodeRoadTile`, the simulation's decoder), the map's glyph ranges its
 * street names need, and mesh the tile's surfaces and markings
 * (`streetMesher.ts`) — off the main thread, replies transferred, not copied.
 *
 * Loaded with `new Worker(new URL('./streetWorker', import.meta.url))` from
 * the renderer, which Expo bundles as its own sealed chunk.
 */
import { decodeGlyphs, rangeNameFor } from '@/scripts/mapgen/glyph-pbf';

import { drivingSideAt } from '../roads/drivingSide';
import { type DecodedRoadTile, decodeRoadTile } from '../roads/roadTiles';
import { latFromMercatorY, tileSizeMetres } from '../city3d/tileMath';
import { paintRulesAt } from './lanes';
import type { StreetWorkerRequest, StreetWorkerResponse } from './protocol';
import { paintableScript, paintedName, meshStreetTile } from './streetMesher';
import { StreetAtlas } from './streetAtlas';

/** The slice of `DedicatedWorkerGlobalScope` used (see `meshWorker.ts`). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<StreetWorkerRequest>) => void) | null;
  postMessage(message: StreetWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const epoch = Math.floor(Math.random() * 2 ** 31);
const atlas = new StreetAtlas();
const inflight = new Map<number, AbortController>();

/** Decoded road tiles by `x/y`, most recent last: a 3×3 neighbourhood per tile, shared. */
const TILE_CACHE = 48;
const tiles = new Map<string, Promise<DecodedRoadTile | null>>();

function roadTile(template: string, x: number, y: number): Promise<DecodedRoadTile | null> {
  const key = `${x}/${y}`;
  const known = tiles.get(key);
  if (known) {
    tiles.delete(key);
    tiles.set(key, known);
    return known;
  }
  const url = template.replace('{z}', '15').replace('{x}', String(x)).replace('{y}', String(y));
  const pending = fetch(url).then(async (response) => {
    // Outside the archive, or open country: no roads.
    if (response.status === 204 || response.status === 404) return null;
    if (!response.ok) throw new Error(`road tile ${key} answered ${response.status}`);
    return decodeRoadTile(await response.arrayBuffer(), { x, y });
  });
  // A failure is not remembered: the next request for the tile asks again.
  pending.catch(() => tiles.delete(key));
  tiles.set(key, pending);
  while (tiles.size > TILE_CACHE) {
    const oldest = tiles.keys().next().value;
    if (oldest === undefined) break;
    tiles.delete(oldest);
  }
  return pending;
}

/** Glyph ranges fetched, by range name: resolved when the atlas has them (or they failed). */
const ranges = new Map<string, Promise<void>>();

function loadRange(template: string, fontstack: string, range: string): Promise<void> {
  const known = ranges.get(range);
  if (known) return known;
  const url = template
    .replace('{fontstack}', encodeURIComponent(fontstack))
    .replace('{range}', range);
  const pending = fetch(url)
    .then(async (response) => {
      if (!response.ok) return;
      for (const stack of decodeGlyphs(new Uint8Array(await response.arrayBuffer()))) {
        atlas.addGlyphs(stack.glyphs);
      }
    })
    // A range that cannot load leaves its glyphs missing: those names are not painted.
    .catch(() => {});
  ranges.set(range, pending);
  return pending;
}

/** A z15 tile's local metres (x east, y north from its north-west corner) → `[lng, lat]`. */
function toLngLat(x: number, y: number, mx: number, my: number): [number, number] {
  const n = 2 ** 15;
  const size = tileSizeMetres({ z: 15, x, y });
  const fx = x + mx / size;
  const fy = y - my / size;
  return [(fx / n) * 360 - 180, latFromMercatorY(fy / n)];
}

async function mesh(request: Extract<StreetWorkerRequest, { type: 'mesh' }>): Promise<void> {
  const controller = new AbortController();
  inflight.set(request.id, controller);
  try {
    const { x, y } = request;
    const centre = await roadTile(request.template, x, y);
    if (controller.signal.aborted) {
      scope.postMessage({ type: 'cancelled', id: request.id });
      return;
    }
    if (!centre || centre.pieces.length === 0) {
      scope.postMessage({
        type: 'mesh',
        id: request.id,
        surfaces: null,
        markings: null,
        stats: null,
        patches: [],
        epoch,
        meshMs: 0,
        paintedNames: [],
      });
      return;
    }
    const around: { x: number; y: number; data: DecodedRoadTile }[] = [{ x, y, data: centre }];
    const neighbours = await Promise.all(
      [-1, 0, 1].flatMap((dx) =>
        [-1, 0, 1]
          .filter((dy) => dx !== 0 || dy !== 0)
          .map(async (dy) => {
            // A neighbour that fails is drawn without: the edge then ends square.
            const data = await roadTile(request.template, x + dx, y + dy).catch(() => null);
            return data ? { x: x + dx, y: y + dy, data } : null;
          }),
      ),
    );
    for (const n of neighbours) if (n) around.push(n);

    if (request.glyphs) {
      const needed = new Set<string>();
      for (const ch of 'BUS') needed.add(rangeNameFor(ch.codePointAt(0) ?? 0));
      for (const piece of centre.pieces) {
        if (!piece.car || !piece.name || !paintableScript(piece.name)) continue;
        for (const ch of paintedName(piece.name)) needed.add(rangeNameFor(ch.codePointAt(0) ?? 0));
      }
      await Promise.all(
        [...needed].map((r) => loadRange(request.glyphs ?? '', request.fontstack, r)),
      );
    }
    if (controller.signal.aborted) {
      scope.postMessage({ type: 'cancelled', id: request.id });
      return;
    }

    const started = performance.now();
    const n = 2 ** 15;
    const lng = ((x + 0.5) / n) * 360 - 180;
    const lat = latFromMercatorY((y + 0.5) / n);
    const result = meshStreetTile({
      tile: { x, y },
      tiles: around,
      rules: paintRulesAt(lng, lat, drivingSideAt(lng, lat)),
      atlas,
      groundCells: request.groundCells,
      groundSubdivision: request.groundSubdivision,
    });
    const meshMs = performance.now() - started;
    const patches = atlas.takePatches();
    const { surfaces, markings } = result;
    const transfer: Transferable[] = [
      surfaces.positions.buffer,
      surfaces.attrs.buffer,
      surfaces.indices.buffer,
      markings.positions.buffer,
      markings.offsets.buffer,
      markings.uvs.buffer,
      markings.attrs.buffer,
      markings.indices.buffer,
      ...patches.map((p) => p.data.buffer),
    ] as Transferable[];
    scope.postMessage(
      {
        type: 'mesh',
        id: request.id,
        surfaces: surfaces.indices.length > 0 ? surfaces : null,
        markings: markings.indices.length > 0 ? markings : null,
        stats: result.stats,
        patches,
        epoch,
        meshMs,
        paintedNames: result.paintedNames.map(([mx, my]) => toLngLat(x, y, mx, my)),
      },
      transfer,
    );
  } catch (cause) {
    if (controller.signal.aborted) {
      scope.postMessage({ type: 'cancelled', id: request.id });
      return;
    }
    scope.postMessage({
      type: 'error',
      id: request.id,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  } finally {
    inflight.delete(request.id);
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    inflight.get(request.id)?.abort();
    return;
  }
  void mesh(request);
};
