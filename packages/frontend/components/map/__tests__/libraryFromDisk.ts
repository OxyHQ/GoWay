/**
 * The model library as the app would load it, read from `public/` instead of
 * fetched — for tests (`modelLibrary.test.ts`, `features/live/__tests__/fleets.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MODEL_LIBRARY_PATH, type ModelLibrary, parseModelLibrary } from '@/lib/map/modelLibrary';

import { type LibraryModel, parseLibraryModel } from '../engine/vehicles/library';

export const LIBRARY_DIR = join(import.meta.dir, '..', '..', '..', 'public', MODEL_LIBRARY_PATH);

export function readManifest(): ModelLibrary {
  return parseModelLibrary(JSON.parse(readFileSync(join(LIBRARY_DIR, 'manifest.json'), 'utf8')));
}

export async function readLibrary(keys?: readonly string[]): Promise<Map<string, LibraryModel>> {
  const manifest = readManifest();
  const out = new Map<string, LibraryModel>();
  for (const entry of manifest.models) {
    if (keys && !keys.includes(entry.key)) continue;
    const bytes = readFileSync(join(LIBRARY_DIR, entry.file));
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    out.set(entry.key, await parseLibraryModel(entry, buffer));
  }
  return out;
}
