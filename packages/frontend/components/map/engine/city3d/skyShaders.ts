/**
 * GLSL for the city layer's sky, haze and shadows (GLSL ES 3.00 strings,
 * `RawShaderMaterial` + `GLSL3`, as `shaders.ts`).
 *
 * Generated from the constants in `atmosphere.ts` and `occlusion.ts` rather
 * than restating them, so the haze the tests pin (`hazeTransmittance`) is the
 * haze the GPU draws.
 *
 * Three programs:
 *
 *  - **The ground and sky passes** — one full-screen triangle pair drawn
 *    three times, before the buildings, over what MapLibre has drawn so far
 *    (the basemap: land, water, roads, the flat footprints):
 *      0. `FILL` (blend `src × (1 − dst alpha) + dst`): the horizon haze, only
 *         where MapLibre drew nothing at all — past its far plane the canvas
 *         is transparent, and would show the page through.
 *      1. `MULTIPLY` (blend `dst × src`): the basemap times the light on the
 *         ground — sun × shadow + sky — and times the haze transmittance;
 *         zero above the horizon.
 *      2. `ADD` (blend `dst + src`): the haze's in-scattered light below the
 *         horizon, the sky (and the sun's disc) above it.
 *    Together: `basemap · light · T + fog · (1 − T)` on the ground and the sky
 *    where there is no ground — the aerial-perspective equation, applied to
 *    pixels this layer did not draw, using nothing but blending. That is how
 *    the basemap gets the same light and haze as the buildings without the
 *    layer owning MapLibre's framebuffer.
 *  - **The sky-lit buildings**: the same light, the shadow map, the same
 *    haze, per fragment.
 *  - **The shadow casters**: depth only.
 */
import { ATMOSPHERE, FLOODLIGHT, HAZE, HAZE_CLEAR_M, STREET_GLOW_HEIGHT_M } from './atmosphere';
import { AO } from './occlusion';
import { OSM_BASE_GLSL } from './osmShaders';
import { Z_UNITS_PER_METRE } from './packing';
import type { CityTileFormat } from './protocol';
import { glslFloat } from './shaders';
import { DITHER_DISCARD_GLSL, DITHER_GLSL } from './transitions';

const vec3 = (v: readonly number[]) => `vec3(${v.map(glslFloat).join(', ')})`;

/** Shared: the haze (mirror of `hazeTransmittance`), the sky table, the shadow lookup. */
const COMMON = `
const float PI = 3.141592653589793;

uniform sampler2D uSkyLut;
uniform float uSunAzimuth;
uniform highp sampler2DShadow uShadowMap;
uniform float uShadowStrength;
uniform vec2 uShadowTexel;
uniform float uShadowBias;
// The ground plane's elevation, metres (CitySkyView.groundM; 0 without terrain).
uniform float uGroundZ;

const vec3 HAZE_RAYLEIGH = ${vec3(HAZE.rayleigh)};
const float HAZE_RAYLEIGH_H = ${glslFloat(HAZE.rayleighScaleHeightM)};
const float HAZE_MIE = ${glslFloat(HAZE.mie)};
const float HAZE_MIE_H = ${glslFloat(HAZE.mieScaleHeightM)};

float columnDensity(float h0, float dz, float d, float H) {
  float base = exp(-max(h0, 0.0) / H);
  float k = dz / H;
  if (abs(k * d) < 1e-4) return base * d;
  return base * (1.0 - exp(-k * d)) / k;
}

vec3 hazeTransmittance(float h0, float dz, float d) {
  // Clear near field (atmosphere.ts → HAZE_CLEAR_M): the haze starts there.
  float clear = min(max(d, 0.0), ${glslFloat(HAZE_CLEAR_M)});
  float from = h0 + dz * clear;
  float rest = max(d - clear, 0.0);
  float r = columnDensity(from, dz, rest, HAZE_RAYLEIGH_H);
  float m = columnDensity(from, dz, rest, HAZE_MIE_H);
  return exp(-(HAZE_RAYLEIGH * r + HAZE_MIE * m));
}

// The sky table (atmosphere.ts): across, the angle from the sun's azimuth;
// down, sqrt(elevation / (π/2)).
vec3 skyColor(vec3 dir) {
  float horizontal = length(dir.xy);
  float delta = 0.5 * PI;
  if (horizontal > 1e-6) {
    float az = atan(dir.x, dir.y);
    delta = abs(mod(az - uSunAzimuth + PI, 2.0 * PI) - PI);
  }
  float el = asin(clamp(dir.z / max(length(dir), 1e-6), 0.0, 1.0));
  return texture(uSkyLut, vec2(delta / PI, sqrt(el / (0.5 * PI)))).rgb;
}

// Interleaved gradient noise (Jimenez 2014): rotates the PCF kernel per pixel
// so 12 taps read as a smooth penumbra rather than 12 stacked copies.
float gradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

const vec2 POISSON[12] = vec2[](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457),
  vec2(-0.203, 0.621), vec2(0.962, -0.195), vec2(0.473, -0.480),
  vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064),
  vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
);

// 1 lit … 0 in shadow, already weighted by uShadowStrength and faded out at
// the shadow box's rim. clip: the shadow matrix applied to a position.
float sunVisibility(vec4 clip) {
  if (uShadowStrength <= 0.0) return 1.0;
  vec3 p = clip.xyz * 0.5 + 0.5;
  vec2 rim = min(p.xy, 1.0 - p.xy);
  float inside = smoothstep(0.0, 0.05, min(rim.x, rim.y));
  if (inside <= 0.0 || p.z >= 1.0) return 1.0;
  float angle = 6.2831853 * gradientNoise(gl_FragCoord.xy);
  mat2 spin = mat2(cos(angle), sin(angle), -sin(angle), cos(angle));
  float lit = 0.0;
  for (int i = 0; i < 12; i++) {
    // Three texels: a wide, soft penumbra — the maquette look, and it hides
    // the texel grid at street-level zooms.
    vec2 offset = spin * POISSON[i] * uShadowTexel * 3.0;
    lit += texture(uShadowMap, vec3(p.xy + offset, p.z - uShadowBias));
  }
  lit /= 12.0;
  return mix(1.0, lit, inside * uShadowStrength);
}
`;

/**
 * For an overlay's own fragment shader (`overlay.ts` → `CityOverlaySky`):
 * the sky's shared functions and every light uniform they and a material
 * need. Prepend it after `precision`.
 */
export const SKY_OVERLAY_GLSL = `${COMMON}
uniform vec3 uCamera;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundBounce;
uniform mat4 uShadowMatrix;
uniform float uMetresPerMercator;
uniform float uNightFactor;
`;

export const SKY_PASS_VERTEX_SHADER = `
precision highp float;

in vec3 position;
// Far-plane corner minus camera, ENU metres, for (−1,−1), (1,−1), (−1,1), (1,1).
uniform vec3 uCorners[4];
out vec3 vRay;

void main() {
  vec2 uv = position.xy * 0.5 + 0.5;
  vRay = mix(mix(uCorners[0], uCorners[1], uv.x), mix(uCorners[2], uCorners[3], uv.x), uv.y);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** `pass`: which of the blends this program feeds (see the header). */
export function skyPassFragmentShader(pass: 'fill' | 'multiply' | 'add'): string {
  return `
precision highp float;
#define ${pass.toUpperCase()}
${COMMON}

uniform vec3 uCamera;
uniform mat4 uShadowEnu;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uSunDisc;
// 0 → 1: the whole effect, faded in with zoom.
uniform float uEffect;

in vec3 vRay;
out vec4 fragColor;

const float SUN_RADIUS = ${glslFloat(ATMOSPHERE.sunAngularRadiusDeg * 2 * (Math.PI / 180))};

void main() {
  vec3 dir = normalize(vRay);
  // Anti-aliased horizon: one pixel's worth of blend between ground and sky.
  float w = max(fwidth(dir.z), 1e-6);
  float skyness = smoothstep(-w, w, dir.z);

  float h0 = max(uCamera.z - uGroundZ, 1.0);
  // Where the ray meets the ground; past ~200 km the haze is saturated.
  float d = dir.z < -1e-6 ? min(h0 / -dir.z, 2.0e5) : 2.0e5;
  vec3 T = hazeTransmittance(h0, min(dir.z, 0.0), d);

#ifdef MULTIPLY
  vec3 ground = uCamera + dir * d;
  float visible = sunVisibility(uShadowEnu * vec4(ground.xy, uGroundZ, 1.0));
  vec3 light = uSunColor * max(uSunDir.z, 0.0) * visible + uSkyAmbient;
  vec3 factor = mix(pow(light, vec3(${glslFloat(1 / 2.2)})) * T, vec3(0.0), skyness);
  fragColor = vec4(mix(vec3(1.0), factor, uEffect), 1.0);
#endif
#ifdef ADD
  vec3 fog = skyColor(vec3(dir.xy, 0.0));
  float c = dot(dir, uSunDir);
  float disc = smoothstep(cos(SUN_RADIUS * 1.2), cos(SUN_RADIUS * 0.8), c);
  float glow = pow(max(c, 0.0), 1200.0) * 0.5;
  vec3 sky = skyColor(dir) + uSunDisc * (disc + glow);
  vec3 color = mix(fog * (1.0 - T), sky, skyness) * uEffect;
  fragColor = vec4(color, skyness * uEffect);
#endif
#ifdef FILL
  // Only where MapLibre drew nothing (blend: src × (1 − dst alpha)): past its
  // far plane, near the horizon, the canvas is transparent. Fill it with the
  // horizon's haze, which is what the ground there would fade into anyway —
  // divided by the ground light the MULTIPLY pass is about to apply, so that
  // after it and the ADD pass the pixel is exactly the haze, not a lit copy
  // of it (which drew a dark band under the horizon at night).
  vec3 groundLight = pow(uSunColor * max(uSunDir.z, 0.0) + uSkyAmbient, vec3(${glslFloat(1 / 2.2)}));
  vec3 fill = min(skyColor(vec3(dir.xy, 0.0)) / max(groundLight, vec3(1e-3)), vec3(1.0));
  fragColor = vec4(fill, 1.0) * uEffect;
#endif
}
`;
}

/**
 * The sky-lit buildings' vertex shader, for either tile format: GoWay's OSM
 * city tiles carry a colour and a storey rhythm the OpenMapTiles meshes do
 * not (`osmShaders.ts`). Both stand on the terrain the same way
 * (`terrainGround.ts`: a per-vertex lift, read only while `uGrounded`).
 */
export function skyCityVertexShader(format: CityTileFormat | undefined): string {
  const osm = format === 'goway';
  return `
precision highp float;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
// Centre-relative mercator → shadow clip.
uniform mat4 uShadowMatrix;
uniform float uMetresPerMercator;
// How far along the normal the shadow lookup starts, in metres (a texel):
// keeps a wall from shadowing itself.
uniform float uShadowNormalOffset;
uniform float uGrounded;

// The compact format (packing.ts), exactly as the format's own shader reads
// it: x, y in tile units, z in 1/32 m, w the shade word (tone × 256 + corner
// occlusion); the model matrix turns the units back into metres.
in vec4 position;
in vec4 normal;
in float ground;
${osm ? 'in vec4 color;\nin vec4 facade;\n// Per-building flags (osmMesher.ts → VERTEX_FLAG_*).\nin float flags;' : ''}

out vec3 vNormal;
out float vCornerAo;
out float vHeightAboveGround;
out float vBuildingHeight;
out vec3 vWorld;
out vec4 vShadow;
${osm ? 'out vec4 vColor;\nout vec4 vFacade;\nout float vFlags;' : ''}

void main() {
  vNormal = normal.xyz;
  float tone = floor(position.w / 256.0);
  vCornerAo = (position.w - tone * 256.0) / 255.0;
  vHeightAboveGround = position.z * ${glslFloat(1 / Z_UNITS_PER_METRE)};
  vBuildingHeight = tone;
  ${osm ? 'vColor = color;\n  vFacade = facade;\n  vFlags = flags;' : ''}
  // The lift is metres; stored z is 1/32 m, scaled back by the model matrix.
  float lift = uGrounded > 0.5 ? ground * ${glslFloat(Z_UNITS_PER_METRE)} : 0.0;
  vec4 local = vec4(position.xy, position.z + lift, 1.0);
  vec4 world = modelMatrix * local;
  vWorld = vec3(world.x, -world.y, world.z) * uMetresPerMercator;
  // The lookup starts a texel out along the normal (ENU → mercator: y flips),
  // in mercator, where the model matrix's anisotropic units are gone.
  vec3 offset = vec3(normal.x, -normal.y, normal.z) * (uShadowNormalOffset / uMetresPerMercator);
  vShadow = uShadowMatrix * vec4(world.xyz + offset, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * local;
}
`;
}

/**
 * The ONE shading path's contract (owner decision: the sky owns the light
 * INPUTS, the art direction owns the MATERIAL RESPONSE, and they compose in a
 * single shader):
 *
 * ```glsl
 * struct CitySurface {          // what is being lit — from the tiles
 *   vec3 albedo;                // linear base colour (ramp / tagged / openings)
 *   vec3 normal;                // ENU, unit
 *   float ao;                   // baked occlusion, ground × corner (0…1)
 *   float cornerAo;             // the corner term alone
 *   float heightAboveGround;    // metres
 *   float buildingHeight;       // metres (the ramp's input, capped)
 *   vec3 world;                 // ENU metres from the map centre
 *   vec4 facade;                // osmMesher.ts `facade` (0 on OpenMapTiles)
 *   vec4 color;                 // osmMesher.ts `colors` (0 on OpenMapTiles)
 *   float flags;                // osmMesher.ts `flags` (0 on OpenMapTiles)
 * };
 * struct CityLight {            // what lights it — from the sky
 *   vec3 sunDir;                // ENU, unit, the real sun
 *   vec3 sun;                   // direct sun, exposed (multiply by n·l)
 *   float sunVisibility;        // the shadow map: 1 lit … 0 shadowed (soft)
 *   vec3 skyUp;                 // sky irradiance on a surface facing up
 *   vec3 skyDown;               // bounce on a surface facing down
 *   vec3 emitted;               // street glow + floodlights, already shaped
 *   float nightFactor;          // lib/map/landmarks/night.ts
 * };
 * vec3 cityMaterial(CitySurface s, CityLight l);  // → linear lit colour
 * ```
 *
 * The material function is a GLSL chunk ({@link DEFAULT_CITY_MATERIAL_GLSL}
 * unless one is passed in, `CityEngineOptions.sky.material`); it may declare
 * its own uniforms and helpers. Gamma, haze and opacity are applied after it,
 * here, so the haze stays the sky's and identical on every material.
 */
export const DEFAULT_CITY_MATERIAL_GLSL = `
// Highlights roll off above 0.8 instead of clipping: a wall facing a low sun.
vec3 rolloff(vec3 x) {
  vec3 soft = 0.8 + 0.2 * (1.0 - exp(-(x - 0.8) / 0.2));
  return mix(x, soft, step(0.8, x));
}

// The default response: matte clay — sun × shadow (a little occluded), a
// hemisphere of sky and bounce (occluded), and what the scene emits.
vec3 cityMaterial(CitySurface s, CityLight l) {
  float facing = max(dot(s.normal, l.sunDir), 0.0);
  vec3 hemisphere = mix(l.skyDown, l.skyUp, 0.5 + 0.5 * s.normal.z);
  vec3 light = l.sun * facing * l.sunVisibility * mix(1.0, s.ao, 0.35)
    + hemisphere * s.ao
    + l.emitted;
  return rolloff(s.albedo * light);
}
`;

/** The sky-lit buildings' fragment shader; `format` as {@link skyCityVertexShader}. */
export function skyCityFragmentShader(
  format: CityTileFormat | undefined,
  material: string = DEFAULT_CITY_MATERIAL_GLSL,
): string {
  const osm = format === 'goway';
  return `
precision highp float;
${COMMON}

uniform vec3 uLow;
uniform vec3 uTall;
uniform vec3 uVeryTall;
uniform float uTallM;
uniform float uVeryTallM;
uniform float uOpacity;

uniform vec3 uCamera;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundBounce;
// Warm street-level light on walls at night (atmosphere.ts → STREET_GLOW).
uniform vec3 uStreetGlow;
// The night seam (CityEngine.setNightFactor), shared with every night look.
uniform float uNightFactor;

in vec3 vNormal;
in float vCornerAo;
in float vHeightAboveGround;
in float vBuildingHeight;
in vec3 vWorld;
in vec4 vShadow;
${osm ? 'in vec4 vColor;\nin vec4 vFacade;\nin float vFlags;' : ''}

out vec4 fragColor;
${osm ? OSM_BASE_GLSL : ''}

// Level-of-detail and fade-in cross-fades (transitions.ts).
${DITHER_GLSL}

struct CitySurface {
  vec3 albedo;
  vec3 normal;
  float ao;
  float cornerAo;
  float heightAboveGround;
  float buildingHeight;
  vec3 world;
  vec4 facade;
  vec4 color;
  float flags;
};

struct CityLight {
  vec3 sunDir;
  vec3 sun;
  float sunVisibility;
  vec3 skyUp;
  vec3 skyDown;
  vec3 emitted;
  float nightFactor;
};

${material}

void main() {
  ${DITHER_DISCARD_GLSL}
  vec3 n = normalize(vNormal);

  // The surface colour, exactly as the format's own shader has it.
  ${
    osm
      ? 'vec3 base = osmBase(n);'
      : `vec3 base = vBuildingHeight < uTallM
    ? mix(uLow, uTall, vBuildingHeight / uTallM)
    : mix(uTall, uVeryTall, clamp((vBuildingHeight - uTallM) / (uVeryTallM - uTallM), 0.0, 1.0));`
  }
  vec3 albedo = pow(base, vec3(2.2));

  float groundAo = ${glslFloat(AO.groundMin)}
    + ${glslFloat(1 - AO.groundMin)} * smoothstep(0.0, ${glslFloat(AO.groundReachM)}, vHeightAboveGround);

  CitySurface surface;
  surface.albedo = albedo;
  surface.normal = n;
  surface.ao = groundAo * vCornerAo;
  surface.cornerAo = vCornerAo;
  surface.heightAboveGround = vHeightAboveGround;
  surface.buildingHeight = vBuildingHeight;
  surface.world = vWorld;
  surface.facade = ${osm ? 'vFacade' : 'vec4(0.0)'};
  surface.color = ${osm ? 'vColor' : 'vec4(0.0)'};
  surface.flags = ${osm ? 'vFlags' : '0.0'};

  // The light inputs — the sky's side of the contract.
  float street = (1.0 - abs(n.z))
    * (1.0 - smoothstep(0.0, ${glslFloat(STREET_GLOW_HEIGHT_M)}, vHeightAboveGround));
  vec3 emitted = uStreetGlow * street;
  ${
    osm
      ? `// Floodlights on buildings that record being lit (atmosphere.ts → FLOODLIGHT).
  float floodlit = mod(floor(vFlags + 0.5), 2.0) * uNightFactor;
  if (floodlit > 0.0) {
    float rise = clamp(vHeightAboveGround / max(vBuildingHeight, 4.0), 0.0, 1.0);
    float onWall = mix(1.0, ${glslFloat(FLOODLIGHT.top)}, rise);
    float shape = mix(onWall, ${glslFloat(FLOODLIGHT.roof)}, step(0.7, abs(n.z)));
    emitted += ${vec3(FLOODLIGHT.color)} * ${glslFloat(FLOODLIGHT.intensity)} * floodlit * shape
      * mix(1.0, surface.ao, 0.5);
  }`
      : ''
  }
  CityLight light;
  light.sunDir = uSunDir;
  light.sun = uSunColor;
  light.sunVisibility = sunVisibility(vShadow);
  light.skyUp = uSkyAmbient;
  light.skyDown = uGroundBounce;
  light.emitted = emitted;
  light.nightFactor = uNightFactor;

  vec3 color = pow(max(cityMaterial(surface, light), vec3(0.0)), vec3(${glslFloat(1 / 2.2)}));

  // Aerial perspective, the same as the ground pass's.
  vec3 toFragment = vWorld - uCamera;
  float d = length(toFragment);
  vec3 dir = toFragment / max(d, 1e-3);
  vec3 T = hazeTransmittance(max(uCamera.z - uGroundZ, 1.0), dir.z, d);
  color = color * T + skyColor(vec3(dir.xy, 0.0)) * (1.0 - T);

  fragColor = vec4(color * uOpacity, uOpacity);
}
`;
}

export const SHADOW_CASTER_VERTEX_SHADER = `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uGrounded;
// The compact format (packing.ts); only the position is needed.
in vec4 position;
in float ground;
void main() {
  float lift = uGrounded > 0.5 ? ground * ${glslFloat(Z_UNITS_PER_METRE)} : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xyz + vec3(0.0, 0.0, lift), 1.0);
}
`;

export const SHADOW_CASTER_FRAGMENT_SHADER = `
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0);
}
`;
