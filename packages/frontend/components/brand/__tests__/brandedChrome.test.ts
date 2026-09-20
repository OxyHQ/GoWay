/**
 * The brand survives a new route being written.
 *
 * `MapBrand` draws the GoWay logo on every map, and `BrandedChromeProvider`
 * lets a surface that already shows the logo in its own chrome stand it down.
 * That is one toggle, and the failure it must never produce is an UNBRANDED map
 * inside somebody else's page.
 *
 * None of this can be checked by rendering — there is no component test
 * renderer in this package — and none of it would be caught by types either: a
 * route that mounts `MapCanvas` without the provider compiles, and a route that
 * mounts the provider when it should not compiles too. So the assertions below
 * read the sources, in the spirit of `middleware/cors.test.ts` walking the real
 * routers rather than trusting a table.
 *
 * The load-bearing case is the LAST one. The first three would pass forever
 * while a third route rendered a map with neither the badge nor a logo in its
 * chrome; that one fails the moment such a route exists.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function read(path: string): string {
  return readFileSync(join(FRONTEND_ROOT, path), 'utf8');
}

/** Every `.tsx` under `app/` and `features/`, which is where a screen can live. */
function screenSources(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(FRONTEND_ROOT, directory))) {
      const rel = join(directory, entry);
      if (statSync(join(FRONTEND_ROOT, rel)).isDirectory()) {
        if (entry !== '__tests__' && entry !== 'node_modules') walk(rel);
      } else if (entry.endsWith('.tsx')) {
        found.push(rel);
      }
    }
  };
  walk('app');
  walk('features');
  return found;
}

describe('the embed', () => {
  it('does not stand the badge down', () => {
    // `app/frame.tsx` is the whole reason `MapBrand` exists. A logo inside
    // somebody else's page is the product being visible; without it GoWay is a
    // map nobody can attribute.
    expect(read('app/frame.tsx')).not.toContain('BrandedChromeProvider');
  });
});

describe('the app', () => {
  it('stands the badge down, because MapTopBar already carries the logo', () => {
    const explore = read('features/explore/ExploreScreen.tsx');
    expect(explore).toContain('<BrandedChromeProvider>');
    // The premise of standing it down. If the bar ever stops drawing the logo,
    // this screen has no brand at all and this test is where that is noticed.
    expect(read('features/explore/MapTopBar.tsx')).toContain('<GowayLogo');
  });

  it('draws the logo rather than the word', () => {
    // The bar used to render `t('map.title')` as text in a pill. The string
    // survives as the accessible label — a screen reader should hear the name —
    // but it must not be what a sighted user sees.
    const bar = read('features/explore/MapTopBar.tsx');
    expect(bar).toContain("label={t('map.title')}");
    expect(bar).not.toMatch(/<Text[^>]*>\s*\{t\('map\.title'\)\}/);
  });
});

describe('MapBrand', () => {
  it('honours the declaration', () => {
    const source = read('components/map/MapBrand.tsx');
    expect(source).toContain('useBrandedChrome');
    expect(source).toContain('if (chromeIsBranded) return null;');
  });

  it('has no prop that would let a screen switch it off', () => {
    // The distinction the design rests on: a SURFACE opts into being branded
    // already; a screen cannot ask for no brand. A props interface here would
    // be that second thing.
    expect(read('components/map/MapBrand.tsx')).not.toMatch(/interface MapBrandProps/);
  });
});

describe('every screen that renders a map', () => {
  it('either carries the brand in its chrome or lets the badge draw', () => {
    // The generalisation, and the only case that survives a file being added.
    // A screen that renders `MapCanvas` has exactly two honest options: mount
    // `BrandedChromeProvider` and show the logo in its own chrome, or mount
    // nothing and let `MapBrand` put it on the canvas. What it may not do is
    // mount the provider without drawing a logo, which is a map with no brand
    // anywhere — invisible in review, because nothing renders differently
    // except the thing that is missing.
    const offenders: string[] = [];
    for (const path of screenSources()) {
      const source = read(path);
      if (!source.includes('<MapCanvas')) continue;
      if (!source.includes('BrandedChromeProvider')) continue;
      if (!source.includes('MapTopBar') && !source.includes('GowayLogo')) {
        offenders.push(relative('.', path));
      }
    }
    expect(offenders).toEqual([]);
  });
});
