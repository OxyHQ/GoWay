/**
 * The map's pitch ceiling with and without the city sky. Whether the sky draws
 * is the registry's (`mapFeatures.test.ts`).
 */
import { describe, expect, test } from 'bun:test';

import { CITY_SKY_MAX_PITCH, DEFAULT_MAX_PITCH, maxPitchFor } from '@/lib/map/citySkyFlag';

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
    const plugin = readFileSync(join(root, 'components/map/gowayEngine.web.ts'), 'utf8');
    const adapter = readFileSync(join(root, 'components/map/city3dLayer.web.ts'), 'utf8');
    // The canvas hands the ceiling to the map, which is its one setter.
    const ceilings = canvas.match(/maxPitch=\{[^}]*\}\)\}/g) ?? [];
    expect(ceilings).toEqual([
      'maxPitch={maxPitchFor({ pitchAllowed: interaction?.pitch ?? true, skyActive })}',
    ]);
    for (const source of [canvas, plugin, adapter])
      expect(source.includes('setMaxPitch(')).toBe(false);
  });
});
