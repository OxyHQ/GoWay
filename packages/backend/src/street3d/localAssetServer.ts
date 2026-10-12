/**
 * Serving the local scene directory (`STREET3D_SCENE_LOCAL_DIR`) the way the
 * scene CDN serves the bucket — for development only, behind
 * `bun run street3d:serve-assets`.
 *
 * What a viewer relies on from the CDN, it gets here too: CORS for any origin
 * (assets are fetched without credentials), byte ranges (Spark reads a RAD
 * header by range), the immutable cache policy and a content type from the
 * key's extension, as the bucket's object metadata would give. Nothing outside
 * the scene prefix is served, and nothing is ever written.
 */

import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { IMMUTABLE_CACHE_CONTROL } from './sceneAssetStore';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  rad: 'application/octet-stream',
  radc: 'application/octet-stream',
  spz: 'application/octet-stream',
  jpg: 'image/jpeg',
};

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges',
};

export interface LocalAssetServerOptions {
  /** The scene directory. */
  root: string;
  scenePrefix: string;
  /** The path of the public base URL, e.g. `/` or `/street3d/`. */
  basePath: string;
}

function answer(
  status: number,
  headers: Record<string, string> = {},
  body?: ConstructorParameters<typeof Response>[0],
): Response {
  return new Response(body ?? null, { status, headers: { ...CORS_HEADERS, ...headers } });
}

/** One request against the scene directory. */
export async function serveLocalAsset(
  options: LocalAssetServerOptions,
  request: Request,
): Promise<Response> {
  if (request.method === 'OPTIONS') return answer(204);
  if (request.method !== 'GET' && request.method !== 'HEAD') return answer(405);

  const root = resolve(options.root);
  const base = options.basePath.endsWith('/') ? options.basePath : `${options.basePath}/`;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return answer(400);
  }
  if (!pathname.startsWith(base)) return answer(404);
  const key = pathname.slice(base.length);
  const extension = key.slice(key.lastIndexOf('.') + 1);
  const contentType = CONTENT_TYPES[extension];
  if (!contentType || !key.startsWith(`${options.scenePrefix}/`) || key.split('/').includes('..'))
    return answer(404);
  const path = resolve(root, key);
  if (!path.startsWith(`${root}${sep}`)) return answer(404);
  const stats = await stat(path).catch(() => null);
  if (!stats?.isFile()) return answer(404);

  const headers = {
    'content-type': contentType,
    'cache-control': IMMUTABLE_CACHE_CONTROL,
    'accept-ranges': 'bytes',
  };
  const file = Bun.file(path);
  const range = request.headers.get('range');
  if (!range) {
    return answer(
      200,
      { ...headers, 'content-length': String(stats.size) },
      request.method === 'HEAD' ? undefined : file,
    );
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const size = stats.size;
  let start = match?.[1] ? Number(match[1]) : Number.NaN;
  let end = match?.[2] ? Number(match[2]) : size - 1;
  if (match && !match[1] && match[2]) {
    // A suffix range: the last N bytes.
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  if (!match || !Number.isFinite(start) || start >= size || end < start) {
    return answer(416, { 'content-range': `bytes */${size}` });
  }
  end = Math.min(end, size - 1);
  return answer(
    206,
    {
      ...headers,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
    },
    request.method === 'HEAD' ? undefined : file.slice(start, end + 1),
  );
}
