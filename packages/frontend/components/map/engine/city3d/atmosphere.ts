/**
 * The sky, the light and the haze of the city layer, from where the sun really
 * is — pure arithmetic, no renderer.
 *
 * `sky.ts` turns what this returns into GPU state; this module is the model,
 * so the questions a reviewer actually asks ("is the noon sky blue", "is the
 * sunset light orange", "is the night floor legible", "does haze grow with
 * distance") are tests (`__tests__/city3dAtmosphere.test.ts`), not pixels.
 *
 * ## The model
 *
 * A single-scattering atmosphere in the shape of Bruneton & Neyret (2008) and
 * Hillaire (2020) — the model takram's `three-geospatial` precomputes, and the
 * one Procedural Tokyo's sky comes from — with the same Earth constants:
 * Rayleigh scattering with an 8 km scale height, Mie (aerosol) scattering with
 * a 1.2 km one and a Cornette–Shanks phase, ozone absorption in a layer
 * around 25 km. What is NOT precomputed into 4D tables here:
 *
 *  - **The sky** is ray-marched on the CPU into one small table
 *    ({@link SKY_LUT_WIDTH} × {@link SKY_LUT_HEIGHT}), indexed by the angle
 *    from the sun's azimuth and the elevation. Seen from the ground, that is
 *    the whole sky: it depends on the sun's ALTITUDE only, so turning the sun
 *    round the compass is a uniform, and a table is recomputed only when the
 *    altitude moves ({@link skyStateFor} is cached by it).
 *  - **Aerial perspective** — the haze between the camera and what it looks at
 *    — is the closed-form transmittance of an exponential atmosphere along the
 *    view ray ({@link hazeTransmittance}), and what fills the lost light is
 *    the sky's own colour at the horizon in that direction. That is the
 *    textbook `L = L₀·T + L∞·(1 − T)` of a homogeneous medium: cheap enough
 *    for every pixel of the basemap, and it meets the sky seamlessly at the
 *    horizon because both come from the same table.
 *  - **Multiple scattering** is one isotropic term (Hillaire's observation that
 *    higher orders are nearly isotropic), which is what keeps twilight from
 *    going black the moment the sun sets.
 *
 * ## Light, exposure and the map's own colours
 *
 * The basemap is drawn by MapLibre in sRGB, with colours chosen for legibility
 * under no light at all. The city layer must not turn it into something else,
 * so the light is expressed as a MULTIPLIER on those colours, `1` at the
 * reference daylight: a white roof under the noon sun is the palette's white,
 * and the flat footprint beside it is too. The colour of the light comes from
 * the physics (sun transmittance, sky irradiance); its BRIGHTNESS is an
 * eye-adaptation curve ({@link adaptedBrightness}) — a camera at golden hour
 * does not show a map at 10% of its noon brightness, and neither does this.
 * Night is the curve's floor, tinted by a fixed night ambient: dark, blue and
 * intentional, never black, and never lit by anything the data does not
 * contain (no windows, no street light — `docs/MAP_3D_CITY.md` → Honesty).
 *
 * Gamma is a pure 2.2 power, not the piecewise sRGB curve, on purpose: a pure
 * power distributes over multiplication, so "multiply the basemap's sRGB
 * pixel by `M^(1/2.2)`" (what the ground pass does to MapLibre's pixels) and
 * "light the building's linear albedo by `M`, then encode" (what the building
 * shader does) give the same colour for the same surface.
 */

export type Rgb = [number, number, number];

/**
 * The sun altitudes (degrees) over which the sky turns to night: none above
 * the first, full below the second. The SAME window as `nightFactor`
 * (`lib/map/landmarks/night.ts`), so the city's lights come on as the sky goes
 * dark; restated rather than imported because that module is loaded by the
 * map adapter's chunk and this one by the engine's, and a module two lazy
 * chunks share is hoisted into the first-paint bundle (`engine3d/lazyChunk.ts`).
 * `__tests__/city3dNight.test.ts` pins the two together.
 */
export const SKY_NIGHT_FADE_DEG: readonly [number, number] = [-1, -9];

/** How much of the night the sky is in, 0…1, for a sun `altitudeDeg` up (time only). */
export function skyNightness(altitudeDeg: number): number {
  const [from, to] = SKY_NIGHT_FADE_DEG;
  const t = Math.max(0, Math.min(1, (altitudeDeg - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** Where the sun is: compass azimuth (clockwise from north) and geometric altitude. */
export interface CitySun {
  azimuthDeg: number;
  altitudeDeg: number;
}

/**
 * The atmosphere's constants, in metres. Earth values from Bruneton's
 * reference implementation (the ones takram's `AtmosphereParameters` default
 * to), except {@link URBAN_AEROSOL}.
 */
export const ATMOSPHERE = {
  groundRadiusM: 6_360_000,
  topRadiusM: 6_460_000,
  /** Rayleigh scattering at sea level, per metre, for red/green/blue (680/550/440 nm). */
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6] as Rgb,
  rayleighScaleHeightM: 8000,
  mieScattering: 3.996e-6,
  mieExtinction: 4.44e-6,
  mieScaleHeightM: 1200,
  /** Mie asymmetry: strongly forward, the bright halo round the sun. */
  mieG: 0.8,
  ozoneAbsorption: [0.65e-6, 1.881e-6, 0.085e-6] as Rgb,
  ozoneCentreM: 25_000,
  ozoneHalfWidthM: 15_000,
  /** The sun's apparent radius. */
  sunAngularRadiusDeg: 0.2667,
} as const;

/**
 * How much denser than Bruneton's clean-air aerosol a city's air is.
 *
 * Bruneton's Mie density is a rural, very clear day (visibility well over
 * 100 km). Urban aerosol optical depth runs roughly 2–5× that on a hazy
 * day; 1.6 is a clear city day, which keeps the horizon blue-white rather
 * than grey. It is the one number here chosen by eye rather than taken
 * from a reference, and it is what makes far blocks recede into a pale haze
 * rather than a blue one.
 */
export const URBAN_AEROSOL = 1.6;

/**
 * Aerial perspective is applied over distances this many times the real ones.
 *
 * 1: the real air. The art direction is a pastel maquette (Apple Maps'
 * detailed city, not a photograph), where haze must never grey the city out:
 * across a street-level view it only softens the far blocks into the pale
 * horizon, and it is the horizon views — tens of kilometres — that it shows
 * at all. Applied to the ground and the buildings alike.
 */
export const AERIAL_DISTANCE_SCALE = 1;

/**
 * The haze's clear near field, metres: aerial perspective starts this far
 * from the camera and builds from there (the air in front of it is taken as
 * clear). The art direction is crisp, saturated near and mid field with haze
 * only toward the horizon; a street-level map view spans 1–3 km, which real
 * air already dims a few per cent — on a pale pastel palette that read as a
 * veil over the whole city (owner preview, Madrid Gran Vía, review of #125).
 * Past this the physics is unchanged, so horizon views still fade into the
 * sky exactly as before.
 */
export const HAZE_CLEAR_M = 1500;

/** The sky table: angle from the sun's azimuth (0…π) across, elevation (0…π/2) down. */
export const SKY_LUT_WIDTH = 48;
export const SKY_LUT_HEIGHT = 32;

/** The altitude a sky table is computed for is rounded to this many degrees. */
export const SKY_ALTITUDE_STEP_DEG = 0.2;

const DEG = Math.PI / 180;

/** Below this, the sun is gone and so are the shadows: `0.5` → `3` degrees. */
const SHADOW_FADE_DEG: readonly [number, number] = [0.5, 3];

/**
 * The adapted brightness of a horizontal surface, by sun altitude: what the
 * eye (or a camera) makes of the light, as a multiplier on the map's colours.
 * Linear in between; `1` is the reference daylight. Light and dark appearance
 * differ only at night, where the dark map is already dark.
 */
const BRIGHTNESS_CURVE: Record<'light' | 'dark', readonly (readonly [number, number])[]> = {
  light: [
    [-18, 0.13],
    [-10, 0.17],
    [-4, 0.36],
    [0, 0.66],
    [6, 0.9],
    [20, 1],
  ],
  dark: [
    [-18, 0.62],
    [-6, 0.78],
    [0, 0.92],
    [6, 0.97],
    [20, 1],
  ],
};

/**
 * The same, for the SKY: how bright the sky itself is drawn. It adapts far
 * less than the ground does — the eye keeps the street readable at dusk, but
 * the sky above it still goes deep blue and then dark. Same units: a
 * multiplier on the exposure that makes the ground {@link BRIGHTNESS_CURVE}.
 */
const SKY_BRIGHTNESS_CURVE: readonly (readonly [number, number])[] = [
  [-18, 0.1],
  [-12, 0.16],
  [-6, 0.4],
  [-2, 0.7],
  [2, 1],
  [12, 1.6],
];

/**
 * How much brighter than single scattering the sky is drawn. Single
 * scattering alone puts a noon zenith at about a tenth of a sunlit white wall;
 * measured skies are a fifth to a quarter (≈ 6,000 vs 30,000 cd/m²). The gap
 * is the higher scattering orders the isotropic term only half covers.
 */
const SKY_GAIN = 3.2;

/**
 * The most the direct sun may be exposed to, relative to the reference
 * daylight. At a low sun the eye adapts to the (dim) horizontal light, which
 * would put a wall facing the sun at nine times the noon white; past this it
 * only clips. The building shader rolls highlights off above 0.8.
 */
const MAX_SUN = 2.4;

/**
 * The night: a fixed, faint, blue ambient (relative to the reference
 * daylight's illuminance), and the sky radiance it comes from. Stylised — a
 * moonless, city-glow-free sky — and deliberately the only light at night.
 */
const NIGHT_AMBIENT: Rgb = [0.0014, 0.0027, 0.0074];

/** The sun as a white source (sRGB's white is daylight's). */
const SUN_IRRADIANCE: Rgb = [1, 1, 1];

/**
 * Isotropic multiple scattering, as a fraction of single scattering's source,
 * and its colour. The higher orders are light the sky has already scattered
 * once — blue — and they are what keeps a single-scattering horizon from
 * coming out green (the long path there removes the blue the first order
 * put in). The tint is the noon zenith's colour, normalised to its blue.
 */
const MULTIPLE_SCATTERING = 0.6;
const MULTIPLE_SCATTERING_TINT: Rgb = [0.3, 0.55, 1];

/** The camera's height for the sky table: the sky from a rooftop. */
const OBSERVER_ALTITUDE_M = 100;

/** Where the reference daylight is measured: a sun 55° up. */
const REFERENCE_ALTITUDE_DEG = 55;

/** Ground bounce: what a wall facing down the street gets back from it. */
const GROUND_ALBEDO = 0.18;

/**
 * Light the surrounding city reflects back into every shadow, as a fraction
 * of the horizontal illuminance. Streets are canyons of lit walls; without
 * this a shadow on a sunny day is the sky alone, about a tenth of the light,
 * which reads as a black hole on a map. The art direction (a matte clay
 * maquette, soft) wants more than a photograph would show — but not so much
 * that the city goes flat: 0.4 left form only in the walls, and with the cool
 * sky term read as a pale veil (owner preview, Madrid, review of #125). At
 * 0.28 a shadow keeps a little under half the light and still reads as shape.
 */
const ENV_BOUNCE = 0.28;

const PRIMARY_STEPS = 20;

/**
 * How dark a full shadow is drawn, at most: 0 none, 1 the ambient alone.
 * Below 1 on purpose — the maquette look keeps shadows as soft, light shapes
 * that say where the sun is, never black slots in the street grid.
 */
export const SHADOW_OPACITY = 0.78;

/**
 * The night sky, as display sRGB: a deep blue-violet, lighter at the horizon.
 * A stylised colour, not a measurement: a moonless sky over a city is a dull
 * orange-grey glow nobody wants on a map, and the art direction asks for the
 * blue-violet of an illustrated night. It takes over from the physical sky
 * through nautical twilight — the same window as `nightFactor`, so the city's
 * lights come on as the sky goes dark ({@link SKY_NIGHT_FADE_DEG}).
 */
const NIGHT_SKY_ZENITH: Rgb = [0x14 / 255, 0x16 / 255, 0x58 / 255];
const NIGHT_SKY_HORIZON: Rgb = [0x27 / 255, 0x30 / 255, 0x8c / 255];

/**
 * A warm light at street level at night, on walls only, fading out over the
 * first {@link STREET_GLOW_HEIGHT_M} metres (`tsl/skyBuildingMaterial.ts`). Linear,
 * relative to the night's adapted brightness.
 *
 * HONESTY (`docs/MAP_3D_CITY.md`): this is lighting, applied to every wall of
 * every building alike — the ambience of lit streets — and says nothing
 * about any one building. No lit windows, no floodlit landmarks, no
 * storefronts: those would be facts about a building the data does not hold.
 */
const STREET_GLOW: Rgb = [0.3, 0.16, 0.06];

/**
 * Floodlighting, on buildings that RECORD being lit at night (OSM `floodlit`
 * or `lit` on the building: `CITY_PROPS.floodlit`): a warm uplight on the
 * walls, brightest at the foot and fading up the facade, with a little on the
 * roof. Linear, exposed units (the night's roofs are ~0.15), scaled by
 * `nightFactor` (`tsl/skyBuildingMaterial.ts`). The fact is the tag; the look of the light
 * — its colour, fall-off and strength — is styling.
 */
export const FLOODLIGHT = {
  color: [1, 0.64, 0.34] as Rgb,
  intensity: 1.6,
  /** What is left of it at the top of the facade, and on a roof. */
  top: 0.3,
  roof: 0.25,
} as const;
export const STREET_GLOW_HEIGHT_M = 14;

// ---------------------------------------------------------------------------
// Geometry and basic optics
// ---------------------------------------------------------------------------

/** The sun's direction as an ENU unit vector (x east, y north, z up). */
export function sunDirection(sun: CitySun): Rgb {
  const az = sun.azimuthDeg * DEG;
  const alt = sun.altitudeDeg * DEG;
  return [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];
}

function rayleighPhase(mu: number): number {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}

function miePhase(mu: number, g: number): number {
  const g2 = g * g;
  return (
    ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu))) / ((2 + g2) * (1 + g2 - 2 * g * mu) ** 1.5)
  );
}

/** Distance along a ray from radius `r` (cosine `mu` to the zenith) to a sphere of radius `R`, or -1. */
function raySphere(r: number, mu: number, sphere: number): number {
  const disc = r * r * (mu * mu - 1) + sphere * sphere;
  if (disc < 0) return -1;
  const root = Math.sqrt(disc);
  const far = -r * mu + root;
  return far < 0 ? -1 : far;
}

/** Whether a ray from radius `r` (cosine `mu` to the zenith) hits the ground. */
function hitsGround(r: number, mu: number): boolean {
  const R = ATMOSPHERE.groundRadiusM;
  return mu < 0 && r * r * (mu * mu - 1) + R * R >= 0;
}

interface Densities {
  rayleigh: number;
  mie: number;
  ozone: number;
}

function densitiesAt(heightM: number): Densities {
  const h = Math.max(0, heightM);
  return {
    rayleigh: Math.exp(-h / ATMOSPHERE.rayleighScaleHeightM),
    mie: Math.exp(-h / ATMOSPHERE.mieScaleHeightM) * URBAN_AEROSOL,
    ozone: Math.max(0, 1 - Math.abs(h - ATMOSPHERE.ozoneCentreM) / ATMOSPHERE.ozoneHalfWidthM),
  };
}

function extinctionAt(d: Densities): Rgb {
  const r = ATMOSPHERE.rayleighScattering;
  const o = ATMOSPHERE.ozoneAbsorption;
  const m = ATMOSPHERE.mieExtinction * d.mie;
  return [
    r[0] * d.rayleigh + m + o[0] * d.ozone,
    r[1] * d.rayleigh + m + o[1] * d.ozone,
    r[2] * d.rayleigh + m + o[2] * d.ozone,
  ];
}

/** Optical depth from radius `r` along cosine `mu` to the top of the atmosphere, ray-marched. */
function marchedTransmittance(r: number, mu: number): Rgb {
  const length = raySphere(r, mu, ATMOSPHERE.topRadiusM);
  if (length <= 0) return [1, 1, 1];
  const steps = 40;
  const dt = length / steps;
  const depth: Rgb = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const ri = Math.sqrt(r * r + t * t + 2 * r * t * mu);
    const e = extinctionAt(densitiesAt(ri - ATMOSPHERE.groundRadiusM));
    depth[0] += e[0] * dt;
    depth[1] += e[1] * dt;
    depth[2] += e[2] * dt;
  }
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

/**
 * Transmittance to the top of the atmosphere, tabulated once over height
 * (square-root spaced: the air is near the ground) and the cosine of the angle
 * to the zenith — Bruneton's transmittance table, in its simplest form. The
 * sky march looks the sun's side up here instead of marching it: forty times
 * fewer exponentials, which is what makes a whole sky a few milliseconds.
 */
const T_HEIGHTS = 32;
const T_MUS = 128;
let transmittanceTable: Float32Array | null = null;

function transmittanceLookup(r: number, mu: number): Rgb {
  if (!transmittanceTable) {
    transmittanceTable = new Float32Array(T_HEIGHTS * T_MUS * 3);
    const span = ATMOSPHERE.topRadiusM - ATMOSPHERE.groundRadiusM;
    for (let j = 0; j < T_HEIGHTS; j++) {
      const h = (j / (T_HEIGHTS - 1)) ** 2 * span;
      for (let i = 0; i < T_MUS; i++) {
        const m = -1 + (2 * i) / (T_MUS - 1);
        const t = marchedTransmittance(ATMOSPHERE.groundRadiusM + h, m);
        transmittanceTable.set(t, (j * T_MUS + i) * 3);
      }
    }
  }
  const span = ATMOSPHERE.topRadiusM - ATMOSPHERE.groundRadiusM;
  const hv = Math.sqrt(Math.max(0, Math.min(1, (r - ATMOSPHERE.groundRadiusM) / span)));
  const fy = hv * (T_HEIGHTS - 1);
  const fx = ((Math.max(-1, Math.min(1, mu)) + 1) / 2) * (T_MUS - 1);
  const y0 = Math.min(T_HEIGHTS - 2, Math.floor(fy));
  const x0 = Math.min(T_MUS - 2, Math.floor(fx));
  const ty = fy - y0;
  const tx = fx - x0;
  const out: Rgb = [0, 0, 0];
  const table = transmittanceTable;
  for (let c = 0; c < 3; c++) {
    const a = table[(y0 * T_MUS + x0) * 3 + c];
    const b = table[(y0 * T_MUS + x0 + 1) * 3 + c];
    const d = table[((y0 + 1) * T_MUS + x0) * 3 + c];
    const e = table[((y0 + 1) * T_MUS + x0 + 1) * 3 + c];
    out[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }
  return out;
}

/**
 * Transmittance from radius `r` towards the sun (cosine `muSun` to the local
 * zenith) to the top of the atmosphere; zero once the earth is in the way,
 * fading over the sun's own diameter rather than snapping.
 */
function transmittanceToSun(r: number, muSun: number): Rgb {
  const R = ATMOSPHERE.groundRadiusM;
  // Cosine of the angle to the geometric horizon at this radius.
  const horizon = -Math.sqrt(Math.max(0, 1 - (R / r) ** 2));
  const radius = ATMOSPHERE.sunAngularRadiusDeg * DEG;
  const visible = smoothstep(horizon - radius, horizon + radius, muSun);
  if (visible <= 0) return [0, 0, 0];
  const t = transmittanceLookup(r, Math.max(muSun, horizon));
  return [t[0] * visible, t[1] * visible, t[2] * visible];
}

/**
 * Sky radiance (single scattering + an isotropic multiple-scattering term)
 * seen from {@link OBSERVER_ALTITUDE_M} looking at `elevation` radians above
 * the horizon, `deltaAzimuth` radians round from the sun, for a sun
 * `sunAltitude` radians up. Relative units: the sun's irradiance is 1.
 */
export function skyRadiance(elevation: number, deltaAzimuth: number, sunAltitude: number): Rgb {
  const R = ATMOSPHERE.groundRadiusM;
  const r0 = R + OBSERVER_ALTITUDE_M;
  // Observer at (0, 0, r0). View direction in the local frame, sun in the
  // x–z plane.
  const view: Rgb = [
    Math.cos(elevation) * Math.cos(deltaAzimuth),
    Math.cos(elevation) * Math.sin(deltaAzimuth),
    Math.sin(elevation),
  ];
  const sun: Rgb = [Math.cos(sunAltitude), 0, Math.sin(sunAltitude)];
  const mu = view[0] * sun[0] + view[1] * sun[1] + view[2] * sun[2];
  const phaseR = rayleighPhase(mu);
  const phaseM = miePhase(mu, ATMOSPHERE.mieG);
  const iso = MULTIPLE_SCATTERING / (4 * Math.PI);

  const groundHit = hitsGround(r0, view[2]);
  const length = groundHit
    ? Math.max(0, -r0 * view[2] - Math.sqrt(Math.max(0, r0 * r0 * (view[2] ** 2 - 1) + R * R)))
    : raySphere(r0, view[2], ATMOSPHERE.topRadiusM);
  if (length <= 0) return [0, 0, 0];

  const out: Rgb = [0, 0, 0];
  const depth: Rgb = [0, 0, 0];
  let previousT = 0;
  for (let i = 0; i < PRIMARY_STEPS; i++) {
    // Quadratic spacing: dense near the eye, where the air is.
    const t = length * ((i + 0.5) / PRIMARY_STEPS) ** 2;
    const tNext = length * ((i + 1) / PRIMARY_STEPS) ** 2;
    const dt = tNext - previousT;
    previousT = tNext;
    const p: Rgb = [view[0] * t, view[1] * t, r0 + view[2] * t];
    const ri = Math.hypot(p[0], p[1], p[2]);
    const d = densitiesAt(ri - R);
    const e = extinctionAt(d);
    depth[0] += e[0] * dt;
    depth[1] += e[1] * dt;
    depth[2] += e[2] * dt;
    const muSun = (p[0] * sun[0] + p[1] * sun[1] + p[2] * sun[2]) / ri;
    const toSun = transmittanceToSun(ri, muSun);
    const rs = ATMOSPHERE.rayleighScattering;
    const ms = ATMOSPHERE.mieScattering * d.mie;
    for (let c = 0; c < 3; c++) {
      const view = Math.exp(-depth[c]);
      const single = (rs[c] * d.rayleigh * phaseR + ms * phaseM) * toSun[c];
      // Higher orders: light the sky has already scattered once — so bluer
      // than the sunlight reaching this air, and as red as it once that
      // sunlight is (the low sun lights the whole sky warm).
      const multiple = (rs[c] * d.rayleigh + ms) * iso * toSun[c] * MULTIPLE_SCATTERING_TINT[c];
      out[c] += view * (single + multiple) * SUN_IRRADIANCE[c] * dt;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aerial perspective (mirrored in TSL by `tsl/skyNodes.ts`)
// ---------------------------------------------------------------------------

/** The per-channel extinction at sea level and its scale heights, as the haze shader takes them. */
export interface HazeCoefficients {
  rayleigh: Rgb;
  rayleighScaleHeightM: number;
  mie: number;
  mieScaleHeightM: number;
}

export const HAZE: HazeCoefficients = {
  rayleigh: ATMOSPHERE.rayleighScattering.map((v) => v * AERIAL_DISTANCE_SCALE) as Rgb,
  rayleighScaleHeightM: ATMOSPHERE.rayleighScaleHeightM,
  mie: ATMOSPHERE.mieExtinction * URBAN_AEROSOL * AERIAL_DISTANCE_SCALE,
  mieScaleHeightM: ATMOSPHERE.mieScaleHeightM,
};

/** `∫₀^d exp(−(h0 + t·dz)/H) dt`, the closed form, stable at `dz → 0`. */
function columnDensity(h0: number, dz: number, d: number, H: number): number {
  const base = Math.exp(-Math.max(0, h0) / H);
  const k = dz / H;
  if (Math.abs(k * d) < 1e-4) return base * d;
  return (base * (1 - Math.exp(-k * d))) / k;
}

/**
 * Transmittance along a view ray from a camera `cameraHeightM` above the
 * ground, with unit direction z-component `dirZ`, over `distanceM`.
 */
export function hazeTransmittance(cameraHeightM: number, dirZ: number, distanceM: number): Rgb {
  // The column from where the haze starts ({@link HAZE_CLEAR_M}) to the target.
  const clear = Math.min(Math.max(0, distanceM), HAZE_CLEAR_M);
  const from = cameraHeightM + dirZ * clear;
  const rest = Math.max(0, distanceM - clear);
  const r = columnDensity(from, dirZ, rest, HAZE.rayleighScaleHeightM);
  const m = columnDensity(from, dirZ, rest, HAZE.mieScaleHeightM);
  return [
    Math.exp(-(HAZE.rayleigh[0] * r + HAZE.mie * m)),
    Math.exp(-(HAZE.rayleigh[1] * r + HAZE.mie * m)),
    Math.exp(-(HAZE.rayleigh[2] * r + HAZE.mie * m)),
  ];
}

// ---------------------------------------------------------------------------
// The state the renderer needs, per sun altitude
// ---------------------------------------------------------------------------

export interface SkyState {
  /** The altitude this was computed for (rounded to {@link SKY_ALTITUDE_STEP_DEG}). */
  altitudeDeg: number;
  /** Direct sun on a surface facing it, already exposed: multiply by `max(n·s, 0)`. Linear. */
  sunColor: Rgb;
  /** Sky (+ night) irradiance on a surface facing up, exposed. Linear. */
  skyAmbient: Rgb;
  /** What a surface facing straight down gets back from the street, exposed. Linear. */
  groundBounce: Rgb;
  /** 0 → 1: how strongly shadows are drawn (they fade out as the sun sets). */
  shadowStrength: number;
  /** The sun disc's colour (display sRGB, may exceed 1 before the shader clamps), 0 below the horizon. */
  sunDisc: Rgb;
  /**
   * The sky table, display sRGB as RGBA bytes, {@link SKY_LUT_WIDTH} ×
   * {@link SKY_LUT_HEIGHT}: `u` is the angle from the sun's azimuth over π,
   * `v` is `sqrt(elevation / (π/2))` (rows denser near the horizon).
   */
  lut: Uint8Array;
  /** The adapted brightness of a horizontal surface (`1` = reference daylight). */
  brightness: number;
  /** The warm street-level light on walls at night, exposed, linear; 0 by day. */
  streetGlow: Rgb;
}

export type SkyAppearance = 'light' | 'dark';

/** Linear interpolation over a sorted `[x, y]` table, clamped at both ends. */
function curve(table: readonly (readonly [number, number])[], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** The adapted brightness of a horizontal surface for a sun `altitudeDeg` up. */
export function adaptedBrightness(altitudeDeg: number, appearance: SkyAppearance): number {
  return curve(BRIGHTNESS_CURVE[appearance], altitudeDeg);
}

/**
 * How far the eye's white balance follows the colour of the light, by day.
 *
 * A golden-hour street is lit mostly by the blue sky (the low sun barely
 * reaches the ground), and exposure alone — which fixes brightness, not
 * colour — turns the whole map blue. The eye, and every camera on auto white
 * balance, partly neutralises the illuminant, which is what leaves the sunlit
 * walls GOLDEN and the shade only cool. Half way is the usual compromise
 * (von Kries adaptation, partial). It fades out through civil twilight: the
 * night is meant to stay blue.
 */
const CHROMATIC_ADAPTATION = 0.55;

/** Per-channel gains (luminance-neutral) that partly neutralise `illuminant`. */
function whiteBalance(illuminant: Rgb, altitudeDeg: number): Rgb {
  const strength = CHROMATIC_ADAPTATION * smoothstep(-6, 0, altitudeDeg);
  const L = luminance(illuminant);
  if (strength <= 0 || L <= 0) return [1, 1, 1];
  const gains = illuminant.map((v) => (Math.max(v, 1e-9) / L) ** -strength) as Rgb;
  // Keep the luminance of the illuminant where the exposure put it.
  const k =
    L / luminance([illuminant[0] * gains[0], illuminant[1] * gains[1], illuminant[2] * gains[2]]);
  return gains.map((g) => g * k) as Rgb;
}

/**
 * How much of its colour the daytime ambient keeps (1: all of it). The shade
 * of a sunny street is lit by the sky AND by every warm wall round it; the
 * sky term alone painted the pastel city's shade and the basemap's shadows a
 * cold blue-grey, which on a light palette reads as a veil (owner preview,
 * Madrid, review of #125). The Apple-like look wants shade that is only a
 * little cooler than light. Fades back to full colour through twilight: the
 * night's blue ambient is the night's look.
 */
const DAY_AMBIENT_SATURATION = 0.4;

/** `c` with its saturation scaled by `amount` about its luminance (luminance kept). */
function desaturate(c: Rgb, amount: number): Rgb {
  const L = luminance(c);
  return c.map((v) => L + (v - L) * amount) as Rgb;
}

/** Rec. 709 luminance. */
export function luminance(c: Rgb): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** ACES filmic (Narkowicz's fit) on one number. */
function aces(x: number): number {
  return Math.max(0, Math.min(1, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
}

/**
 * Tone-map a sky colour — the one HDR thing on screen — keeping its HUE.
 *
 * ACES applied per channel compresses the brightest channel most, and in a
 * sky the brightest channel is blue: a hazy noon horizon came out grey-green.
 * So the curve is applied to the luminance and the colour scaled by it; what
 * still exceeds 1 (the halo round the sun) blends towards white, the way an
 * over-exposed sky does in a photograph.
 */
export function tonemapSky(c: Rgb): Rgb {
  const L = luminance(c);
  if (L <= 0) return [0, 0, 0];
  const k = aces(L) / L;
  const scaled: Rgb = [c[0] * k, c[1] * k, c[2] * k];
  const peak = Math.max(...scaled);
  // Towards white: as soon as a channel would clip, and fully once the light
  // is several times past the curve's knee.
  const white = Math.max(peak > 1 ? 1 - 1 / peak : 0, smoothstep(1, 6, L));
  if (white <= 0) return scaled;
  const norm = Math.max(1, peak);
  return scaled.map((v) => Math.min(1, (v / norm) * (1 - white) + white)) as Rgb;
}

const GAMMA = 2.2;

/** Linear → display, the pure power the whole layer uses (see the header). */
export function encodeGamma(x: number): number {
  return Math.max(0, x) ** (1 / GAMMA);
}

/** LUT row `v` (0…1) → elevation in radians. */
export function lutElevation(v: number): number {
  return v * v * (Math.PI / 2);
}

interface Irradiance {
  /** Direct sun on a surface facing it. */
  sun: Rgb;
  /** Sky on a horizontal surface. */
  sky: Rgb;
}

/** Sun and sky irradiance at the observer, unexposed, for a sun `altitude` radians up. */
function irradianceAt(altitude: number, radiance: (el: number, az: number) => Rgb): Irradiance {
  const R = ATMOSPHERE.groundRadiusM + OBSERVER_ALTITUDE_M;
  const t = transmittanceToSun(R, Math.sin(altitude));
  const sun: Rgb = [SUN_IRRADIANCE[0] * t[0], SUN_IRRADIANCE[1] * t[1], SUN_IRRADIANCE[2] * t[2]];
  // E = ∫ L cos(zenith) dΩ over the upper hemisphere, symmetric about the
  // sun's azimuth: 2 ∫₀^π ∫₀^{π/2} L sin(el) cos(el) d(el) d(az).
  const sky: Rgb = [0, 0, 0];
  const AZ = 12;
  const EL = 8;
  for (let i = 0; i < AZ; i++) {
    const az = ((i + 0.5) / AZ) * Math.PI;
    for (let j = 0; j < EL; j++) {
      const el = ((j + 0.5) / EL) * (Math.PI / 2);
      const L = radiance(el, az);
      const w = 2 * Math.sin(el) * Math.cos(el) * (Math.PI / AZ) * (Math.PI / 2 / EL);
      sky[0] += L[0] * w;
      sky[1] += L[1] * w;
      sky[2] += L[2] * w;
    }
  }
  return { sun, sky };
}

let referenceIlluminance: number | null = null;

/** The horizontal illuminance of the reference daylight, computed once. */
function referenceDaylight(): number {
  if (referenceIlluminance === null) {
    const alt = REFERENCE_ALTITUDE_DEG * DEG;
    const e = irradianceAt(alt, (el, az) => skyRadiance(el, az, alt));
    referenceIlluminance = luminance(e.sun) * Math.sin(alt) + luminance(e.sky);
  }
  return referenceIlluminance;
}

/**
 * Everything the renderer needs for a sun `altitudeDeg` up (azimuth is a
 * rotation the shaders apply), for the map's `appearance`.
 *
 * Pure but not free — a few milliseconds of ray marching — so it is cached per
 * rounded altitude and appearance ({@link skyStateFor}).
 */
export function computeSkyState(altitudeDeg: number, appearance: SkyAppearance): SkyState {
  const altitude = altitudeDeg * DEG;
  const reference = referenceDaylight();

  // The sky table, in linear radiance first: the irradiance integral reads it.
  const W = SKY_LUT_WIDTH;
  const H = SKY_LUT_HEIGHT;
  const linear = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const el = lutElevation((y + 0.5) / H);
    for (let x = 0; x < W; x++) {
      const az = ((x + 0.5) / W) * Math.PI;
      const L = skyRadiance(el, az, altitude);
      const i = (y * W + x) * 3;
      linear[i] = L[0];
      linear[i + 1] = L[1];
      linear[i + 2] = L[2];
    }
  }
  const sampleLut = (el: number, az: number): Rgb => {
    const v = Math.sqrt(Math.max(0, el) / (Math.PI / 2));
    const y = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
    const x = Math.min(W - 1, Math.max(0, Math.floor((az / Math.PI) * W)));
    const i = (y * W + x) * 3;
    return [linear[i], linear[i + 1], linear[i + 2]];
  };

  const irradiance = irradianceAt(altitude, sampleLut);
  const night: Rgb = NIGHT_AMBIENT.map((v) => v * reference) as Rgb;
  const sinAlt = Math.max(0, Math.sin(altitude));
  const direct: Rgb = irradiance.sun.map((v) => v * sinAlt) as Rgb;
  const sky: Rgb = [0, 1, 2].map((c) => irradiance.sky[c] * SKY_GAIN + night[c]) as Rgb;
  // At night the bounce fades to a tenth: a lit street's walls bounce light
  // around, a dark one's do not — and it is what keeps walls darker than
  // roofs, the value contrast the night look needs to read as 3D.
  const bounce = ENV_BOUNCE * (1 - 0.9 * skyNightness(altitudeDeg));
  const env: Rgb = [0, 1, 2].map((c) => bounce * (direct[c] + sky[c])) as Rgb;
  const horizontal: Rgb = [0, 1, 2].map((c) => direct[c] + sky[c] + env[c]) as Rgb;

  // Eye adaptation: the colour is the physics', the brightness the curve's.
  const brightness = adaptedBrightness(altitudeDeg, appearance);
  const exposure = brightness / Math.max(luminance(horizontal), 1e-9);
  // ...and partly the colour too: chromatic adaptation towards the light that
  // falls on the ground (see CHROMATIC_ADAPTATION).
  const balance = whiteBalance(horizontal, altitudeDeg);

  const sunRaw = irradiance.sun.map((v, c) => v * exposure * balance[c]) as Rgb;
  const sunScale = Math.min(1, MAX_SUN / Math.max(1e-9, ...sunRaw));
  const sunColor = sunRaw.map((v) => v * sunScale) as Rgb;
  // By day the ambient keeps only part of the sky's blue (DAY_AMBIENT_SATURATION).
  const ambientSaturation =
    DAY_AMBIENT_SATURATION + (1 - DAY_AMBIENT_SATURATION) * skyNightness(altitudeDeg);
  const skyAmbient = desaturate(
    [0, 1, 2].map((c) => (sky[c] + env[c]) * exposure * balance[c]) as Rgb,
    ambientSaturation,
  );
  const groundBounce = desaturate(
    [0, 1, 2].map((c) => (GROUND_ALBEDO * horizontal[c] + env[c]) * exposure * balance[c]) as Rgb,
    ambientSaturation,
  );

  // The sky's display colour: as if the sky were a white surface lit by
  // πL·gain, under the sky's own (less adaptive) exposure, then tone-mapped
  // (the halo round the sun is far over 1). The night sky is the night
  // ambient spread over the hemisphere, a touch lighter at the horizon.
  const skyExposure = exposure * curve(SKY_BRIGHTNESS_CURVE, altitudeDeg);
  // Time only: the sky is the sky whatever the theme (`nightFactor` adds the
  // appearance for the lights that read it).
  const nightness = skyNightness(altitudeDeg);
  const lut = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const el = lutElevation((y + 0.5) / H);
    const nightGradient = 1.35 - 0.6 * Math.sin(el);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const o = (y * W + x) * 4;
      const L = [0, 1, 2].map(
        (c) => (linear[i + c] * Math.PI * SKY_GAIN + night[c] * nightGradient) * skyExposure,
      ) as Rgb;
      const display = tonemapSky(L).map(encodeGamma) as Rgb;
      // Through nautical twilight the stylised night sky takes over.
      const t = Math.sin(el) ** 0.6;
      for (let c = 0; c < 3; c++) {
        const styled = NIGHT_SKY_HORIZON[c] + (NIGHT_SKY_ZENITH[c] - NIGHT_SKY_HORIZON[c]) * t;
        const v = display[c] + (styled - display[c]) * nightness;
        lut[o + c] = Math.round(Math.max(0, Math.min(1, v)) * 255);
      }
      lut[o + 3] = 255;
    }
  }

  // The disc: the sun's transmitted colour, bright enough to clip to white
  // high up and to stay orange when low. Display units; the shader clamps.
  const discScale = 6;
  const sunDisc = irradiance.sun.map((v) => encodeGamma(v * exposure * discScale)) as Rgb;

  return {
    altitudeDeg,
    sunColor,
    skyAmbient,
    groundBounce,
    shadowStrength:
      SHADOW_OPACITY * smoothstep(SHADOW_FADE_DEG[0], SHADOW_FADE_DEG[1], altitudeDeg),
    sunDisc,
    lut,
    brightness,
    streetGlow: STREET_GLOW.map((v) => v * brightness * nightness) as Rgb,
  };
}

/** MapLibre's own sky colours, as `#rrggbb`: what the host's `sky` should say. */
export interface HostSkyColours {
  sky: string;
  horizon: string;
  fog: string;
}

/**
 * The host map's own sky colours for a sky table (`SkyState.lut`): the
 * zenith, the horizon and the fog, each averaged round the compass. MapLibre
 * draws its own `sky` behind everything and blends its `fog-color` into
 * distant 3D terrain (`terrain.fragment.glsl`) — after this layer, where the
 * terrain is drawn a second time for the layers above it. Left at another
 * module's colours, that fog painted a pale band over the city sky's night
 * (review after #128, terrain on by default); given these, the two skies
 * agree and the band is the horizon's own colour.
 */
export function hostSkyColours(lut: Uint8Array): HostSkyColours {
  const row = (y: number) => {
    const sum = [0, 0, 0];
    for (let x = 0; x < SKY_LUT_WIDTH; x++) {
      const o = (y * SKY_LUT_WIDTH + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] += lut[o + c];
    }
    return sum.map((v) => Math.round(v / SKY_LUT_WIDTH));
  };
  const hex = (rgb: number[]) =>
    `#${rgb.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
  const horizon = row(0);
  const low = row(Math.min(SKY_LUT_HEIGHT - 1, 3));
  return {
    sky: hex(row(SKY_LUT_HEIGHT - 1)),
    horizon: hex(low),
    fog: hex(horizon),
  };
}

/** Round an altitude to the step the cache keys on. */
export function quantizeAltitude(altitudeDeg: number): number {
  const q = Math.round(altitudeDeg / SKY_ALTITUDE_STEP_DEG) * SKY_ALTITUDE_STEP_DEG;
  return Math.max(-90, Math.min(90, Number(q.toFixed(3))));
}

const CACHE_LIMIT = 48;
const cache = new Map<string, SkyState>();

/**
 * {@link computeSkyState}, cached by rounded altitude and appearance. A scrub
 * across a day visits each rounded altitude once; panning visits none.
 */
export function skyStateFor(altitudeDeg: number, appearance: SkyAppearance): SkyState {
  const altitude = quantizeAltitude(altitudeDeg);
  const key = `${appearance}:${altitude}`;
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const state = computeSkyState(altitude, appearance);
  cache.set(key, state);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return state;
}
