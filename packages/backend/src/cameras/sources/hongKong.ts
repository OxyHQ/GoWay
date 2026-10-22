/**
 * Hong Kong Transport Department's traffic snapshot cameras, published on
 * DATA.GOV.HK as one XML list: `<image>` with `key`, `description`,
 * `latitude`, `longitude` and `url` (a JPEG the department refreshes about
 * every two minutes). The list has no heading and no per-picture time.
 *
 * The description ends with the camera's own key in brackets
 * (`Aberdeen Praya Road near Fish Market [H429F]`), which is noise as a name.
 */

import { elements, tag } from '../../hub/xml';
import { getText, numberOf } from '../http';
import { accept } from '../normalise';
import type {
  CameraBatch,
  CameraFetchContext,
  CameraRecord,
  CameraSource,
  CameraSourceSettings,
} from '../types';

const REFRESH_SECONDS = 120;

export function createHongKongSource(settings: CameraSourceSettings): CameraSource {
  return {
    async read(context: CameraFetchContext): Promise<CameraBatch> {
      const xml = await getText(settings.url, context, { 'user-agent': settings.userAgent });
      const skipped: Record<string, number> = {};
      const entries = elements(xml, 'image');
      if (entries.length === 0) throw new Error('Hong Kong cameras: no <image> entries');
      const cameras: CameraRecord[] = [];
      for (const entry of entries) {
        const key = tag(entry, 'key');
        const camera = accept(
          {
            sourceId: key,
            name: (tag(entry, 'description') ?? '').replace(/\s*\[[^\]]*\]\s*$/, '') || null,
            kind: 'traffic',
            position: {
              latitude: numberOf(tag(entry, 'latitude')),
              longitude: numberOf(tag(entry, 'longitude')),
            },
            heading: null,
            roadName: null,
            media: { kind: 'snapshot', refreshSeconds: REFRESH_SECONDS, width: null, height: null },
            upstreamUrl: tag(entry, 'url'),
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
