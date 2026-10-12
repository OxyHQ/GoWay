/**
 * The street tiles' ground grids in ONE float texture: a column of slots, one
 * tile's grid (`terrainGround.ts` → `GROUND.grid`², row-major from the
 * north-west corner) per slot. A street mesh reads its tile's slot by index,
 * so one shared material serves every tile (`streetMaterials.ts`) instead of
 * a material and a texture per tile.
 *
 * The grids are the engine's ONE ground's (`Ground.grid`): the same cached
 * grids the buildings, trees and city life stand on.
 */
import * as THREE from 'three';

import { GROUND } from '../city3d/terrainGround';

export interface GroundAtlas {
  texture: THREE.DataTexture;
  /** A free slot, or `null` when every slot is held. */
  claim(): number | null;
  release(slot: number): void;
  /** Copy a tile's grid into its slot (uploaded with the next frame). */
  write(slot: number, grid: Float32Array): void;
  dispose(): void;
}

export function createGroundAtlas(slots: number): GroundAtlas {
  const cells = GROUND.grid * GROUND.grid;
  const data = new Float32Array(cells * slots);
  const texture = new THREE.DataTexture(
    data,
    GROUND.grid,
    GROUND.grid * slots,
    THREE.RedFormat,
    THREE.FloatType,
  );
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const free = Array.from({ length: slots }, (_, i) => slots - 1 - i);
  return {
    texture,
    claim: () => free.pop() ?? null,
    release(slot) {
      free.push(slot);
    },
    write(slot, grid) {
      data.set(grid.subarray(0, cells), slot * cells);
      texture.needsUpdate = true;
    },
    dispose() {
      texture.dispose();
    },
  };
}
