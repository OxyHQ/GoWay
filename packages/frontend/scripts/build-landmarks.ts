/**
 * Builds the landmark GLBs from their generators and keeps
 * `public/landmarks/registry.json` true to them (`docs/MAP_LANDMARKS.md`).
 *
 *   bun scripts/build-landmarks.ts               build every generated landmark
 *   bun scripts/build-landmarks.ts --only=<id>   one landmark
 *   bun scripts/build-landmarks.ts --check       fail if a committed GLB or the registry drifted
 *
 * For each registry entry with a `model.generator`, this runs the generator
 * (`scripts/landmarks/models/`), writes `public/landmarks/<id>.glb`, and
 * writes the asset's measured facts — bytes, SHA-256, triangles, bounds —
 * back into the entry. The registry is then validated by the same schema the
 * app parses it with (`lib/map/landmarks/registry.ts`) and written in one
 * canonical layout, which is why the file is excluded from Biome: its bytes
 * are this script's, and `--check` compares them.
 *
 * Budgets are enforced here, before anything is committed: a landmark over
 * {@link MAX_LANDMARK_BYTES} or {@link MAX_LANDMARK_TRIANGLES} fails the build.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLandmarkRegistry } from '../lib/map/landmarks/registry';
import { writeLandmarkGlb } from './landmarks/glb';
import { Builder } from './landmarks/kit';
import { LANDMARK_MODELS } from './landmarks/models';

/** Per-landmark download budget. The model layer refuses anything over 2 MB; landmarks aim at half. */
export const MAX_LANDMARK_BYTES = 1024 * 1024;
/** Per-landmark triangle budget (the model layer's own cap). */
export const MAX_LANDMARK_TRIANGLES = 50_000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY_PATH = join(ROOT, 'public', 'landmarks', 'registry.json');

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * The registry's one layout: objects one key per line, arrays of scalars on
 * one line (so a `replaces` list or a bounds triple reads as a row).
 */
export function canonicalJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    }
    const inner = `${indent}  `;
    return `[\n${value.map((v) => inner + canonicalJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const inner = `${indent}  `;
    const entries = Object.entries(value).map(
      ([k, v]) => `${inner}${JSON.stringify(k)}: ${canonicalJson(v, inner)}`,
    );
    return entries.length ? `{\n${entries.join(',\n')}\n${indent}}` : '{}';
  }
  return JSON.stringify(value);
}

interface Built {
  id: string;
  bytes: Uint8Array;
}

/** Build every generated landmark (or `only`), returning the new registry text and the GLBs. */
export async function buildLandmarks(only?: string): Promise<{ registry: string; built: Built[] }> {
  const raw = JSON.parse(await readFile(REGISTRY_PATH, 'utf8')) as {
    version: number;
    landmarks: Array<Record<string, unknown> & { id: string; model: Record<string, unknown> }>;
  };
  const built: Built[] = [];
  for (const entry of raw.landmarks) {
    if (!entry.model.generator) continue;
    const model = LANDMARK_MODELS[entry.id];
    if (!model) throw new Error(`${entry.id}: no generator in scripts/landmarks/models`);
    if (only && entry.id !== only) continue;
    const builder = new Builder(new Set(Object.keys(model.materials)));
    model.build(builder);
    const night = entry.night as {
      uplight: { color: string; reach: number; strength: number } | null;
    };
    const licence = entry.licence as { spdx: string };
    const glb = await writeLandmarkGlb(builder, model.materials, {
      id: entry.id,
      source: String(entry.model.generator),
      licence: licence.spdx,
      uplight: night?.uplight ?? undefined,
    });
    if (glb.bytes.length > MAX_LANDMARK_BYTES) {
      throw new Error(`${entry.id}: ${glb.bytes.length} bytes is over ${MAX_LANDMARK_BYTES}`);
    }
    if (glb.triangles > MAX_LANDMARK_TRIANGLES) {
      throw new Error(`${entry.id}: ${glb.triangles} triangles is over ${MAX_LANDMARK_TRIANGLES}`);
    }
    entry.model = {
      path: `/landmarks/${entry.id}.glb`,
      generator: entry.model.generator,
      bytes: glb.bytes.length,
      sha256: createHash('sha256').update(glb.bytes).digest('hex'),
      triangles: glb.triangles,
      boundsMeters: { min: glb.bounds.min.map(round), max: glb.bounds.max.map(round) },
    };
    built.push({ id: entry.id, bytes: glb.bytes });
  }
  parseLandmarkRegistry(raw);
  return { registry: `${canonicalJson(raw)}\n`, built };
}

if (import.meta.main) {
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  const check = process.argv.includes('--check');
  const { registry, built } = await buildLandmarks(only);
  if (check) {
    const problems: string[] = [];
    if ((await readFile(REGISTRY_PATH, 'utf8')) !== registry) {
      problems.push('public/landmarks/registry.json');
    }
    for (const { id, bytes } of built) {
      const path = join(ROOT, 'public', 'landmarks', `${id}.glb`);
      const committed = new Uint8Array(await readFile(path).catch(() => Buffer.alloc(0)));
      if (committed.length !== bytes.length || !committed.every((b, i) => b === bytes[i])) {
        problems.push(`public/landmarks/${id}.glb`);
      }
    }
    if (problems.length > 0) {
      console.error(`stale: ${problems.join(', ')} — run \`bun scripts/build-landmarks.ts\`.`);
      process.exit(1);
    }
    console.log(`landmarks up to date (${built.length} models).`);
  } else {
    for (const { id, bytes } of built) {
      await writeFile(join(ROOT, 'public', 'landmarks', `${id}.glb`), bytes);
      console.log(`wrote public/landmarks/${id}.glb (${(bytes.length / 1024).toFixed(0)} kB)`);
    }
    // `--only` is the modelling loop: it writes that GLB and leaves the
    // registry alone (run the full build before committing).
    if (!only) await writeFile(REGISTRY_PATH, registry);
  }
}
