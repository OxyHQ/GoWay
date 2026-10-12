/**
 * The street markings read on the asphalt (`lib/map/style/streetPalette.ts`):
 * the asphalt is the 3D ground palette's street fill (`palette3d.ts`, the one
 * source), and every marking colour clears its contrast floor on it, by day
 * and by night.
 */
import { describe, expect, test } from 'bun:test';

import { contrastRatio } from '@/lib/map/colour';
import { CITY_GROUND_PALETTES } from '@/lib/map/style/palette3d';
import { MARKING_CONTRAST, STREET_PALETTES } from '@/lib/map/style/streetPalette';

describe('street palette', () => {
  test('asphalt and sidewalk are the ground palette’s, not a second palette', () => {
    expect(STREET_PALETTES.day.asphalt).toBe(CITY_GROUND_PALETTES.light.roads.primary.fill);
    expect(STREET_PALETTES.night.asphalt).toBe(CITY_GROUND_PALETTES.dark.roads.primary.fill);
    expect(STREET_PALETTES.day.sidewalk).toBe(
      CITY_GROUND_PALETTES.light.roads.primary.casing ?? '',
    );
  });

  for (const time of ['day', 'night'] as const) {
    test(`markings clear their contrast floor by ${time}`, () => {
      const palette = STREET_PALETTES[time];
      const floor = MARKING_CONTRAST[time];
      expect(contrastRatio(palette.paint, palette.asphalt)).toBeGreaterThanOrEqual(floor.paint);
      expect(contrastRatio(palette.yellow, palette.asphalt)).toBeGreaterThanOrEqual(floor.yellow);
      // The kerb reads against the asphalt too: a raised sidewalk is lighter.
      expect(contrastRatio(palette.sidewalk, palette.asphalt)).toBeGreaterThan(1.3);
    });
  }

  test('the floors are not vacuous: the old pale asphalt fails by day', () => {
    expect(contrastRatio(STREET_PALETTES.day.paint, '#c6c9cd')).toBeLessThan(
      MARKING_CONTRAST.day.paint,
    );
  });
});
