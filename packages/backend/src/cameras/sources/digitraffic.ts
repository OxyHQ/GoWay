/**
 * Digitraffic weather cameras (Fintraffic, Finland): `GET /weathercam/v1/stations`
 * lists the stations with their presets, and `/stations/data` says when each
 * preset's picture was taken.
 *
 * A station has one to a few PRESETS — views at a fixed pan and tilt — and each
 * is its own camera here: its picture is `https://weathercam.digitraffic.fi/{presetId}.jpg`
 * (a still the road weather system refreshes every ten minutes). The list names
 * a station by its code (`kt51_Inkoo`: main road 51, Inkoo), not by a
 * heading, so a heading is `null` rather than guessed from `directionCode`.
 */

import { getJson, dateOf, numberOf, record } from '../http';
import { accept, skip } from '../normalise';
import type {
  CameraBatch,
  CameraFetchContext,
  CameraRecord,
  CameraSource,
  CameraSourceSettings,
} from '../types';

/** Where a preset's still lives; the catalogue does not repeat it per preset. */
const IMAGE_BASE = 'https://weathercam.digitraffic.fi';
/** `collectionInterval` of every station Digitraffic documents: ten minutes. */
const REFRESH_SECONDS = 600;
/** Fintraffic asks every client to identify itself with this header. */
const CLIENT_HEADER = 'Digitraffic-User';

export function createDigitrafficSource(settings: CameraSourceSettings): CameraSource {
  const headers = { [CLIENT_HEADER]: settings.userAgent, 'user-agent': settings.userAgent };
  return {
    async read(context: CameraFetchContext): Promise<CameraBatch> {
      const skipped: Record<string, number> = {};
      const failures: string[] = [];
      const [list, data] = await Promise.allSettled([
        getJson(settings.url, context, headers),
        getJson(`${settings.url}/data`, context, headers),
      ]);
      // Without the list there is no catalogue; without the times there is a catalogue with no frame times.
      if (list.status === 'rejected') throw list.reason;
      if (data.status === 'rejected') failures.push(`frame times: ${String(data.reason)}`);
      const measured = measuredTimes(data.status === 'fulfilled' ? data.value : null);

      const features = record(list.value)?.features;
      if (!Array.isArray(features)) throw new Error('Digitraffic stations: no features');
      const cameras: CameraRecord[] = [];
      for (const feature of features) {
        const properties = record(record(feature)?.properties);
        const coordinates = record(record(feature)?.geometry)?.coordinates;
        const presets = properties?.presets;
        if (!properties || !Array.isArray(coordinates) || !Array.isArray(presets)) {
          skip(skipped, 'station');
          continue;
        }
        // A station that is not collecting (`REMOVED_TEMPORARILY`) has no current picture.
        if (properties.collectionStatus !== 'GATHERING') {
          skip(skipped, 'not-collecting');
          continue;
        }
        const code = typeof properties.name === 'string' ? properties.name : null;
        const inCollection = presets.map(record).filter((p) => p?.inCollection === true);
        for (const preset of inCollection) {
          const presetId = typeof preset?.id === 'string' ? preset.id : null;
          const candidate = {
            sourceId: presetId,
            name: code
              ? `${code.replace(/_/g, ' ')}${inCollection.length > 1 ? ` (${presetId?.slice(-2)})` : ''}`
              : null,
            kind: 'traffic',
            position: { latitude: numberOf(coordinates[1]), longitude: numberOf(coordinates[0]) },
            heading: null,
            roadName: null,
            media: { kind: 'snapshot', refreshSeconds: REFRESH_SECONDS, width: null, height: null },
            upstreamUrl: presetId ? `${IMAGE_BASE}/${presetId}.jpg` : null,
            frameAt: presetId ? (measured.get(presetId) ?? null) : null,
          };
          const camera = accept(candidate, skipped);
          if (camera) cameras.push(camera);
        }
      }
      return { cameras, complete: true, skipped, failures };
    },
  };
}

/** preset id → when its picture was taken, from `/stations/data`. */
function measuredTimes(value: unknown): Map<string, Date> {
  const out = new Map<string, Date>();
  const stations = record(value)?.stations;
  if (!Array.isArray(stations)) return out;
  for (const station of stations) {
    const presets = record(station)?.presets;
    if (!Array.isArray(presets)) continue;
    for (const preset of presets) {
      const entry = record(preset);
      const at = dateOf(entry?.measuredTime);
      if (typeof entry?.id === 'string' && at) out.set(entry.id, at);
    }
  }
  return out;
}
