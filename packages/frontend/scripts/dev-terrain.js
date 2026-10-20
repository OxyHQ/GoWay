/** Serve the production terrain adapter from Metro, with deployment configuration. */
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

function withDevTerrain(config) {
  const wrangler = readFileSync(resolve(__dirname, '../wrangler.toml'), 'utf8');
  const upstream =
    process.env.MAP_TERRAIN_UPSTREAM ??
    /^MAP_TERRAIN_UPSTREAM\s*=\s*"([^"]+)"/m.exec(wrangler)?.[1];
  const previous = config.server?.enhanceMiddleware;
  let adapter;
  return {
    ...config,
    server: {
      ...config.server,
      enhanceMiddleware(middleware, server) {
        const inner = previous ? previous(middleware, server) : middleware;
        return (request, response, next) => {
          const url = new URL(request.url || '/', 'http://metro.invalid');
          if (!url.pathname.startsWith('/map/terrain/')) return inner(request, response, next);
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' });
            response.end();
            return;
          }
          adapter ??= import('@goway/map-service/index.js');
          adapter
            .then(async ({ serveTerrain }) => {
              const result = await serveTerrain(
                url,
                new Request(url, { method: request.method }),
                { MAP_TERRAIN_UPSTREAM: upstream },
                { waitUntil() {} },
              );
              const headers = Object.fromEntries(result.headers);
              delete headers['content-encoding'];
              delete headers['content-length'];
              response.writeHead(result.status, headers);
              response.end(
                request.method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()),
              );
            })
            .catch(() => {
              if (!response.headersSent) response.writeHead(502);
              response.end();
            });
        };
      },
    },
  };
}
module.exports = { withDevTerrain };
