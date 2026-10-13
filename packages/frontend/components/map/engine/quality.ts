/**
 * The engines' reading of the map's {@link QualityProfile}
 * (`lib/map/quality/profile.ts`): the profile is platform-neutral budgets;
 * this turns them into what the city engine and its parts take — a LOD policy,
 * a draw budget, worker and upload limits, the shadow map — in ONE place, so
 * no engine module keeps a budget of its own beside the profile.
 *
 * Pure (no three.js): imported by the engine at runtime and by the CI budget
 * gate (`components/map/__tests__/frameBudget.test.ts`).
 */
import type { QualityProfile } from '@/lib/map/quality/profile';

import type { VolumeLimits } from './camera/volumes';
import { type DrawBudget, LOD_POLICY, type LodPolicy } from './city3d/lod';
import { poolSize } from './city3d/workerPool';

export interface CityQuality {
  lod: LodPolicy;
  draw: DrawBudget;
  cacheBytes: number;
  uploadBytesPerFrame: number;
  workers: number;
  /** Tree instances per frame; 0: the workers place no trees at all. */
  treeBudget: number;
  /** `null`: no sun shadows (no shadow pass, no shadow map, no PCF in any shader). */
  shadows: { mapSize: number; taps: number } | null;
  /** What one tile's camera volumes may hold (`camera/volumes.ts`), handed to the mesh worker. */
  volumes: VolumeLimits;
}

export function cityQuality(
  profile: QualityProfile,
  hardwareConcurrency: number | undefined,
): CityQuality {
  const { city, sky, camera } = profile;
  return {
    lod: {
      ...LOD_POLICY,
      maxTiles: city.maxTiles,
      maxFullTiles: city.maxFullTiles,
      pixelTolerance: city.pixelTolerance,
    },
    draw: { bytes: city.drawBytes, vertices: city.drawVertices },
    cacheBytes: city.cacheBytes,
    uploadBytesPerFrame: city.uploadBytesPerFrame,
    workers: Math.max(1, Math.min(poolSize(hardwareConcurrency), city.maxWorkers)),
    treeBudget: city.treeBudget,
    shadows: sky.shadowMapSize > 0 ? { mapSize: sky.shadowMapSize, taps: sky.shadowTaps } : null,
    volumes: {
      maxBytes: camera.volumeBytesPerTile,
      maxFootprintVertices: camera.footprintVertices,
    },
  };
}
