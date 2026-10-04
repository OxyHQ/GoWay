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
  /** Byte size of the full splat, to compare against memory. */
  fullSplatBytes?: number;
}

export interface DeviceAssessment {
  tier: SceneDeviceTier;
  /** Cap on the canvas pixel ratio. Splat cost is per pixel; retina is a luxury. */
  pixelRatio: number;
  /** Why the tier is not `full` — for the dev overlay, never for users. */
  reasons: string[];
}

const SLOW_CONNECTIONS = new Set(['slow-2g', '2g', '3g']);

/** Full-tier pixel ratio cap. */
export const MAX_PIXEL_RATIO = 1.5;
/** Preview-tier pixel ratio cap. */
export const PREVIEW_PIXEL_RATIO = 1;

export function assessDevice(signals: DeviceSignals): DeviceAssessment {
  const dpr = Number.isFinite(signals.devicePixelRatio) && signals.devicePixelRatio > 0 ? signals.devicePixelRatio : 1;
  if (!signals.webgl2) return { tier: 'unsupported', pixelRatio: 1, reasons: ['no WebGL2'] };

  const reasons: string[] = [];
  if (signals.deviceMemoryGb !== undefined && signals.deviceMemoryGb <= 2) reasons.push(`deviceMemory ${signals.deviceMemoryGb} GB`);
  if (signals.hardwareConcurrency !== undefined && signals.hardwareConcurrency <= 2) reasons.push(`${signals.hardwareConcurrency} cores`);
  if (signals.saveData) reasons.push('save-data');
  if (signals.effectiveType && SLOW_CONNECTIONS.has(signals.effectiveType)) reasons.push(`connection ${signals.effectiveType}`);
  if (signals.maxTextureSize !== undefined && signals.maxTextureSize < 4096) reasons.push(`max texture ${signals.maxTextureSize}`);
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

  if (reasons.length > 0) return { tier: 'preview', pixelRatio: Math.min(dpr, PREVIEW_PIXEL_RATIO), reasons };
  return { tier: 'full', pixelRatio: Math.min(dpr, MAX_PIXEL_RATIO), reasons };
}
