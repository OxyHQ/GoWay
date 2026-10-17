/**
 * The mark is on every map: `MapBrand` stands down only for a surface whose own
 * chrome declares it already carries the logo, and no prop lets a screen
 * switch it off. Read from the source, because a props interface that could
 * hide it would type-check and render nothing different until it was used.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(import.meta.dir, '..', 'src', path), 'utf8');

describe('MapBrand', () => {
  it('honours the declaration', () => {
    const source = read('MapBrand.tsx');
    expect(source).toContain('useBrandedChrome');
    expect(source).toContain('if (chromeIsBranded) return null;');
  });

  it('has no prop that would let a screen switch it off', () => {
    // The distinction the design rests on: a SURFACE opts into being branded
    // already; a screen cannot ask for no brand. A props interface here would
    // be that second thing.
    expect(read('MapBrand.tsx')).not.toMatch(/interface MapBrandProps/);
  });

  it('is drawn by both forks of MapView, unconditionally', () => {
    for (const fork of ['MapView.web.tsx', 'MapView.tsx']) {
      expect(read(fork)).toContain('      <MapBrand />');
    }
  });
});
