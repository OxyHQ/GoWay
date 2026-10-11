/**
 * The city sky is off unless a build or a DEVELOPMENT tab asks for it, and
 * never without the city-3D layer that draws it.
 */
import { describe, expect, test } from 'bun:test';

import {
  CITY_SKY_MAX_PITCH,
  DEFAULT_MAX_PITCH,
  isCitySkyRequested,
  maxPitchFor,
} from '@/lib/map/citySkyFlag';

const off = { city3d: true, enabled: false, development: false, search: '' };

describe('isCitySkyRequested', () => {
  test('off by default, in development and production alike', () => {
    expect(isCitySkyRequested(off)).toBe(false);
    expect(isCitySkyRequested({ ...off, development: true })).toBe(false);
  });

  test('the build flag turns it on — with the city layer', () => {
    expect(isCitySkyRequested({ ...off, enabled: true })).toBe(true);
    expect(isCitySkyRequested({ ...off, enabled: true, city3d: false })).toBe(false);
  });

  test('the query parameter works in development only, and only with the city layer', () => {
    expect(isCitySkyRequested({ ...off, development: true, search: '?citysky=1' })).toBe(true);
    expect(isCitySkyRequested({ ...off, development: true, search: '?a=b&citysky=true' })).toBe(
      true,
    );
    expect(isCitySkyRequested({ ...off, search: '?citysky=1' })).toBe(false);
    expect(
      isCitySkyRequested({ ...off, city3d: false, development: true, search: '?citysky=1' }),
    ).toBe(false);
  });

  test('anything but 1/true is not a yes', () => {
    for (const search of ['?citysky=0', '?citysky', '?xcitysky=1', '?city3d=1']) {
      expect(isCitySkyRequested({ ...off, development: true, search })).toBe(false);
    }
  });
});

describe('maxPitchFor', () => {
  test('the sky raises the ceiling only while it is drawn, and only where tilting is allowed', () => {
    expect(maxPitchFor({ pitchAllowed: true, skyActive: false })).toBe(DEFAULT_MAX_PITCH);
    expect(maxPitchFor({ pitchAllowed: true, skyActive: true })).toBe(CITY_SKY_MAX_PITCH);
    expect(CITY_SKY_MAX_PITCH).toBeGreaterThan(DEFAULT_MAX_PITCH);
    expect(maxPitchFor({ pitchAllowed: false, skyActive: true })).toBe(0);
    expect(maxPitchFor({ pitchAllowed: false, skyActive: false })).toBe(0);
  });

  test('MapCanvas sets the ceiling from it, and from nowhere else', async () => {
    // The defect (review of #125): the interaction effect wrote a literal 60
    // while the adapter wrote 80, so an `interaction` change dropped a
    // sky-lit map back to 60°. Pin the single owner.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dir, '..', '..', '..');
    const canvas = readFileSync(join(root, 'components/map/MapCanvas.web.tsx'), 'utf8');
    const adapter = readFileSync(join(root, 'components/map/city3dLayer.web.ts'), 'utf8');
    const calls = canvas.match(/setMaxPitch\(([^;]*)\);/g) ?? [];
    expect(calls).toEqual([
      'setMaxPitch(maxPitchFor({ pitchAllowed: gestures.pitch, skyActive }));',
    ]);
    expect(adapter.includes('setMaxPitch(')).toBe(false);
  });
});
