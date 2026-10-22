/**
 * Iowa DOT's traffic cameras: an ArcGIS layer (`Traffic_Cameras_View`) whose
 * attributes carry the picture (`ImageURL`, a JPEG) and, for most cameras, an
 * HLS stream (`VideoURL`) GoWay does not relay yet.
 *
 * `UpdateDate` (`20261022`), `UpdateTime` (`64148` = 06:41:48) and `UTCoffset`
 * (`-500` = UTC−05:00) say when the picture was taken, as three integers.
 */

import { numberOf } from '../http';
import type { CameraSource, CameraSourceSettings } from '../types';
import { createArcGisSource } from './arcgis';

const REFRESH_SECONDS = 60;

/** `…/Metro/wwdtv06hd.jpeg` → `wwdtv06hd`; `…/RestAreas/RA35SB98-01-CENTER.jpg` → `ra35sb98-01-center`. */
export function imageStem(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const stem = (url.split('?')[0] ?? '')
    .split('/')
    .pop()
    ?.replace(/\.[A-Za-z0-9]+$/, '');
  return stem ? stem.toLowerCase() : null;
}

/** `20261022`, `64148`, `-500` → the instant, or `null` when they do not make one. */
export function iowaFrameAt(date: unknown, time: unknown, offset: unknown): Date | null {
  const d = numberOf(date);
  const t = numberOf(time);
  const o = numberOf(offset);
  if (d === null || t === null || o === null) return null;
  const [year, month, day] = [Math.floor(d / 10000), Math.floor(d / 100) % 100, d % 100];
  const [hour, minute, second] = [Math.floor(t / 10000), Math.floor(t / 100) % 100, t % 100];
  const offsetMinutes = Math.trunc(o / 100) * 60 + (o % 100);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  return Number.isFinite(ms) && month >= 1 && month <= 12 ? new Date(ms) : null;
}

export function createIowaSource(settings: CameraSourceSettings): CameraSource {
  return createArcGisSource(settings, (a) => {
    const stem = imageStem(a.ImageURL);
    // A site with several views (a rest area's CENTER, ENTRY and EXIT; a weather
    // station's seven) shares one `device_id`, so the picture's own file name is
    // the camera's id — and its suffix, `01-center`, tells the views apart.
    const view = stem?.includes('-') ? stem.slice(stem.indexOf('-') + 1) : null;
    return {
      sourceId: stem,
      name: typeof a.Desc_ === 'string' && view ? `${a.Desc_} (${view})` : a.Desc_,
      // RWIS are road weather stations: the picture is of the sky and the ground.
      kind: a.Type === 'RWIS' ? 'weather' : 'traffic',
      position: { latitude: numberOf(a.latitude), longitude: numberOf(a.longitude) },
      heading: null,
      roadName: a.Route === 'Unknown' ? null : (a.Route ?? null),
      media: { kind: 'snapshot', refreshSeconds: REFRESH_SECONDS, width: null, height: null },
      upstreamUrl: a.ImageURL,
      frameAt: iowaFrameAt(a.UpdateDate, a.UpdateTime, a.UTCoffset),
    };
  });
}
