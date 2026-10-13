/**
 * The street tiles' ground in ONE float array texture: a layer per slot, one
 * tile's `StreetGround` (`terrainGround.ts`: the corners of MapLibre's terrain
 * mesh over the tile, two past each edge, row-major from the north-west) per
 * layer. A street mesh reads its tile's layer by index, so one shared material
 * serves every tile (`streetMaterials.ts`) instead of a material and a texture
 * per tile, and writing a tile uploads its layer alone (a 2D atlas was
 * re-uploaded whole on every write: 3.4 MB at the high preset's 48 slots).
 *
 * Each slot is made from the engine's ONE ground (`Ground.grid`): the same
 * cached grid the buildings, trees and city life stand on. Every street tile
 * is a z15 tile, so every slot is the same size: 133² corners for MapLibre's
 * 128-square mesh, 69 KB a slot.
 */
import * as THREE from 'three';

import type { StreetGround } from '../city3d/terrainGround';

export interface GroundAtlas {
  texture: THREE.DataArrayTexture;
  /** Corners across a slot (`StreetGround.size`). */
  size: number;
  /** A free slot, or `null` when every slot is held. */
  claim(): number | null;
  release(slot: number): void;
  /** Copy a tile's ground into its slot (its layer uploaded with the next frame). */
  write(slot: number, ground: StreetGround): void;
  dispose(): void;
}

export function createGroundAtlas(slots: number, size: number): GroundAtlas {
  const cells = size * size;
  const data = new Float32Array(cells * slots);
  const texture = new THREE.DataArrayTexture(data, size, size, slots);
  texture.format = THREE.RedFormat;
  texture.type = THREE.FloatType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  // Not uploaded whole, ever: a slot is only read once written, and each
  // write sends its own layer (`addLayerUpdate`). The first write allocates
  // the texture, without uploading the slots nothing has written.
  const free = Array.from({ length: slots }, (_, i) => slots - 1 - i);
  return {
    texture,
    size,
    claim: () => free.pop() ?? null,
    release(slot) {
      free.push(slot);
    },
    write(slot, ground) {
      if (ground.size !== size)
        throw new Error(`ground atlas: a ${ground.size}² ground in ${size}² slots`);
      data.set(ground.values, slot * cells);
      texture.addLayerUpdate(slot);
      texture.needsUpdate = true;
    },
    dispose() {
      texture.dispose();
    },
  };
}
