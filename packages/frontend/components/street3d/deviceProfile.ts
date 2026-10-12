/**
 * What this device can afford to draw.
 *
 * A Gaussian scene is the heaviest thing GoWay renders: millions of splats,
 * sorted every few frames, in GPU memory a phone shares with everything else.
 * The cost of guessing wrong is a crashed tab, so the viewer degrades on any
 * signal of a constrained device rather than waiting to run out.
 *
 * Signals are read by the caller (`readDeviceSignals` on web) and judged here,
 * purely, so the policy is tested without a browser.
 */
import type { SceneDeviceTier } from './types';

export interface DeviceSignals {
  webgl2: boolean;
  devicePixelRatio: number;
  /** `navigator.deviceMemory`, GB, where the browser reports it. */
  deviceMemoryGb?: number;
  hardwareConcurrency?: number;
  /** `navigator.connection.saveData`. */
  saveData?: boolean;
  /** `navigator.connection.effectiveType`. */
  effectiveType?: string;
  /** `MAX_TEXTURE_SIZE` of the WebGL2 context. */
  maxTextureSize?: number;
  /** The unmasked WebGL renderer string, where the browser reports it. */
  gpuRenderer?: string;
  /** A phone or tablet (`navigator.userAgentData.mobile`, else the user agent). */
  mobile?: boolean;
  /**
   * Byte size of a full splat that loads WHOLE (`spz`), to compare against
   * memory. Absent for a level-of-detail tree, which holds only what its
   * budget draws.
   */
  fullSplatBytes?: number;
}

export interface DeviceAssessment {
  tier: SceneDeviceTier;
  /** Cap on the canvas pixel ratio. Splat cost is per pixel; retina is a luxury. */
  pixelRatio: number;
  /**
   * Multiplier on the renderer's per-platform level-of-detail budget — the
   * splats a `rad` scene may draw at once, which is also what it streams and
   * holds. No effect on an `spz` scene.
   */
  lodScale: number;
  /**
   * How far the quality governor (`qualityGovernor.ts`) may climb from
   * `lodScale` / `pixelRatio` once frames show the device keeping up, and how
   * far it may fall when they show it is not. The page pool is sized for
   * `maxLodScale`, so it is decided here, before anything is allocated.
   */
  maxLodScale: number;
  maxPixelRatio: number;
  minLodScale: number;
  /** Why the tier is not `full` — for the dev overlay, never for users. */
  reasons: string[];
}

const SLOW_CONNECTIONS = new Set(['slow-2g', '2g', '3g']);

/** Full-tier pixel ratio cap. */
export const MAX_PIXEL_RATIO = 1.5;
/** Preview-tier pixel ratio cap. */
export const PREVIEW_PIXEL_RATIO = 1;
/**
 * Full-tier detail budget: the renderer's own per-platform base (Spark: 2.5M
 * splats on desktop, 1.5M on iOS, 1M on Android), which already separates a
 * phone from a computer. An integrated laptop GPU draws it at the 1.5 pixel
 * ratio cap; the dev overlay's splat count and fps are where to re-tune it.
 */
export const FULL_LOD_SCALE = 1;
/**
 * Preview-tier detail budget: half the base. A constrained device draws, sorts,
 * streams and pools half as many splats — the whole scene still, coarser —
 * rather than a separate light asset.
 */
export const PREVIEW_LOD_SCALE = 0.5;
/**
 * The governor's ceiling on a discrete GPU in a computer: twice the desktop
 * base, 5M splats — the most a street block shows from walking distance, and
 * what a 192-page pool (`sparkEngine.ts`) holds with room to turn around.
 */
export const DISCRETE_GPU_MAX_LOD_SCALE = 2;
/** Its pixel-ratio ceiling: a 2× canvas, where the screen has one. */
export const DISCRETE_GPU_MAX_PIXEL_RATIO = 2;
/** The governor's floor on every tier: a scene still recognisable, never a blank. */
export const MIN_LOD_SCALE = 0.3;

/**
 * A GPU with its own memory. Integrated GPUs (Intel UHD/Iris, AMD Radeon
 * Graphics/Vega, Apple, Mali, Adreno) share the system's, so a large splat pool
 * starves the browser; they keep the base budget as their ceiling.
 */
const DISCRETE_GPU = /\b(GeForce|RTX|Quadro|NVIDIA (A|L)\d|Radeon (RX|Pro)|Arc\(TM\) A|Arc A\d)/i;

export function hasDiscreteGpu(renderer: string | undefined): boolean {
  return renderer !== undefined && DISCRETE_GPU.test(renderer);
}

export function assessDevice(signals: DeviceSignals): DeviceAssessment {
  const dpr =
    Number.isFinite(signals.devicePixelRatio) && signals.devicePixelRatio > 0
      ? signals.devicePixelRatio
      : 1;
  if (!signals.webgl2)
    return {
      tier: 'unsupported',
      pixelRatio: 1,
      lodScale: 0,
      maxLodScale: 0,
      maxPixelRatio: 1,
      minLodScale: 0,
      reasons: ['no WebGL2'],
    };

  const reasons: string[] = [];
  if (signals.deviceMemoryGb !== undefined && signals.deviceMemoryGb <= 2)
    reasons.push(`deviceMemory ${signals.deviceMemoryGb} GB`);
  if (signals.hardwareConcurrency !== undefined && signals.hardwareConcurrency <= 2)
    reasons.push(`${signals.hardwareConcurrency} cores`);
  if (signals.saveData) reasons.push('save-data');
  if (signals.effectiveType && SLOW_CONNECTIONS.has(signals.effectiveType))
    reasons.push(`connection ${signals.effectiveType}`);
  if (signals.maxTextureSize !== undefined && signals.maxTextureSize < 4096)
    reasons.push(`max texture ${signals.maxTextureSize}`);
  // A decoded splat is several times its compressed size; past ~1/40th of
  // reported memory for the COMPRESSED file, the full scene does not fit
  // comfortably beside the browser itself.
  if (
    signals.deviceMemoryGb !== undefined &&
    signals.fullSplatBytes !== undefined &&
    signals.fullSplatBytes > (signals.deviceMemoryGb * 1e9) / 40
  ) {
    reasons.push('splat too large for reported memory');
  }

  if (reasons.length > 0)
    return {
      tier: 'preview',
      pixelRatio: Math.min(dpr, PREVIEW_PIXEL_RATIO),
      lodScale: PREVIEW_LOD_SCALE,
      // A constrained device streams no more than it started with.
      maxLodScale: PREVIEW_LOD_SCALE,
      maxPixelRatio: Math.min(dpr, PREVIEW_PIXEL_RATIO),
      minLodScale: MIN_LOD_SCALE,
      reasons,
    };
  const headroom = !signals.mobile && hasDiscreteGpu(signals.gpuRenderer);
  return {
    tier: 'full',
    pixelRatio: Math.min(dpr, MAX_PIXEL_RATIO),
    lodScale: FULL_LOD_SCALE,
    maxLodScale: headroom ? DISCRETE_GPU_MAX_LOD_SCALE : FULL_LOD_SCALE,
    maxPixelRatio: Math.min(dpr, headroom ? DISCRETE_GPU_MAX_PIXEL_RATIO : MAX_PIXEL_RATIO),
    minLodScale: MIN_LOD_SCALE,
    reasons,
  };
}
