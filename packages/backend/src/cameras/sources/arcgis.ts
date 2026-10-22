/**
 * ArcGIS FeatureServer layers: the standard many state and city agencies
 * publish their cameras through. One source reads any such layer — it pages
 * `…/FeatureServer/0/query` until the server stops saying it was cut off — and
 * the provider supplies the one thing that differs, how a feature's attributes
 * become a camera ({@link ArcGisMapper}).
 *
 * A page that errors, or a server that keeps saying `exceededTransferLimit`
 * past {@link MAX_PAGES}, makes the read INCOMPLETE: what was read is written,
 * and nothing is retired on the strength of it.
 */

import { getJson, record } from '../http';
import { accept } from '../normalise';
import type {
  CameraBatch,
  CameraFetchContext,
  CameraRecord,
  CameraSource,
  CameraSourceSettings,
} from '../types';

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

/** One feature's attributes and point geometry → a candidate camera (before `accept`), or `null` to skip it. */
export type ArcGisMapper = (
  attributes: Record<string, unknown>,
  geometry: Record<string, unknown> | null,
) => unknown;

/**
 * The layer's object-id field (`OBJECTID`, `FID`…), which a stable page order
 * needs and which differs between layers. From the layer's own metadata; a
 * layer that will not say is paged in the server's default order.
 */
async function objectIdField(
  settings: CameraSourceSettings,
  context: CameraFetchContext,
): Promise<string | null> {
  try {
    const layer = record(
      await getJson(`${settings.url.replace(/\/query\/?$/, '')}?f=json`, context, {
        'user-agent': settings.userAgent,
      }),
    );
    const name = layer?.objectIdField;
    return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function createArcGisSource(
  settings: CameraSourceSettings,
  map: ArcGisMapper,
): CameraSource {
  return {
    async read(context: CameraFetchContext): Promise<CameraBatch> {
      const skipped: Record<string, number> = {};
      const failures: string[] = [];
      const cameras: CameraRecord[] = [];
      let complete = false;
      const orderBy = await objectIdField(settings, context);
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(settings.url);
        url.search = new URLSearchParams({
          where: '1=1',
          outFields: '*',
          f: 'json',
          outSR: '4326',
          ...(orderBy ? { orderByFields: orderBy } : {}),
          resultOffset: String(page * PAGE_SIZE),
          resultRecordCount: String(PAGE_SIZE),
        }).toString();
        let body: Record<string, unknown> | null;
        try {
          body = record(
            await getJson(url.toString(), context, { 'user-agent': settings.userAgent }),
          );
        } catch (error) {
          if (page === 0) throw error;
          failures.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        if (!body) {
          if (page === 0) throw new Error('ArcGIS layer: not an object');
          failures.push(`page ${page}: not an object`);
          break;
        }
        if (body.error) {
          if (page === 0)
            throw new Error(`ArcGIS layer: ${JSON.stringify(body.error).slice(0, 200)}`);
          failures.push(`page ${page}: layer error`);
          break;
        }
        const features = body.features;
        if (!Array.isArray(features)) throw new Error('ArcGIS layer: no features');
        for (const feature of features) {
          const attributes = record(record(feature)?.attributes);
          if (!attributes) continue;
          const candidate = map(attributes, record(record(feature)?.geometry));
          const camera = accept(candidate, skipped);
          if (camera) cameras.push(camera);
        }
        if (body.exceededTransferLimit !== true) {
          complete = true;
          break;
        }
      }
      if (!complete && failures.length === 0) failures.push(`more than ${MAX_PAGES} pages`);
      return { cameras, complete, skipped, failures };
    },
  };
}
