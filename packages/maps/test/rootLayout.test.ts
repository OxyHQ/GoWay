/**
 * A `MapView` given a `height` keeps it. `flex: 1` on the root is a zero flex
 * basis on both platforms, which overrides the caller's height: a 280-tall map
 * inside a scroll view rendered 0 tall (seen in Homiio's address pickers).
 * Read from the source, because the bug is a layout and no test renderer here
 * lays anything out.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(import.meta.dir, '..', 'src', path), 'utf8');

describe('MapView root layout', () => {
  for (const fork of ['MapView.web.tsx', 'MapView.tsx']) {
    it(`${fork} grows from its own size instead of a zero basis`, () => {
      const source = read(fork);
      expect(source).toContain("root: { flexGrow: 1, position: 'relative', overflow: 'hidden' }");
      expect(source).not.toMatch(/root: \{ flex: 1/);
    });
  }
});
