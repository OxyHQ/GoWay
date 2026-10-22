/**
 * Each source against a trimmed copy of the real feed (`fixtures/`, saved from
 * the live endpoints on 2026-10-22), with a fake `fetch`: what it keeps, what
 * it refuses and counts, and what makes a read incomplete.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArcGisSource } from '../sources/arcgis';
import { createDigitrafficSource } from '../sources/digitraffic';
import { createHongKongSource } from '../sources/hongKong';
import { createIowaSource, iowaFrameAt } from '../sources/iowa';
import { createTorontoSource, unwrapJsonp } from '../sources/toronto';
import type { CameraFetchContext, CameraSourceSettings } from '../types';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const settings = (url: string): CameraSourceSettings => ({ url, userAgent: 'GoWay-test/1.0' });

function context(respond: (url: string, headers: Record<string, string>) => Response): {
  context: CameraFetchContext;
  calls: { url: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    context: {
      fetch: async (url: string | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(url), headers });
        return respond(String(url), headers);
      },
      signal: new AbortController().signal,
      now: () => new Date('2026-10-22T13:30:00Z'),
    },
  };
}

describe('Digitraffic', () => {
  const url = 'https://tie.digitraffic.fi/api/weathercam/v1/stations';
  const respond = (u: string) =>
    new Response(
      fixture(u.endsWith('/data') ? 'digitraffic-data.json' : 'digitraffic-stations.json'),
    );

  it('makes one camera per collecting preset, with its picture and the time it was taken', async () => {
    const { context: ctx, calls } = context(respond);
    const batch = await createDigitrafficSource(settings(url)).read(ctx);
    expect(batch.complete).toBe(true);
    expect(batch.failures).toEqual([]);
    expect(batch.skipped).toEqual({ 'not-collecting': 1 });
    const first = batch.cameras[0];
    expect(first).toEqual({
      sourceId: 'C0150301',
      name: 'kt51 Inkoo (01)',
      kind: 'traffic',
      position: { latitude: 60.05374, longitude: 23.99616 },
      heading: null,
      roadName: null,
      media: { kind: 'snapshot', refreshSeconds: 600, width: null, height: null },
      upstreamUrl: 'https://weathercam.digitraffic.fi/C0150301.jpg',
      frameAt: new Date('2026-10-22T13:18:10Z'),
    });
    expect(batch.cameras.map((c) => c.sourceId)).toEqual(
      expect.arrayContaining(['C0150301', 'C0150302', 'C0150309']),
    );
    // Fintraffic asks every client to say who it is.
    expect(calls.every((c) => c.headers['Digitraffic-User'] === 'GoWay-test/1.0')).toBe(true);
  });

  it('still reads the catalogue when the frame times fail, but says so and stays incomplete-safe', async () => {
    const { context: ctx } = context((u) =>
      u.endsWith('/data') ? new Response('', { status: 500 }) : respond(u),
    );
    const batch = await createDigitrafficSource(settings(url)).read(ctx);
    expect(batch.cameras.length).toBeGreaterThan(0);
    expect(batch.cameras.every((c) => c.frameAt === null)).toBe(true);
    expect(batch.failures).toHaveLength(1);
  });

  it('throws when the catalogue itself fails, so nothing is written or retired', async () => {
    const { context: ctx } = context(() => new Response('', { status: 503 }));
    await expect(createDigitrafficSource(settings(url)).read(ctx)).rejects.toThrow('503');
  });
});

describe('Hong Kong', () => {
  it('reads the XML list, without the key the description repeats', async () => {
    const { context: ctx } = context(() => new Response(fixture('hongkong.xml')));
    const batch = await createHongKongSource(settings('https://static.data.gov.hk/x.xml')).read(
      ctx,
    );
    expect(batch.cameras).toHaveLength(4);
    expect(batch.skipped).toEqual({});
    expect(batch.cameras[0]).toEqual({
      sourceId: 'H429F',
      name: 'Aberdeen Praya Road near Fish Market',
      kind: 'traffic',
      position: { latitude: 22.24845, longitude: 114.1505 },
      heading: null,
      roadName: null,
      media: { kind: 'snapshot', refreshSeconds: 120, width: null, height: null },
      upstreamUrl: 'https://tdcctv.data.one.gov.hk/H429F.JPG',
      frameAt: null,
    });
  });

  it('refuses entries without a position or picture, counting them, and a document with none', async () => {
    const xml = `<image-list>
      <image><key>A1</key><description>No coordinates [A1]</description><url>https://x.example/a.jpg</url></image>
      <image><key>B2</key><description>No picture [B2]</description><latitude>22.3</latitude><longitude>114.1</longitude></image>
      <image><key>C3</key><description>Null island [C3]</description><latitude>0</latitude><longitude>0</longitude><url>https://x.example/c.jpg</url></image>
      <image><key>D4</key><description>Fine [D4]</description><latitude>22.3</latitude><longitude>114.1</longitude><url>https://x.example/d.jpg</url></image>
    </image-list>`;
    const { context: ctx } = context(() => new Response(xml));
    const batch = await createHongKongSource(settings('https://x.example/l.xml')).read(ctx);
    expect(batch.cameras.map((c) => c.sourceId)).toEqual(['D4']);
    expect(Object.values(batch.skipped).reduce((a, b) => a + b, 0)).toBe(3);
    const empty = context(() => new Response('<image-list/>'));
    await expect(
      createHongKongSource(settings('https://x.example/l.xml')).read(empty.context),
    ).rejects.toThrow('no <image>');
  });
});

describe('Toronto', () => {
  it('unwraps the JSONP and derives each location’s picture', async () => {
    const { context: ctx } = context(() => new Response(fixture('toronto.jsonp')));
    const batch = await createTorontoSource(settings('https://opendata.toronto.ca/x.json')).read(
      ctx,
    );
    expect(batch.cameras).toHaveLength(4);
    expect(batch.cameras[0]).toEqual({
      sourceId: '8001',
      name: 'YORK ST & BREMNER BLVD / RAPTORS WAY',
      kind: 'traffic',
      position: { latitude: 43.64312, longitude: -79.381386 },
      heading: null,
      roadName: null,
      media: { kind: 'snapshot', refreshSeconds: 1500, width: null, height: null },
      upstreamUrl:
        'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg',
      frameAt: null,
    });
  });

  it('refuses what is not JSONP', async () => {
    expect(() => unwrapJsonp('<html>')).toThrow('not a JSONP');
    expect(unwrapJsonp('cb({"Data":[]});')).toEqual({ Data: [] });
  });
});

describe('Iowa and the ArcGIS reader', () => {
  const url =
    'https://services.arcgis.com/x/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query';
  const page = (exceeded: boolean) =>
    JSON.stringify({ ...JSON.parse(fixture('iowa.json')), exceededTransferLimit: exceeded });
  /** The layer's own metadata (`…/FeatureServer/0?f=json`), which Iowa's layer answers with `FID`. */
  const isMetadata = (u: string) => !new URL(u).pathname.endsWith('/query');
  const layer = JSON.stringify({ objectIdField: 'FID' });
  const answer = (rows: (u: string) => Response) => (u: string) =>
    isMetadata(u) ? new Response(layer) : rows(u);

  it('maps a feature to a camera, with the time its three integers say', async () => {
    const { context: ctx, calls } = context(answer(() => new Response(page(false))));
    const batch = await createIowaSource(settings(url)).read(ctx);
    expect(batch.complete).toBe(true);
    expect(batch.cameras).toHaveLength(3);
    expect(batch.cameras[0]).toMatchObject({
      sourceId: 'wwdtv06hd',
      name: 'WWD - US 30 # MM 135.5 (Quill Ave.)',
      roadName: null, // the layer says "Unknown"
      upstreamUrl: 'https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/Metro/wwdtv06hd.jpeg',
      frameAt: new Date('2026-10-20T12:28:45Z'), // 07:28:45 at UTC-05:00
    });
    const query = new URL(calls.find((c) => c.url.includes('/query'))?.url ?? '').searchParams;
    expect(query.get('f')).toBe('json');
    expect(query.get('outSR')).toBe('4326');
    // The layer's own id field orders the pages, not a guessed `OBJECTID`.
    expect(query.get('orderByFields')).toBe('FID');
  });

  it('pages until the server stops saying it cut the answer off', async () => {
    const { context: ctx, calls } = context(
      answer((u) => new Response(page(Number(new URL(u).searchParams.get('resultOffset')) < 1000))),
    );
    const batch = await createIowaSource(settings(url)).read(ctx);
    const offsets = calls
      .filter((c) => c.url.includes('/query'))
      .map((c) => new URL(c.url).searchParams.get('resultOffset'));
    expect(offsets).toEqual(['0', '1000']);
    expect(batch.complete).toBe(true);
    expect(batch.cameras).toHaveLength(6);
  });

  it('is INCOMPLETE when a later page fails, keeping what it read', async () => {
    const { context: ctx } = context(
      answer((u) =>
        new URL(u).searchParams.get('resultOffset') === '0'
          ? new Response(page(true))
          : new Response('', { status: 502 }),
      ),
    );
    const batch = await createIowaSource(settings(url)).read(ctx);
    expect(batch.complete).toBe(false);
    expect(batch.cameras).toHaveLength(3);
    expect(batch.failures[0]).toContain('page 1');
  });

  it('is INCOMPLETE when the server never stops, and throws when the first page fails or the layer errors', async () => {
    const endless = context(answer(() => new Response(page(true))));
    const batch = await createIowaSource(settings(url)).read(endless.context);
    expect(batch.complete).toBe(false);
    expect(batch.failures.join()).toContain('pages');
    const down = context(answer(() => new Response('', { status: 500 })));
    await expect(createIowaSource(settings(url)).read(down.context)).rejects.toThrow('500');
    const refused = context(answer(() => new Response(JSON.stringify({ error: { code: 400 } }))));
    await expect(
      createArcGisSource(settings(url), () => null).read(refused.context),
    ).rejects.toThrow('ArcGIS layer');
  });

  it('pages in the server’s default order when the layer will not describe itself', async () => {
    const { context: ctx, calls } = context((u) =>
      isMetadata(u) ? new Response('', { status: 500 }) : new Response(page(false)),
    );
    const batch = await createIowaSource(settings(url)).read(ctx);
    expect(batch.complete).toBe(true);
    const query = new URL(calls.find((c) => c.url.includes('/query'))?.url ?? '').searchParams;
    expect(query.has('orderByFields')).toBe(false);
  });

  it('names a camera by its picture, so a site with several views is several cameras', async () => {
    const rows = [
      [
        'Rest Area: I-35 SB MM 98',
        'https://x.example/RestAreas/RA35SB98-01-CENTER.jpg',
        'Rest Area/Parking',
      ],
      [
        'Rest Area: I-35 SB MM 98',
        'https://x.example/RestAreas/RA35SB98-01-ENTRY.jpg',
        'Rest Area/Parking',
      ],
      ['RWIS - US 59 @ Denison', 'https://x.example/RWIS/RWIS_60-00.jpg', 'RWIS'],
    ].map(([Desc_, ImageURL, Type]) => ({
      attributes: { device_id: 59644034, Desc_, ImageURL, Type, latitude: 41.8, longitude: -93.5 },
    }));
    const { context: ctx } = context(
      answer(() => new Response(JSON.stringify({ features: rows }))),
    );
    const batch = await createIowaSource(settings(url)).read(ctx);
    expect(batch.cameras.map((c) => [c.sourceId, c.name, c.kind])).toEqual([
      ['ra35sb98-01-center', 'Rest Area: I-35 SB MM 98 (01-center)', 'traffic'],
      ['ra35sb98-01-entry', 'Rest Area: I-35 SB MM 98 (01-entry)', 'traffic'],
      ['rwis_60-00', 'RWIS - US 59 @ Denison (00)', 'weather'],
    ]);
    expect(batch.skipped).toEqual({});
  });

  it('turns Iowa’s three integers into an instant, or null', () => {
    expect(iowaFrameAt(20261022, 64148, -500)?.toISOString()).toBe('2026-10-22T11:41:48.000Z');
    expect(iowaFrameAt(20261022, 235959, 0)?.toISOString()).toBe('2026-10-22T23:59:59.000Z');
    expect(iowaFrameAt(null, 64148, -500)).toBeNull();
    expect(iowaFrameAt(20261322, 64148, -500)).toBeNull(); // month 13
  });
});
