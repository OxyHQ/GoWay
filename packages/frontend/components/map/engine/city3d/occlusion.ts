/**
 * Baked ambient occlusion and the light the city-3D buildings are shaded by.
 *
 * The thing `lib/map/style/buildings3d.ts` says MapLibre cannot do — "real
 * meshes with bevelled edges, chamfered roof lines and baked ambient occlusion
 * in the corners" — is two separate effects, and this file is the second one.
 * The bevel is geometry (`mesher.ts`); the occlusion is a number per vertex
 * plus a number per height, both derived from the footprint alone, so they
 * cost nothing per frame and need no screen-space pass.
 *
 * ## What is approximated, honestly
 *
 * Real AO is the fraction of the sky a point can see. Two cases dominate how a
 * city block reads, and those are the two baked here:
 *
 *  1. **Ground contact.** The bottom of every wall sees half the sky the top
 *     sees (the street and the building opposite take the rest). Modelled as a
 *     smoothstep from {@link AO.groundMin} at the ground to 1 at
 *     {@link AO.groundReachM}. Computed per FRAGMENT from height above ground,
 *     because a per-vertex value would need every wall cut into rows.
 *  2. **Concave corners.** Where a footprint turns INTO itself — the inside of
 *     an L, a courtyard's corners — two walls hide each other's sky. Modelled
 *     per VERTEX: full strength at the corner, fading to none
 *     {@link AO.cornerReachM} along each wall, scaled by how sharp the turn is.
 *     The mesher adds one vertex at that reach on each affected wall so the
 *     fade does not smear across a whole 40 m facade.
 *
 * What is NOT modelled: a short building in the shadow of a tall neighbour,
 * occlusion across a street, and the ground darkening around a footprint. Those
 * need either neighbour queries at compile time or screen-space AO (n8ao, as
 * Procedural Tokyo does), and both belong to a later phase in
 * `docs/MAP_3D_CITY.md`.
 *
 * Every function here is pure and mirrored by GLSL in `shaders.ts`, which
 * interpolates these same constants into its source, so the tested number and
 * the drawn number cannot drift apart. The light itself is MapLibre's, below.
 */

/** A direction in local ENU: x east, y north, z up. */
export type Vec3 = readonly [number, number, number];

/** Occlusion tuning. Values chosen against rendered frames; see the module header. */
export const AO = {
  /** Brightness factor at the foot of a wall. */
  groundMin: 0.62,
  /** Height in metres above which a wall is no longer darkened by the ground. */
  groundReachM: 7,
  /** How much a fully concave (90° or sharper) corner darkens, at the corner itself. */
  cornerDepth: 0.38,
  /** How far along each wall a corner's darkening reaches, in metres. */
  cornerReachM: 3,
} as const;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** GLSL's `smoothstep`, so the shader and the tests agree on the curve. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Brightness factor from ground contact, at `heightM` metres above the ground.
 *
 * 1 means unoccluded. Negative heights (should not happen) read as the ground.
 */
export function groundOcclusion(heightM: number): number {
  return AO.groundMin + (1 - AO.groundMin) * smoothstep(0, AO.groundReachM, heightM);
}

/**
 * How concave a footprint vertex is, in `[0, 1]`, from its signed turn angle.
 *
 * Rings are walked with the solid on the LEFT (exteriors counter-clockwise,
 * courtyards clockwise, in ENU). A left turn (positive) is a convex corner —
 * the outside of a block — and is never occluded. A right turn (negative) is
 * an inside corner; a 90° one is fully concave, a shallow bend of a curved
 * facade barely at all. Turns sharper than 90° saturate.
 */
export function concavity(turnRadians: number): number {
  return turnRadians >= 0 ? 0 : clamp01(-turnRadians / (Math.PI / 2));
}

/**
 * Brightness factor `distanceM` metres along a wall from a corner of the given
 * {@link concavity}. Linear, so per-vertex interpolation reproduces it exactly
 * between the corner vertex and the one the mesher places at the reach.
 */
export function cornerOcclusion(cornerConcavity: number, distanceM: number): number {
  const falloff = clamp01(1 - distanceM / AO.cornerReachM);
  return 1 - AO.cornerDepth * cornerConcavity * falloff;
}

// ---------------------------------------------------------------------------
// Light — MapLibre's extrusion lighting, fed by the sun
// ---------------------------------------------------------------------------

/**
 * The light the buildings are shaded by, in the units MapLibre's
 * `fill-extrusion` shader uses — so the city meshes and the `building-3d`
 * extrusion they replace are lit by the same light, the same way.
 *
 * It arrives from the MapLibre adapter (`components/map/city3dLight.ts` →
 * `cityLightFromSpec`), which converts the very `light` specification
 * `MapCanvas.web.tsx` hands `map.setLight()`: the real sun from
 * `useSunLight` (`lib/map/sunLight.ts`), or the style's own light when GoWay
 * does not own the style. It is a uniform, never baked into a mesh, so a sun
 * that moves costs one `setLight` and no re-meshing.
 */
export interface CityLight {
  /**
   * ENU (x east, y north, z up), pointing TOWARD the light, with MapLibre's
   * radial term as its length (1.15 for GoWay's lights — a gain, not a unit
   * vector; MapLibre does not normalise it either).
   */
  position: Vec3;
  /** MapLibre's `intensity`: how dark an unlit face gets (`1 − intensity`). */
  intensity: number;
  /** MapLibre's light `color`, sRGB channels in 0–1. White for GoWay. */
  color: Vec3;
}

/** Rec. 709 luma, as MapLibre's extrusion shader weighs a colour. */
export function luminance([r, g, b]: Vec3): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/**
 * MapLibre's `fill-extrusion` `directional` term for a face with outward unit
 * normal `normal`, base colour luminance `baseLuminance`, under `light`:
 *
 *     d = clamp(dot(normal, light.position), 0, 1)
 *     mix(1 − intensity, max(1 − luminance + intensity, 1), d)
 *
 * read off maplibre-gl 6.10's shader. The colour is then `(base + 0.03) ×
 * directional × lightColour`, clamped — see `shaders.ts`, which is this
 * function in GLSL. What MapLibre multiplies on top (its vertical gradient)
 * the city layer replaces with {@link groundOcclusion}; that and the bevel are
 * the ONLY differences between the two renderers.
 */
export function extrusionDirectional(
  normal: Vec3,
  light: CityLight,
  baseLuminance: number,
): number {
  const d = Math.max(
    0,
    Math.min(
      1,
      normal[0] * light.position[0] + normal[1] * light.position[1] + normal[2] * light.position[2],
    ),
  );
  const lit = Math.max(1 - baseLuminance + light.intensity, 1);
  return 1 - light.intensity + (lit - (1 - light.intensity)) * d;
}
