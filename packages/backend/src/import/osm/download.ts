/**
 * Fetching an OpenStreetMap extract, resumably, from inside the container that
 * is going to read it.
 *
 * ## Why the task fetches its own input
 *
 * `oxy-postgres` is not publicly reachable, so the import runs inside the VPC
 * as a one-shot ECS task. Everything else — an S3 staging bucket, an EFS
 * mount, a pre-built artefact — adds a second place for the same 1.5 GB to live
 * and to go stale, and the task role has no S3 grant today. One task that
 * fetches, reads and writes has one input and no intermediate.
 *
 * ## The failure this file is shaped by
 *
 * Issue #60: a long download that fails partway and is retried can rewrite the
 * file from byte 0, and if the retry is what exits 0, the caller sees a
 * success over a file that is shorter than it was. So:
 *
 *  - a partial file is RESUMED with a `Range` header, never restarted;
 *  - the server's `206` is required for a resume — a `200` means it ignored
 *    the range and is about to overwrite from the beginning, which is refused
 *    rather than accepted;
 *  - the final size is asserted against `Content-Length`, and a file that
 *    SHRANK between attempts fails loudly.
 *
 * The runtime image is `oven/bun:1.4.2-alpine` and has no `curl`, which is why
 * this is `fetch` and a stream rather than a shell-out to the downloader
 * `packages/frontend/scripts/build-map-tiles.ts` uses. That script is a build
 * tool on a workstation; this runs in a 512 MB container with busybox.
 */

import { createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname } from 'node:path';

/** Where Geofabrik publishes its regional extracts. */
const GEOFABRIK = 'https://download.geofabrik.de';

/** How many times a stalled or broken transfer is resumed before giving up. */
const MAX_ATTEMPTS = 8;

/** The URL for a Geofabrik region path such as `europe/spain`. */
export function geofabrikUrl(region: string): string {
  const path = region.replace(/^\/+|\/+$/g, '');
  if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(path)) {
    throw new Error(
      `Region ${JSON.stringify(region)} is not a Geofabrik path. Use e.g. europe/spain.`,
    );
  }
  return `${GEOFABRIK}/${path}-latest.osm.pbf`;
}

/** What the download did, for the log line. */
export interface DownloadResult {
  path: string;
  bytes: number;
  /** True when the file was already complete and nothing was transferred. */
  reused: boolean;
  milliseconds: number;
}

/** The size the server says the whole resource is, or `null` if it will not say. */
async function contentLength(url: string): Promise<number | null> {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (!response.ok) return null;
  const header = response.headers.get('content-length');
  if (header === null) return null;
  const size = Number(header);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/** Bytes already on disk at `path`, or 0. */
async function existingSize(path: string): Promise<number> {
  try {
    const stat = await fs.stat(path);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Download `url` to `path`, resuming an interrupted attempt.
 *
 * Returns without transferring anything when the file is already the size the
 * server reports — which is what makes a retried ECS task cheap instead of
 * another 1.5 GB.
 */
export async function downloadExtract(
  url: string,
  path: string,
  log: (message: string, detail?: Record<string, unknown>) => void = () => {},
): Promise<DownloadResult> {
  const started = Date.now();
  await fs.mkdir(dirname(path), { recursive: true });

  const expected = await contentLength(url);
  let have = await existingSize(path);
  if (expected !== null && have === expected) {
    return { path, bytes: have, reused: true, milliseconds: Date.now() - started };
  }
  if (expected !== null && have > expected) {
    throw new Error(
      `${path} is ${have} bytes and the server says the extract is ${expected}. ` +
        'Refusing to guess which is right — delete it and re-run.',
    );
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const from = have;
    const headers: Record<string, string> = {};
    if (from > 0) headers.Range = `bytes=${from}-`;

    log('Fetching extract', { url, attempt, from });
    const response = await fetch(url, { headers, redirect: 'follow' });

    if (from > 0 && response.status !== 206) {
      // A 200 here means the server ignored the range and is about to hand us
      // the whole file from byte 0 — which is exactly how a resume turns into a
      // truncation. See the file docblock.
      throw new Error(
        `Resume from byte ${from} was answered with ${response.status}, not 206. ` +
          'The server does not support ranges; delete the partial file and re-run.',
      );
    }
    if (!response.ok || !response.body) {
      throw new Error(`Fetching ${url} failed with ${response.status} ${response.statusText}.`);
    }

    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(path, { flags: from > 0 ? 'a' : 'w' }),
      );
    } catch (error) {
      const now = await existingSize(path);
      if (now < have) {
        throw new Error(
          `${path} shrank from ${have} to ${now} bytes during a resume. Refusing to continue.`,
        );
      }
      have = now;
      if (attempt === MAX_ATTEMPTS) throw error;
      log('Transfer interrupted; resuming', { have, attempt });
      continue;
    }

    have = await existingSize(path);
    if (expected === null || have === expected) {
      return { path, bytes: have, reused: false, milliseconds: Date.now() - started };
    }
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`${path} is ${have} bytes; the server said ${expected}.`);
    }
    log('Short transfer; resuming', { have, expected, attempt });
  }

  throw new Error(`Gave up fetching ${url} after ${MAX_ATTEMPTS} attempts.`);
}
