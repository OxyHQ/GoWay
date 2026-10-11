/**
 * The shared landmark palette: maquette materials, tuned once against
 * rendered frames so every landmark reads as one family on the map.
 *
 * Matte and slightly desaturated, like a painted architectural model: stone
 * is never pure white (it would blow out under the sun), glass is a dark
 * blue-grey that reads as "window" from 500 m, metal is the only thing that
 * shines. The night colours are warm (2,700–3,200 K) against the blue night
 * map, which is the whole night look.
 */
import type { LandmarkMaterial } from './glb';

/** Warm interior light, as a lit window reads from the street. */
export const WINDOW_WARM = '#ffcf8a';
/** Warm white floodlight on stone. */
export const FLOOD_WARM = '#ffd9a8';

export const PALETTE = {
  limestone: { color: '#e4d9c6', roughness: 0.88, uplight: true },
  sandstone: { color: '#d8c19c', roughness: 0.9, uplight: true },
  granite: { color: '#b9b0a3', roughness: 0.8, uplight: true },
  brick: { color: '#b7684b', roughness: 0.9, uplight: true },
  terracotta: { color: '#c98a64', roughness: 0.85, uplight: true },
  concrete: { color: '#cfcdc7', roughness: 0.9, uplight: true },
  white: { color: '#eeece6', roughness: 0.75, uplight: true },
  roofDark: { color: '#6f7479', roughness: 0.8 },
  glass: { color: '#4d5e70', metallic: 0.2, roughness: 0.25, decal: true },
  windowLit: {
    color: '#4d5e70',
    metallic: 0.2,
    roughness: 0.25,
    night: { color: WINDOW_WARM, strength: 1.1 },
  },
  glassCurtain: { color: '#7d97ad', metallic: 0.25, roughness: 0.18 },
  curtainLit: {
    color: '#7d97ad',
    metallic: 0.25,
    roughness: 0.18,
    night: { color: '#ffe2b0', strength: 0.95 },
  },
  steel: { color: '#d3d8de', metallic: 0.25, roughness: 0.35 },
  steelLit: {
    color: '#d3d8de',
    metallic: 0.25,
    roughness: 0.35,
    night: { color: '#fff0d2', strength: 0.9 },
  },
  copper: { color: '#86c2ab', roughness: 0.62, metallic: 0.15, uplight: true },
  gold: {
    color: '#e8b64a',
    metallic: 0.3,
    roughness: 0.3,
    night: { color: '#ffc04d', strength: 1.6 },
  },
  lamp: { color: '#f4ead8', roughness: 0.5, night: { color: '#ffd38f', strength: 1.4 } },
  beacon: { color: '#d84a3a', roughness: 0.5, night: { color: '#ff4a36', strength: 1.6 } },
  greenery: { color: '#8bb07c', roughness: 0.95 },
  water: { color: '#7fb3c9', metallic: 0.2, roughness: 0.15 },
} as const satisfies Record<string, LandmarkMaterial>;

export type PaletteKey = keyof typeof PALETTE;
