/**
 * City of Toronto traffic cameras (Transportation Services). The list is a
 * JSONP file — `jsonTMCEarthCamerasCallback({"Data":[…]})` — of `Number`,
 * `Name`, `Latitude`, `Longitude` (all text) and the directions each location
 * looks (`D1`..`D4`). A location's picture is
 * `…/CameraImages/loc{Number}.jpg`; the per-direction views are separate files
 * the list does not describe, so this is the location's own picture.
 */

import { getText, numberOf, record } from '../http';
import { accept } from '../normalise';
import type {
  CameraBatch,
  CameraFetchContext,
  CameraRecord,
  CameraSource,
  CameraSourceSettings,
} from '../types';

const IMAGE_BASE = 'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages';
/** Measured 2026-10-22: one location's picture changed 13:23:30 → 13:48:57 UTC, about every 25 min. */
const REFRESH_SECONDS = 1500;

/** The JSON inside `callback({…})`. */
export function unwrapJsonp(text: string): unknown {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) throw new Error('Toronto cameras: not a JSONP document');
  return JSON.parse(text.slice(open + 1, close));
}

export function createTorontoSource(settings: CameraSourceSettings): CameraSource {
  return {
    async read(context: CameraFetchContext): Promise<CameraBatch> {
      const data = record(
        unwrapJsonp(await getText(settings.url, context, { 'user-agent': settings.userAgent })),
      )?.Data;
      if (!Array.isArray(data)) throw new Error('Toronto cameras: no Data array');
      const skipped: Record<string, number> = {};
      const cameras: CameraRecord[] = [];
      for (const entry of data) {
        const row = record(entry);
        const number = typeof row?.Number === 'string' ? row.Number : null;
        const camera = accept(
          {
            sourceId: number,
            name: row?.Name,
            kind: 'traffic',
            position: { latitude: numberOf(row?.Latitude), longitude: numberOf(row?.Longitude) },
            heading: null,
            roadName: null,
            media: { kind: 'snapshot', refreshSeconds: REFRESH_SECONDS, width: null, height: null },
            upstreamUrl: number ? `${IMAGE_BASE}/loc${encodeURIComponent(number)}.jpg` : null,
            frameAt: null,
          },
          skipped,
        );
        if (camera) cameras.push(camera);
      }
      return { cameras, complete: true, skipped, failures: [] };
    },
  };
}
