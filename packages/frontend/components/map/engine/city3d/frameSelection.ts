/**
 * Which tiles a frame draws, when that is decided, and what the sun's shadow
 * map must be redrawn for — the per-frame bookkeeping of `cityEngine.ts`,
 * pure, so the order of a host frame is a test (`__tests__/city3dFrame.test.ts`)
 * rather than a comment.
 *
 * ## A host frame has two passes
 *
 * MapLibre calls a custom layer's `prerender` (its offscreen pass) and then
 * its `render` (the main pass), once each per frame. With the city sky on,
 * the shadow map is drawn in `prerender` — so the frame's tile selection
 * (which tiles are wanted, which are grounded on terrain, which are drawn)
 * must be made THERE, before the shadow pass, and reused by `render`. Made in
 * `render` alone, the shadow map was always one frame behind: after a pan it
 * held the previous view's buildings (review of #125).
 *
 * Without the sky there is no `prerender`, and `render` selects, as it always
 * did. {@link FrameSchedule} is that rule.
 */

import type { TileId } from './tileMath';

/**
 * The three.js layer the sun's shadow map renders: the BUILDINGS join it
 * (`cityMeshes.ts`), nothing else does. The scene also holds instanced trees
 * and the city-life overlays, which the depth-only caster material cannot
 * draw (it knows no instancing) — so they are left out by layer rather than
 * hidden and re-shown around the pass.
 */
export const SHADOW_CASTER_LAYER = 1;

/**
 * The city sky's ground passes (`tsl/skyPasses.ts`): in the engine's scene,
 * drawn first in the same render as the buildings, and on their own layer so
 * a frame with no city (zoomed out of its fade) can draw them alone.
 */
export const SKY_PASS_LAYER = 2;

/** Who selects the tiles in a frame: the first pass of it. */
export class FrameSchedule {
  private selectedThisFrame = false;

  /** The offscreen pass: it always selects, and the main pass will reuse it. */
  prerender(): boolean {
    this.selectedThisFrame = true;
    return true;
  }

  /** The main pass: selects only when no offscreen pass did this frame. Ends the frame. */
  render(): boolean {
    const select = !this.selectedThisFrame;
    this.selectedThisFrame = false;
    return select;
  }
}

/** The building fade for a zoom, 0…1 (shared with `building-3d`'s). */
export function buildingOpacity(zoom: number, fade: { start: number; end: number }): number {
  return Math.max(0, Math.min(1, (zoom - fade.start) / (fade.end - fade.start)));
}

/**
 * Whether the sky's offscreen pass runs this frame: whenever the sky is on —
 * NOT only while buildings are visible. Below the buildings' fade the sky and
 * the haze still draw (from z12), and their programs declare the shadow
 * sampler; the offscreen pass is where the shadow target is first allocated,
 * and a program whose shadow sampler has no allocated depth texture fails to
 * draw at all (review of #125: the sky vanished between z12 and z15.5). The
 * sky decides inside whether there is anything to cast.
 */
export function runsSkyOffscreenPass(input: { sky: boolean; buildings: boolean }): boolean {
  return input.sky && input.buildings;
}

/** One drawn tile, as the shadow map's cache key needs it. */
export interface DrawnTile {
  key: string;
  /** The tile it is drawn as (for whether it can cast into the shadow map). */
  tile: TileId;
  /** The world copy it is drawn in (antimeridian). */
  wrap: number;
  /** Bumped whenever the tile's terrain lift changed (`terrainGround.ts`). */
  groundRevision: number;
}

/**
 * The part of the shadow map's cache key that depends on the buildings: which
 * tiles cast into it, where, and on what ground. A tile's terrain lift moving
 * its buildings up or down changes their shadows as surely as a new tile does
 * (review of #125: shadows stayed at the old lift).
 *
 * A SET: sorted, so the same tiles in another order (the engine draws them
 * nearest first, and "nearest" changes with every step of an orbit) are the
 * same key. Before this, an orbit redrew the shadow map on every frame
 * (`docs/MAP_PERFORMANCE.md` → hotspots). The caller passes only the tiles
 * that can cast into the map (`shadows.ts` → `castsInto`), so a tile coming
 * into view far beyond the shadow box redraws nothing either.
 */
export function castersKey(drawn: readonly DrawnTile[], groundEpoch: number): string {
  const tiles = drawn.map((t) => `${t.key}@${t.wrap}#${t.groundRevision}`).sort();
  return `${groundEpoch}|${tiles.join(',')}`;
}
