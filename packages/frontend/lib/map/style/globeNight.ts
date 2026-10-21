/**
 * Day and night on the globe: the real terminator for an instant, drawn by
 * `components/map/globeNightLayer.web.ts` (a MapLibre custom layer in the
 * relief chunk). Pure — numbers and shader source, no map — so the curve is a
 * test (`__tests__/globeNight.test.ts`). Design note: `docs/MAP_TERRAIN_GLOBE.md`
 * → "Day and night".
 *
 * ## What it draws
 *
 * Every pixel of the globe is ray-cast onto the unit sphere MapLibre draws
 * (`defaultProjectionData.mainMatrix`), and its sun altitude is read off the
 * angle to the SUBSOLAR POINT (`lib/map/sun.ts` → `subsolarPoint`): no tiles,
 * no polygons, so the poles and the antimeridian need nothing special and the
 * twilight is a smooth gradient, not bands. The basemap under it is multiplied
 * by a light: 1 on the day side, the city sky's own night on the night side
 * (the same blue-violet the street-level ground pass ends at), between them a
 * twilight band of about 1,500 km. City lights would need real data (no night
 * lights are in GoWay's data); without it the night side is just dark.
 *
 * ## Where it hands over
 *
 * The globe turns into mercator at z12 (`GLOBE_MERCATOR_ZOOM`), and there the
 * city sky's ground pass fades in over z12–13 (`sky.ts` → `EFFECT_ZOOM`). This
 * fades out over the SAME zooms with the same night, so the two cross over
 * without a pop where the city sky draws. Below, it follows the projection
 * through MapLibre's own globe → mercator transition (a ray onto the mercator
 * plane through `fallbackMatrix`, mixed by `projectionTransition`).
 */

import { type Rgb3 as LadderRgb, type SunLadder, sunLadderLight } from './sunLadder';

/** The zooms over which the night fades out: the city sky's EFFECT_ZOOM (pinned by the test). */
export const GLOBE_NIGHT_FADE_ZOOM: readonly [number, number] = [12, 13];

/**
 * Sun altitudes, degrees, over which the light falls from day to night (a
 * smoothstep). Fitted to the city sky's ground pass, whose light already
 * falls while the sun is low: within 0.1 of it at every altitude
 * (`globeNight.test.ts` measures it against `computeSkyState`).
 */
export const GLOBE_TWILIGHT_DEG: readonly [number, number] = [4, -10];

type Rgb3 = [number, number, number];

/**
 * How bright the ground is drawn at full night over a day map and over a
 * night map: the city sky's adapted brightness there (`atmosphere.ts` →
 * `BRIGHTNESS_CURVE`). Restated, not imported: that module is the engine
 * chunk's, and a module two lazy chunks share is hoisted into the first-paint
 * bundle. The test pins them together.
 */
export const GLOBE_NIGHT_BRIGHTNESS = { light: 0.13, dark: 0.62 } as const;

/**
 * The altitudes the light is tabled at, for the shader: every degree from
 * 12° up (where every document is undarkened) to 20° down (where every curve
 * has flattened), interpolated linearly between. Each handover of the sun
 * ladder (`sunLadder.ts` → `SUN_HANDOVERS`: 10°, 4°, −1°, −6°) is a whole
 * degree, so it is a sample, exactly.
 */
export const GLOBE_LIGHT_TABLE = { fromDeg: 12, stepDeg: 1, count: 33 } as const;

/**
 * The globe's light for one map: its night end, and the light by altitude —
 * for the morning side and the evening side of the globe, which a day map
 * hands over to dawn on and to dusk on (`sunLadder.ts`).
 */
export interface GlobeNight {
  /** The ground's light at full night: the city sky's ground pass at a sun 20° down. */
  night: Rgb3;
  /** The light at {@link GLOBE_LIGHT_TABLE}'s altitudes, rgb after rgb, where it is morning. */
  morning: Float32Array;
  /** The same where it is evening. */
  evening: Float32Array;
}

/**
 * The globe's night for a style's night light (`CityNightSky.ambient`) over
 * the document `ladder` describes:
 *
 * - at full night, the ground pass's own light, `pow(brightness × the night's
 *   tint, 1/2.2)`, clamped to 1 (a multiply cannot brighten), over a day map
 *   and over a night map (their base curves, {@link GLOBE_TWILIGHT_DEG});
 * - over a dawn or dusk map, the day map's light relative to the light that
 *   map already shows (the low sun's dimming is not drawn twice), and then,
 *   below the altitude it stands for, onto exactly what the night map draws
 *   where the night map takes over (`sunLadder.ts`): no jump at −6°;
 * - over a day map that follows the sun, onto what dawn, dusk or (for a style
 *   without them) the night map draws where that takes over: no jump at 4°
 *   or at the horizon.
 */
export function globeNightFor(
  ambient: readonly [number, number, number],
  ladder: SunLadder,
): GlobeNight {
  const luma = 0.2126 * ambient[0] + 0.7152 * ambient[1] + 0.0722 * ambient[2];
  const end = (brightness: number) =>
    ambient.map((v) =>
      Math.min(1, ((brightness * v) / Math.max(luma, 1e-12)) ** (1 / 2.2)),
    ) as Rgb3;
  const nightLight = end(GLOBE_NIGHT_BRIGHTNESS.light);
  const nightDark = end(GLOBE_NIGHT_BRIGHTNESS.dark);
  const base = {
    light: (a: number) => falling(a, nightLight),
    dark: (a: number) => falling(a, nightDark),
  };
  const table = (morning: boolean) => {
    const out = new Float32Array(GLOBE_LIGHT_TABLE.count * 3);
    for (let i = 0; i < GLOBE_LIGHT_TABLE.count; i++) {
      const alt = GLOBE_LIGHT_TABLE.fromDeg - i * GLOBE_LIGHT_TABLE.stepDeg;
      out.set(sunLadderLight(alt, ladder, base, morning), i * 3);
    }
    return out;
  };
  return {
    night: ladder.preset === 'night' ? nightDark : nightLight,
    morning: table(true),
    evening: table(false),
  };
}

/** The light falling from 1 to `night` over the twilight, for a sun `altitudeDeg` up. */
function falling(altitudeDeg: number, night: Rgb3): LadderRgb {
  const [from, to] = GLOBE_TWILIGHT_DEG;
  const t = Math.max(0, Math.min(1, (altitudeDeg - from) / (to - from)));
  const s = t * t * (3 - 2 * t);
  return night.map((n) => 1 + (n - 1) * s) as unknown as LadderRgb;
}

/**
 * The light, 0…1 per channel, for a sun `altitudeDeg` up on the morning or
 * evening side — what the shader computes, from the same table.
 */
export function globeLight(altitudeDeg: number, globe: GlobeNight, morning = false): Rgb3 {
  const table = morning ? globe.morning : globe.evening;
  const { fromDeg, stepDeg, count } = GLOBE_LIGHT_TABLE;
  const x = Math.max(0, Math.min(count - 1, (fromDeg - altitudeDeg) / stepDeg));
  const i = Math.floor(x);
  const j = Math.min(i + 1, count - 1);
  const f = x - i;
  return [0, 1, 2].map(
    (c) => table[i * 3 + c] + (table[j * 3 + c] - table[i * 3 + c]) * f,
  ) as Rgb3;
}

/** How much of the night is drawn at `zoom`, 0…1. */
export function globeNightOpacity(zoom: number): number {
  const [from, to] = GLOBE_NIGHT_FADE_ZOOM;
  const t = Math.max(0, Math.min(1, (zoom - from) / (to - from)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * A point on MapLibre's unit globe (`globe_utils.ts` →
 * `angularCoordinatesRadiansToVector`): x = sin(lng)·cos(lat), y = sin(lat),
 * z = cos(lng)·cos(lat).
 */
export function globeVector(lat: number, lng: number): [number, number, number] {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lng * Math.PI) / 180;
  return [Math.sin(lambda) * Math.cos(phi), Math.sin(phi), Math.cos(lambda) * Math.cos(phi)];
}

const glslFloat = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

export const GLOBE_NIGHT_VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 vClip;
void main() {
  // One triangle over the whole screen.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vClip = p;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const GLOBE_NIGHT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vClip;
out vec4 fragColor;
// Clip → the unit sphere's frame (inverse of MapLibre's globe mainMatrix).
uniform mat4 uInvGlobe;
// Clip → mercator 0…1 (inverse of the mercator matrix), for the transition.
uniform mat4 uInvMercator;
// MapLibre's projectionTransition: 1 on the globe, 0 on mercator.
uniform float uGlobeness;
// The subsolar point on the unit sphere.
uniform vec3 uSun;
// The light by altitude (globeNightFor → GLOBE_LIGHT_TABLE), morning and evening side.
uniform vec3 uMorning[${GLOBE_LIGHT_TABLE.count}];
uniform vec3 uEvening[${GLOBE_LIGHT_TABLE.count}];
uniform float uOpacity;
const float PI = 3.141592653589793;
const float TABLE_FROM = ${glslFloat(GLOBE_LIGHT_TABLE.fromDeg)};
const float TABLE_STEP = ${glslFloat(GLOBE_LIGHT_TABLE.stepDeg)};
const int TABLE_COUNT = ${GLOBE_LIGHT_TABLE.count};

vec3 unproject(mat4 inv, float z) {
  vec4 p = inv * vec4(vClip, z, 1.0);
  return p.xyz / p.w;
}

// The sine of the sun's altitude at the surface point under this pixel (x),
// or 2.0 where the ray misses the surface (space); and how far the sun is to
// the point's east (y: > 0 in the morning).
vec2 sunAt() {
  vec2 globe = vec2(2.0, 0.0);
  if (uGlobeness > 0.0) {
    vec3 o = unproject(uInvGlobe, -1.0);
    vec3 d = normalize(unproject(uInvGlobe, 1.0) - o);
    float b = dot(o, d);
    float disc = b * b - (dot(o, o) - 1.0);
    if (disc >= 0.0) {
      vec3 p = normalize(o + d * (-b - sqrt(disc)));
      globe = vec2(dot(p, uSun), dot(vec3(p.z, 0.0, -p.x), uSun));
    }
  }
  vec2 plane = vec2(2.0, 0.0);
  if (uGlobeness < 1.0) {
    vec3 a = unproject(uInvMercator, -1.0);
    vec3 e = unproject(uInvMercator, 1.0);
    float t = a.z / (a.z - e.z);
    vec2 m = mix(a.xy, e.xy, t);
    float lng = (m.x * 2.0 - 1.0) * PI;
    float lat = atan(sinh(PI * (1.0 - 2.0 * m.y)));
    vec3 p = vec3(sin(lng) * cos(lat), sin(lat), cos(lng) * cos(lat));
    plane = vec2(dot(p, uSun), dot(vec3(p.z, 0.0, -p.x), uSun));
  }
  if (uGlobeness >= 1.0) return globe;
  if (uGlobeness <= 0.0 || globe.x > 1.5) return plane;
  return mix(plane, globe, uGlobeness);
}

// globeLight(): the table, linearly between whole degrees.
vec3 tabled(float alt, bool morning) {
  float x = clamp((TABLE_FROM - alt) / TABLE_STEP, 0.0, float(TABLE_COUNT - 1));
  int i = int(floor(x));
  int j = min(i + 1, TABLE_COUNT - 1);
  float f = x - float(i);
  return morning ? mix(uMorning[i], uMorning[j], f) : mix(uEvening[i], uEvening[j], f);
}

void main() {
  vec2 sun = sunAt();
  if (sun.x > 1.5) discard;
  float alt = degrees(asin(clamp(sun.x, -1.0, 1.0)));
  // Morning and evening meet at noon and at midnight: blended over a narrow
  // band there, so the meridian is never a seam.
  vec3 light = mix(tabled(alt, false), tabled(alt, true), smoothstep(-0.02, 0.02, sun.y));
  // Blended as a multiply (dst × src): 1 leaves the basemap as it is.
  fragColor = vec4(mix(vec3(1.0), light, uOpacity), 1.0);
}
`;
