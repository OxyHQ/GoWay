import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_ALTITUDE_METERS,
  MAX_MODEL_SCALE,
  MODEL_ALTITUDE_REFERENCES,
  parseModelPlacement,
  type ModelPlacementInput,
} from '../src/index';

/**
 * `parseModelPlacement` is the NaN gate in front of every model renderer
 * (`docs/SDK_MAP_MODELS.md` → "The contract schema is the NaN gate"): a bad
 * placement is `null` — that model falls back to a marker — and never a throw.
 */

const SAGRADA = { latitude: 41.4036, longitude: 2.1744 };

describe('parseModelPlacement', () => {
  it('fills every default from a bare position', () => {
    expect(parseModelPlacement({ position: SAGRADA })).toEqual({
      position: SAGRADA,
      altitude: { meters: 0, reference: 'ground' },
      orientation: { heading: 0, pitch: 0, roll: 0 },
      scale: 1,
    });
  });

  it('keeps what the caller said', () => {
    const input: ModelPlacementInput = {
      position: SAGRADA,
      altitude: { meters: 12, reference: 'ground' },
      orientation: { heading: 271.5, pitch: -4 },
      scale: 2,
    };
    expect(parseModelPlacement(input)).toEqual({
      position: SAGRADA,
      altitude: { meters: 12, reference: 'ground' },
      orientation: { heading: 271.5, pitch: -4, roll: 0 },
      scale: 2,
    });
  });

  it('answers null for anything a renderer cannot draw, and never throws', () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      'here',
      {},
      { position: { latitude: Number.NaN, longitude: 2 } },
      { position: { latitude: 41, longitude: Number.POSITIVE_INFINITY } },
      { position: { latitude: 91, longitude: 2 } },
      // Past Web Mercator's limit: the map cannot draw it where it says, so
      // the renderer would clamp the anchor but size it at the real latitude.
      { position: { latitude: 85.06, longitude: 2 } },
      { position: { latitude: -89, longitude: 2 } },
      { position: SAGRADA, orientation: { heading: 360 } },
      { position: SAGRADA, orientation: { heading: Number.NaN } },
      { position: SAGRADA, orientation: { pitch: 91 } },
      { position: SAGRADA, scale: 0 },
      { position: SAGRADA, scale: MAX_MODEL_SCALE + 1 },
      {
        position: SAGRADA,
        altitude: { meters: MAX_MODEL_ALTITUDE_METERS + 1, reference: 'ground' },
      },
      // Only 'ground' until GoWay has a DEM.
      { position: SAGRADA, altitude: { meters: 0, reference: 'sea' } },
      // Positional pairs are GeoJSON's spelling, never a placement's.
      { position: [2.1744, 41.4036] },
    ];
    for (const input of bad) expect(parseModelPlacement(input)).toBeNull();
  });

  it('accepts the whole drawable latitude range', () => {
    expect(parseModelPlacement({ position: { latitude: 85.05, longitude: 179.9 } })).not.toBeNull();
    expect(parseModelPlacement({ position: { latitude: -85.05, longitude: -180 } })).not.toBeNull();
  });

  it('has exactly one altitude reference until there is a DEM', () => {
    expect(MODEL_ALTITUDE_REFERENCES).toEqual(['ground']);
  });
});
