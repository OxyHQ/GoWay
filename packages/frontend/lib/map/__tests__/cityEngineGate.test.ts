import { describe, expect, test } from 'bun:test';

import {
  CITY_ENGINE_MIN_PITCH,
  CITY_ENGINE_MIN_ZOOM,
  cityEngineWanted,
} from '@/lib/map/cityEngineGate';

describe('cityEngineWanted', () => {
  test('close to the buildings, or tilted towards the sky', () => {
    // goway.to's default view: flat, z11 — no engine, no three.js.
    expect(cityEngineWanted({ zoom: 11, pitch: 0 })).toBe(false);
    expect(cityEngineWanted({ zoom: 13.9, pitch: 44 })).toBe(false);
    expect(cityEngineWanted({ zoom: 14, pitch: 0 })).toBe(true);
    // Montserrat at z13.4, tilted: the sky is on screen.
    expect(cityEngineWanted({ zoom: 13.4, pitch: 70 })).toBe(true);
    expect(cityEngineWanted({ zoom: 5, pitch: CITY_ENGINE_MIN_PITCH })).toBe(true);
    // Before the buildings fade in (15.5).
    expect(CITY_ENGINE_MIN_ZOOM).toBeLessThan(15.5);
  });
});
