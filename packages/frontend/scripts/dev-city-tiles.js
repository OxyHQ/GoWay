/**
 * DEVELOPMENT ONLY: answer `/map/city/{z}/{x}/{y}.pbf` from a local city-tile
 * archive, so the city-3D layer's second source mode can be looked at before
 * any of it is hosted.
 *
 * Off unless `GOWAY_CITY_TILES_ARCHIVE` names one or more (comma-separated)
 * `.pmtiles` files built by `scripts/build-city-tiles.ts` — the first that has
 * a tile answers, so two cities can be looked at in one session. With it
 * unset `metro.config.js` gets its config back untouched, which is the case
 * for every export and every CI run.
 * It only ever runs inside the Metro dev server — an `expo export` serves
 * nothing — so it cannot reach production.
 *
 * It reads the archive with `worker/pmtiles.js`, the reader the production
 * Worker serves the basemap with and would serve these tiles with, and it
 * answers the way that Worker answers a tile: the stored gzip bytes with
 * `content-encoding: gzip`, and 204 for a tile the archive does not have. So
 * what the browser sees in development is what it will see from the edge.
 *
 * A side addition beside the Oxy preset (like `vendor-maplibre-worker.js`),
 * not a fork of it: it wraps whatever `server.enhanceMiddleware` the preset
 * set, if any.
 */
const { open } = require('node:fs/promises');
const path = require('node:path');

const TILE_PATH = /^\/map\/city\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.pbf$/;

function withDevCityTiles(config) {
  const archivePath = process.env.GOWAY_CITY_TILES_ARCHIVE;
  if (!archivePath) return config;
  const paths = archivePath.split(',').map((item) => path.resolve(item.trim()));

  let archivesPromise = null;
  const archives = () => {
    if (!archivesPromise) {
      archivesPromise = (async () => {
        const { PMTiles } = await import('../worker/pmtiles.js');
        return Promise.all(
          paths.map(async (file) => {
            const handle = await open(file, 'r');
            return new PMTiles({
              async read(offset, length) {
                const buffer = Buffer.alloc(length);
                const { bytesRead } = await handle.read(buffer, 0, length, offset);
                return new Uint8Array(buffer.subarray(0, bytesRead));
              },
            });
          }),
        );
      })();
    }
    return archivesPromise;
  };

  const tileAt = async (z, x, y) => {
    for (const archive of await archives()) {
      const tile = await archive.getTile(z, x, y);
      if (tile) return tile;
    }
    return null;
  };

  const previous = config.server?.enhanceMiddleware;
  console.log(`· city tiles: serving /map/city/{z}/{x}/{y}.pbf from ${paths.join(', ')}`);
  return {
    ...config,
    server: {
      ...config.server,
      enhanceMiddleware(middleware, server) {
        const inner = previous ? previous(middleware, server) : middleware;
        return (request, response, next) => {
          const match = TILE_PATH.exec((request.url || '').split('?')[0]);
          if (!match) return inner(request, response, next);
          const [z, x, y] = match.slice(1).map(Number);
          tileAt(z, x, y)
            .then((tile) => {
              const headers = {
                'access-control-allow-origin': '*',
                'cache-control': 'no-cache',
              };
              if (!tile) {
                response.writeHead(204, headers);
                response.end();
                return;
              }
              response.writeHead(200, {
                ...headers,
                'content-type': 'application/vnd.mapbox-vector-tile',
                'content-encoding': 'gzip',
                'content-length': tile.bytes.length,
              });
              response.end(Buffer.from(tile.bytes));
            })
            .catch((error) => {
              response.writeHead(500, { 'content-type': 'text/plain' });
              response.end(String(error));
            });
        };
      },
    },
  };
}

module.exports = { withDevCityTiles };
