/**
 * The buildings' MapLibre `light`, as the city-3D engine's `CityLight`.
 *
 * The city-3D prototype must light its meshes with EXACTLY the light the
 * `building-3d` extrusion it replaces would have used — the sun light
 * `useSunLight` produces (`lib/map/sunLight.ts`), or the style document's own
 * when GoWay does not own the style — so that switching renderers changes the
 * bevels and the occlusion and nothing else. This module is the translation,
 * and the shader in `engine/city3d/shaders.ts` is MapLibre's own
 * `fill-extrusion` lighting formula, so the two agree face for face.
 *
 * ## MapLibre's frame, read off maplibre-gl 6.10
 *
 * `light.position` is `[radial, azimuthal, polar]`. MapLibre turns it into a
 * Cartesian vector with `sphericalToCartesian` (azimuth + 90°, then the usual
 * spherical formula) in TILE coordinates (x east, y SOUTH, z up), rotates it
 * by the bearing when `anchor` is `viewport`, and takes `dot(normal, light)`
 * against wall normals that point INTO the building (`p1.sub(p2)._perp()` on a
 * clockwise exterior). Worked through, that is the same number as the dot of
 * the OUTWARD normal with
 *
 *     (sin a · sin p,  cos a · sin p,  cos p) · radial     in ENU (x east, y north)
 *
 * with `a` the azimuth (+ bearing under `viewport`) clockwise from north and
 * `p` the polar angle from the zenith — which is what {@link cityLightFromSpec}
 * returns, and what `__tests__/city3dLight.test.ts` checks against a
 * re-implementation of MapLibre's own steps. The radial term is kept, not
 * normalised: MapLibre does not normalise it either (1.15 is a 15% gain on
 * every face, see `buildings3d.ts`).
 *
 * Pure and imported ONLY by the MapLibre adapter (`city3dLayer.web.ts`), so it
 * lives in that lazy chunk; the engine sees the finished `CityLight`.
 */
import type { CityLight } from './engine/city3d/occlusion';

/**
 * The fields of a MapLibre `LightSpecification` this reads, structurally.
 *
 * Not the spec type itself: `maplibre-gl` resolves its own nested copy of
 * `@maplibre/maplibre-gl-style-spec`, so `map.getLight()` and the app's
 * `LightSpecification` (what `useSunLight` produces) are two nominally
 * different types for one shape. Every field is read defensively anyway.
 */
export interface LightLike {
  anchor?: unknown;
  position?: unknown;
  intensity?: unknown;
  color?: unknown;
}

/** MapLibre's defaults for an unset `light` property (style spec v8). */
const DEFAULT_POSITION: readonly [number, number, number] = [1.15, 210, 30];
const DEFAULT_INTENSITY = 0.5;
const DEFAULT_ANCHOR = 'viewport';

const DEG = Math.PI / 180;

function literalPosition(value: unknown): readonly [number, number, number] {
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part))
  ) {
    return value as [number, number, number];
  }
  return DEFAULT_POSITION;
}

/** `#rgb` / `#rrggbb` → sRGB channels in 0–1; anything else is white, MapLibre's default. */
function literalColor(value: unknown): [number, number, number] {
  if (typeof value !== 'string') return [1, 1, 1];
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  const parts = short ? short.slice(1).map((h) => h + h) : long ? long.slice(1) : null;
  if (!parts) return [1, 1, 1];
  return parts.map((h) => Number.parseInt(h, 16) / 255) as [number, number, number];
}

/**
 * The engine's light for a MapLibre `light` specification, at the camera's
 * current bearing (which only matters under `anchor: 'viewport'` — the static
 * fallback light; the sun light is `map`-anchored).
 *
 * Only literal values are understood, which is all GoWay's style and
 * `sunLitBuildingsLight` ever write; an expression or a missing property falls
 * back to MapLibre's own default for it, as MapLibre would.
 */
export function cityLightFromSpec(
  spec: LightLike | null | undefined,
  bearingDeg: number,
): CityLight {
  const [radial, azimuth, polar] = literalPosition(spec?.position);
  const anchor = spec?.anchor ?? DEFAULT_ANCHOR;
  const a =
    (azimuth + (anchor === 'viewport' && Number.isFinite(bearingDeg) ? bearingDeg : 0)) * DEG;
  const p = polar * DEG;
  const intensity =
    typeof spec?.intensity === 'number' && Number.isFinite(spec.intensity)
      ? spec.intensity
      : DEFAULT_INTENSITY;
  return {
    position: [
      radial * Math.sin(a) * Math.sin(p),
      radial * Math.cos(a) * Math.sin(p),
      radial * Math.cos(p),
    ],
    intensity,
    color: literalColor(spec?.color),
  };
}

/**
 * Whether two lights would draw the same frame, so the adapter can skip the
 * engine call on the frames where nothing moved (all of them, under the
 * map-anchored sun; every frame of a rotation under the viewport fallback).
 */
export function sameCityLight(a: CityLight | null, b: CityLight): boolean {
  if (!a) return false;
  const close = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  return (
    close(a.intensity, b.intensity) &&
    a.position.every((value, i) => close(value, b.position[i])) &&
    a.color.every((value, i) => close(value, b.color[i]))
  );
}
