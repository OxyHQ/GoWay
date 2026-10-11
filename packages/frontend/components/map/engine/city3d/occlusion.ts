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
 * the drawn number cannot drift apart.
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
// Light — THE seam for the sun
// ---------------------------------------------------------------------------

/**
 * The light the buildings are shaded by.
 *
 * **This is the seam a real sun plugs into.** A separate branch adds
 * `lib/map/sun.ts` (the sun's actual position for a place and time); this
 * prototype deliberately does not import it. Whoever wires the two together
 * converts that module's azimuth/altitude with {@link lightFromSunAngles} and
 * calls `setLight` on the engine handle — nothing else here changes, because
 * the light is a uniform and never baked into a mesh.
 *
 * The light is anchored to the MAP, not the viewport (the opposite of the
 * `fill-extrusion` layer's `anchor: 'viewport'`): a sun does not rotate with
 * the camera, and once there is a real one the shading has to agree with it.
 */
export interface CityLight {
  /** Unit vector in ENU pointing TOWARD the light. */
  direction: Vec3;
}

/**
 * A light from a compass azimuth and an altitude, both in degrees.
 *
 * `azimuthDeg` is a compass bearing: 0 north, 90 east, clockwise. (SunCalc and
 * some other sources measure from the SOUTH; convert before calling.)
 * `altitudeDeg` is the angle above the horizon. Below the horizon is clamped
 * to it — there is no "night" shading in the prototype.
 */
export function lightFromSunAngles(azimuthDeg: number, altitudeDeg: number): CityLight {
  const az = (azimuthDeg * Math.PI) / 180;
  const alt = (Math.max(0, Math.min(90, altitudeDeg)) * Math.PI) / 180;
  return {
    direction: [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)],
  };
}

/**
 * The light used until a real sun is wired in: a mid-afternoon sun in the
 * south-west, 45° up. South-west rather than MapLibre's viewport-anchored
 * default so that south- and west-facing walls read lit and north- and
 * east-facing ones shaded, which is what anyone in the northern hemisphere
 * expects of a city in the afternoon.
 */
export const DEFAULT_CITY_LIGHT: CityLight = lightFromSunAngles(225, 45);

/**
 * How much of a wall's brightness is ambient and how much is the light.
 *
 * Per appearance for the same reason `BUILDINGS_LIGHT` is per appearance in
 * `buildings3d.ts`: shading is multiplicative, and a fixed ratio of a near-
 * black colour is almost no difference at all, so the dark map needs more of
 * its brightness to come from the directional term to keep a corner legible.
 */
export interface CityShading {
  ambient: number;
  diffuse: number;
}

export const CITY_SHADING: Record<'light' | 'dark', CityShading> = {
  light: { ambient: 0.8, diffuse: 0.26 },
  dark: { ambient: 0.62, diffuse: 0.55 },
};

/**
 * Brightness of a surface with unit normal `normal`, before occlusion.
 *
 * A hemisphere ambient (a surface facing the sky gets all of it, a vertical
 * wall about three quarters, an overhang's underside half) plus Lambert. The
 * shader in `shaders.ts` is this function, line for line.
 */
export function surfaceBrightness(normal: Vec3, light: CityLight, shading: CityShading): number {
  const sky = 0.5 + 0.5 * normal[2];
  const lambert = Math.max(
    0,
    normal[0] * light.direction[0] +
      normal[1] * light.direction[1] +
      normal[2] * light.direction[2],
  );
  return shading.ambient * (0.5 + 0.5 * sky) + shading.diffuse * lambert;
}
