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
 * It also answers `/map/city/coverage.json` — which areas the archives
 * cover — because a 204 inside them is empty ground and outside them is
 * "not compiled", and only coverage tells them apart (`lib/map/cityTiles.ts`).
 *
 * A REGIONAL archive (the planet build's, `scripts/build-city-region.ts`)
 * carries the tiles it owns in its metadata (`goway:ownership`); the route
 * then answers as the production Worker does (`worker/city.js`): a tile from
 * the first archive that owns it, 204 when that archive has nothing there,
 * and — when every building archive is regional — the production coverage
 * document, the union of their ownership at z14. To look at the production
 * Worker itself instead, see `docs/MAP_CITY_PLANET.md` → "Dry run".
 *
 * A side addition beside the Oxy preset (like `vendor-maplibre-worker.js`),
 * not a fork of it: it wraps whatever `server.enhanceMiddleware` the preset
 * set, if any.
 */
const { open } = require('node:fs/promises');
const path = require('node:path');

// `/map/city/…` answers from building archives, `/map/city-roads/…` from road
// archives (`scripts/build-city-roads.ts`); an archive says which it is in its
// `goway:kind` metadata, and one without the key is a building archive.
const TILE_PATH = /^\/map\/(city|city-roads)\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})\.pbf$/;
/** `CITY_COVERAGE_PATH` in `lib/map/cityTiles.ts` (this file is plain JS for Metro). */
const COVERAGE_PATH = '/map/city/coverage.json';

function withDevCityTiles(config) {
  const archivePath = process.env.GOWAY_CITY_TILES_ARCHIVE;
  if (!archivePath) return config;
  const paths = archivePath.split(',').map((item) => path.resolve(item.trim()));

  let archivesPromise = null;
  let trees = null;
  const archives = () => {
    if (!archivesPromise) {
      archivesPromise = (async () => {
        const { PMTiles } = await import('../worker/pmtiles.js');
        trees = await import('../worker/coverageTree.js');
        return Promise.all(
          paths.map(async (file) => {
            const handle = await open(file, 'r');
            const archive = new PMTiles({
              async read(offset, length) {
                const buffer = Buffer.alloc(length);
                const { bytesRead } = await handle.read(buffer, 0, length, offset);
                return new Uint8Array(buffer.subarray(0, bytesRead));
              },
            });
            const metadata = await archive.metadata().catch(() => ({}));
            const kind = metadata?.['goway:kind'] === 'roads' ? 'city-roads' : 'city';
            const ownership = metadata?.['goway:ownership'];
            const tree = ownership ? trees.decodeCoverageTree(ownership) : null;
            return { archive, kind, tree, ownership };
          }),
        );
      })();
    }
    return archivesPromise;
  };

  const tileAt = async (kind, z, x, y) => {
    for (const entry of await archives()) {
      if (entry.kind !== kind) continue;
      if (entry.tree) {
        // A regional archive answers exactly the tiles it owns, empty or not.
        const owned = trees.coverageAt(entry.tree, entry.ownership.maxZoom, z, x, y) === trees.FULL;
        if (!owned) continue;
        return entry.archive.getTile(z, x, y);
      }
      const tile = await entry.archive.getTile(z, x, y);
      if (tile) return tile;
    }
    return null;
  };

  /** Every building archive regional: the production document (`worker/city.js`). */
  const regionalCoverage = (list) => {
    const buildings = list.filter((entry) => entry.kind === 'city');
    if (buildings.length === 0 || !buildings.every((entry) => entry.tree)) return null;
    let union = trees.EMPTY;
    for (const entry of buildings) union = trees.unionCoverageTrees(union, entry.tree);
    const encoded = trees.encodeCoverageTree(trees.coarsenCoverageTree(union, 14), 14);
    return { schema: 2, tiles: { maxZoom: 14, bits: encoded.bits }, regions: [] };
  };

  const previous = config.server?.enhanceMiddleware;
  console.log(`· city tiles: serving /map/city{,-roads}/{z}/{x}/{y}.pbf from ${paths.join(', ')}`);
  return {
    ...config,
    server: {
      ...config.server,
      enhanceMiddleware(middleware, server) {
        const inner = previous ? previous(middleware, server) : middleware;
        return (request, response, next) => {
          const url = (request.url || '').split('?')[0];
          if (url === COVERAGE_PATH) {
            // What each archive covers: its compile box (`goway:coverage` in
            // its metadata), else its tiles' extent from the header.
            archives()
              .then(
                (list) =>
                  regionalCoverage(list) ??
                  Promise.all(
                    // Building archives only: road archives are not 3D coverage.
                    list
                      .filter((entry) => entry.kind === 'city')
                      .map(async ({ archive }) => {
                        const metadata = await archive.metadata().catch(() => ({}));
                        const coverage =
                          metadata['goway:coverage'] ?? (await archive.header()).bounds;
                        return { coverage };
                      }),
                  ),
              )
              .then((covered) => {
                response.writeHead(200, {
                  'access-control-allow-origin': '*',
                  'cache-control': 'no-cache',
                  'content-type': 'application/json',
                });
                response.end(
                  JSON.stringify(Array.isArray(covered) ? { archives: covered } : covered),
                );
              })
              .catch((error) => {
                response.writeHead(500, { 'content-type': 'text/plain' });
                response.end(String(error));
              });
            return;
          }
          const match = TILE_PATH.exec(url);
          if (!match) return inner(request, response, next);
          const [z, x, y] = match.slice(2).map(Number);
          tileAt(match[1], z, x, y)
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
