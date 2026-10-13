/**
 * The street tiles' ground grids in ONE float texture: a column of slots, one
 * tile's grid (`terrainGround.ts` → `GroundGrid`: the DEM's pixel centres
 * across the tile and one past each edge, row-major from the north-west) per
 * slot. A street mesh reads its tile's slot by index, so one shared material
 * serves every tile (`streetMaterials.ts`) instead of a material and a texture
 * per tile.
 *
 * The grids are the engine's ONE ground's (`Ground.grid`): the same cached
 * grids the buildings, trees and city life stand on. Every street tile is a
 * z15 tile, so every slot is the same size: 66² for GoWay's DEM (64 pixels
 * across a z15 tile), 17 KB a slot.
 */
import * as THREE from 'three';

import type { GroundGrid } from '../city3d/terrainGround';

export interface GroundAtlas {
  texture: THREE.DataTexture;
  /** Samples across a slot (`GroundGrid.size`). */
  size: number;
  /** A free slot, or `null` when every slot is held. */
  claim(): number | null;
  release(slot: number): void;
  /** Copy a tile's grid into its slot (uploaded with the next frame). */
  write(slot: number, grid: GroundGrid): void;
  dispose(): void;
}

export function createGroundAtlas(slots: number, size: number): GroundAtlas {
  const cells = size * size;
  const data = new Float32Array(cells * slots);
  const texture = new THREE.DataTexture(data, size, size * slots, THREE.RedFormat, THREE.FloatType);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const free = Array.from({ length: slots }, (_, i) => slots - 1 - i);
  return {
    texture,
    size,
    claim: () => free.pop() ?? null,
    release(slot) {
      free.push(slot);
    },
    write(slot, grid) {
      if (grid.size !== size)
        throw new Error(`ground atlas: a ${grid.size}² grid in ${size}² slots`);
      data.set(grid.values, slot * cells);
      texture.needsUpdate = true;
    },
    dispose() {
      texture.dispose();
    },
  };
}
