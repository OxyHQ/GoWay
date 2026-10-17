/**
 * Serve the native-3D phase 1 prototype's browser host
 * (`tsl-tile-preview.page.ts`) with one GoWay city tile read from a local
 * archive (`docs/MAP_NATIVE_3D.md` → "Phase 1: measured").
 *
 *   bun scripts/tsl-tile-preview.ts --archive=.tiles/city-barcelona-z15.pmtiles \
 *     [--tile=15/16580/12236] [--port=8790] [--write-tile=<file>]
 *   → http://localhost:8790/?backend=webgl   (or webgpu, appearance=dark)
 *
 * `--write-tile` also writes the tile's raw bytes, which is how the Android
 * host gets the identical input.
 */
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

import { decompress, PMTiles } from '@goway/map-service/pmtiles.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const archivePath = resolve(arg('archive', ''));
const [z, x, y] = arg('tile', '15/16580/12236').split('/').map(Number);
const port = Number(arg('port', '8790'));

const handle = await open(archivePath, 'r');
const archive = new PMTiles({
  async read(offset: number, length: number) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return new Uint8Array(buffer.subarray(0, bytesRead));
  },
});
const stored = await archive.getTile(z, x, y);
if (!stored) throw new Error(`no tile ${z}/${x}/${y} in ${archivePath}`);
const tile = new Uint8Array(await decompress(stored.bytes, stored.compression));
const writeTo = arg('write-tile', '');
if (writeTo) await Bun.write(writeTo, tile);

const built = await Bun.build({
  entrypoints: [resolve(import.meta.dir, 'tsl-tile-preview.page.ts')],
  target: 'browser',
  minify: false,
  define: { 'process.env.NODE_ENV': '"production"' },
});
if (!built.success) throw new AggregateError(built.logs, 'page build failed');
const script = await built.outputs[0].text();
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>City tile (TSL)</title><style>html,body{margin:0;height:100%;overflow:hidden}</style><script type="module">${script.replaceAll('</script', '<\\/script')}</script>`;

Bun.serve({
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/tile.mvt') {
      return new Response(tile, { headers: { 'content-type': 'application/x-protobuf' } });
    }
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});
console.log(`tile ${z}/${x}/${y} (${tile.byteLength} B) → http://localhost:${port}/?backend=webgl`);
