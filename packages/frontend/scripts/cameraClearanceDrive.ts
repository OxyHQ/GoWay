/**
 * Driving a development build's camera through a building, for the two
 * browser checks of the camera rule (`docs/MAP_CAMERA_CLEARANCE.md`): the
 * local one (`check-camera-clearance.ts`, goway.to's tiles, real input) and
 * the CI leg in the visibility gate (`check-city3d-visible.ts`, the synthetic
 * city and the Sagrada Família's model).
 *
 * The camera is put where its eye is the target at bearing 0 — its centre
 * due north of the target by the eye's distance over the ground — and swept
 * through it. On every step the DRAWN eye is checked against the prisms the
 * engine holds (the build's `__gowayClearance.probe`, no margin, no ramp),
 * and the rule's own count says how many of the cameras ASKED FOR had their
 * eye inside — so a drive that never reached the building fails as vacuous.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';

import { metersPerPixel } from '@goway.to/sdk/geo';

/** MapLibre's default vertical field of view, degrees. */
const FOV = 36.87;

/** A landmark's position from the registry the build serves (`public/landmarks/registry.json`). */
export function landmarkPosition(id: string): { lat: number; lng: number } {
  const registry = JSON.parse(
    readFileSync(join(import.meta.dir, '../public/landmarks/registry.json'), 'utf8'),
  ) as {
    landmarks: Array<{
      id: string;
      placement: { position: { latitude: number; longitude: number } };
    }>;
  };
  const entry = registry.landmarks.find((l) => l.id === id);
  if (!entry) throw new Error(`no landmark ${id} in the registry`);
  return { lat: entry.placement.position.latitude, lng: entry.placement.position.longitude };
}

/**
 * The centre whose eye is `target` at bearing 0, for a screen `heightPx`
 * tall: north of it by the eye's distance over the ground (MapLibre's camera:
 * `0.5·height / tan(fov/2)` pixels from the centre, `sin(pitch)` of it flat).
 */
export function centreFor(
  target: { lat: number; lng: number },
  zoom: number,
  pitch: number,
  heightPx: number,
): { lat: number; lng: number } {
  const distanceM =
    ((0.5 * heightPx) / Math.tan((FOV * Math.PI) / 360)) * metersPerPixel(target.lat, zoom);
  const horizontal = distanceM * Math.sin((pitch * Math.PI) / 180);
  return { lat: target.lat + horizontal / 111_320, lng: target.lng };
}

export interface SweepResult {
  /** Cameras drawn. */
  steps: number;
  /** …whose drawn eye was inside a prism (must be 0). */
  inside: number;
  /** The deepest of those, metres. */
  maxDepthM: number;
  /** Camera updates whose ASKED-FOR eye was inside (the drive reached the building). */
  askedInside: number;
  /** The rule's own count of drawn eyes inside (must be 0). */
  drawnInside: number;
  /** Mean and worst time of the rule per camera change, ms. */
  meanMs: number;
  maxMs: number;
}

/**
 * Jump the camera through `bearings` around `centre` (each a whole
 * `jumpTo`, the path deep links and per-frame tours take) and check every
 * drawn eye. Needs a development build: it reads `__gowayReliefMap` and
 * `__gowayClearance`.
 */
export async function sweepThrough(
  page: Page,
  camera: { centre: { lat: number; lng: number }; zoom: number; pitch: number },
  bearings: readonly number[],
): Promise<SweepResult> {
  return page.evaluate(
    ({ centre, zoom, pitch, bearings }) => {
      const scope = globalThis as {
        __gowayReliefMap?: { jumpTo(options: object): void };
        __gowayClearance?: {
          probe(): { inside: boolean; depthM: number };
          stats: {
            updates: number;
            askedInside: number;
            drawnInside: number;
            totalMs: number;
            maxMs: number;
          } | null;
        };
      };
      const map = scope.__gowayReliefMap;
      const clearance = scope.__gowayClearance;
      if (!map || !clearance?.stats)
        throw new Error('not a development build with the camera rule');
      const before = { ...clearance.stats };
      let inside = 0;
      let maxDepthM = 0;
      for (const bearing of bearings) {
        map.jumpTo({ center: [centre.lng, centre.lat], zoom, pitch, bearing });
        const probe = clearance.probe();
        if (probe.inside) {
          inside++;
          maxDepthM = Math.max(maxDepthM, probe.depthM);
        }
      }
      const after = clearance.stats;
      const updates = Math.max(1, after.updates - before.updates);
      return {
        steps: bearings.length,
        inside,
        maxDepthM,
        askedInside: after.askedInside - before.askedInside,
        drawnInside: after.drawnInside - before.drawnInside,
        meanMs: (after.totalMs - before.totalMs) / updates,
        maxMs: after.maxMs,
      };
    },
    { ...camera, bearings: [...bearings] },
  );
}
