/**
 * Web: what kind of device the page runs on, from what a page can see — a
 * coarse pointer and the screen's short side (`gpuTier.ts` → `deviceClassOf`).
 * The native fork is `deviceClass.ts`.
 */
import type { DeviceClass } from './profile';
import { deviceClassOf } from './gpuTier';

export function currentDeviceClass(): DeviceClass {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'desktop';
  const screen = window.screen;
  return deviceClassOf({
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    shortSidePx: screen
      ? Math.min(screen.width, screen.height)
      : Math.min(window.innerWidth, window.innerHeight),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  });
}
