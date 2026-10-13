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

import { TWILIGHT_DOCUMENT_DEG } from './catalogue';

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
 * The globe's light for one map: its night end, and the light its document
 * already draws (`1` but for a dawn or dusk map). Both from the style's night
 * (`palette3d.ts` → `CityNightSky`), as the city sky's.
 */
export interface GlobeNight {
  /** The ground's light at full night: the city sky's ground pass at a sun 20° down. */
  night: Rgb3;
  /** The light the document stands for, which is not drawn again. */
  document: Rgb3;
}

/**
 * The globe's night for a style's night light (`CityNightSky.ambient`) over
 * a map drawn in `appearance`'s light:
 *
 * - at full night, the ground pass's own light, `pow(brightness × the night's
 *   tint, 1/2.2)`, clamped to 1 (a multiply cannot brighten);
 * - over a dawn or dusk map, the day map's night relative to the light that
 *   map already shows, the twilight at {@link TWILIGHT_DOCUMENT_DEG}: no
 *   darker than the document while the sun is above that, darker only as it
 *   goes on down. Without it the low sun's dimming was drawn twice, the
 *   document's and this one's, and the dusk map went dull.
 */
export function globeNightFor(
  ambient: readonly [number, number, number],
  appearance: 'light' | 'twilight' | 'dark',
): GlobeNight {
  const luma = 0.2126 * ambient[0] + 0.7152 * ambient[1] + 0.0722 * ambient[2];
  const end = (brightness: number) =>
    ambient.map((v) =>
      Math.min(1, ((brightness * v) / Math.max(luma, 1e-12)) ** (1 / 2.2)),
    ) as Rgb3;
  if (appearance === 'dark')
    return { night: end(GLOBE_NIGHT_BRIGHTNESS.dark), document: [1, 1, 1] };
  const night = end(GLOBE_NIGHT_BRIGHTNESS.light);
  if (appearance === 'light') return { night, document: [1, 1, 1] };
  return { night, document: falling(TWILIGHT_DOCUMENT_DEG, night) };
}

/** The light falling from 1 to `night` over the twilight, for a sun `altitudeDeg` up. */
function falling(altitudeDeg: number, night: Rgb3): Rgb3 {
  const [from, to] = GLOBE_TWILIGHT_DEG;
  const t = Math.max(0, Math.min(1, (altitudeDeg - from) / (to - from)));
  const s = t * t * (3 - 2 * t);
  return night.map((n) => 1 + (n - 1) * s) as Rgb3;
}

/** The light, 0…1 per channel, for a sun `altitudeDeg` up — what the shader computes. */
export function globeLight(altitudeDeg: number, globe: GlobeNight): Rgb3 {
  const light = falling(altitudeDeg, globe.night);
  return light.map((v, c) => Math.min(1, v / globe.document[c])) as Rgb3;
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
uniform vec3 uNight;
// The light the document already draws (globeNightFor): divided out.
uniform vec3 uDocument;
uniform float uOpacity;
const float PI = 3.141592653589793;
const float TWILIGHT_FROM = ${glslFloat(GLOBE_TWILIGHT_DEG[0])};
const float TWILIGHT_TO = ${glslFloat(GLOBE_TWILIGHT_DEG[1])};

vec3 unproject(mat4 inv, float z) {
  vec4 p = inv * vec4(vClip, z, 1.0);
  return p.xyz / p.w;
}

// The sine of the sun's altitude at the surface point under this pixel, or
// 2.0 where the ray misses the surface (space).
float sunSine() {
  float globe = 2.0;
  if (uGlobeness > 0.0) {
    vec3 o = unproject(uInvGlobe, -1.0);
    vec3 d = normalize(unproject(uInvGlobe, 1.0) - o);
    float b = dot(o, d);
    float disc = b * b - (dot(o, o) - 1.0);
    if (disc >= 0.0) globe = dot(normalize(o + d * (-b - sqrt(disc))), uSun);
  }
  float plane = 2.0;
  if (uGlobeness < 1.0) {
    vec3 a = unproject(uInvMercator, -1.0);
    vec3 e = unproject(uInvMercator, 1.0);
    float t = a.z / (a.z - e.z);
    vec2 m = mix(a.xy, e.xy, t);
    float lng = (m.x * 2.0 - 1.0) * PI;
    float lat = atan(sinh(PI * (1.0 - 2.0 * m.y)));
    plane = dot(vec3(sin(lng) * cos(lat), sin(lat), cos(lng) * cos(lat)), uSun);
  }
  if (uGlobeness >= 1.0) return globe;
  if (uGlobeness <= 0.0 || globe > 1.5) return plane;
  return mix(plane, globe, uGlobeness);
}

void main() {
  float s = sunSine();
  if (s > 1.5) discard;
  // globeLight(): a smoothstep over the sun's altitude, falling.
  float alt = degrees(asin(clamp(s, -1.0, 1.0)));
  float t = clamp((alt - TWILIGHT_FROM) / (TWILIGHT_TO - TWILIGHT_FROM), 0.0, 1.0);
  float night = t * t * (3.0 - 2.0 * t);
  vec3 light = min(vec3(1.0), mix(vec3(1.0), uNight, night) / uDocument);
  // Blended as a multiply (dst × src): 1 leaves the basemap as it is.
  fragColor = vec4(mix(vec3(1.0), light, uOpacity), 1.0);
}
`;
