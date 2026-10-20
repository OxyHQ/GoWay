/**
 * The map loads nothing of GoWay's SDK but its two renderer entries:
 * `@goway.to/sdk/map` (style names, the tile schema, label language) and
 * `@goway.to/sdk/geo` (geometry). The root entry is the HTTP client and
 * GoWay's whole contract in zod; importing a value from it put several hundred
 * kilobytes into every app's bundle (Homiio's web bundle went over its budget).
 * Type-only imports are erased and stay allowed.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('imports from @goway.to/sdk', () => {
  it('takes values only from /map and /geo', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /^import\s+(type\s+)?[^;]*?from\s+'(@goway\.to\/sdk[^']*)';/gms,
      )) {
        const [, typeOnly, specifier] = match;
        if (typeOnly) continue;
        if (specifier !== '@goway.to/sdk/map' && specifier !== '@goway.to/sdk/geo') {
          offenders.push(`${file.slice(SRC.length + 1)}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
