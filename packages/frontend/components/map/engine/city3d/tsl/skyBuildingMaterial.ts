/**
 * The buildings under the city sky, in TSL: the sky's light inputs, its
 * shadow map and its haze, and a MATERIAL RESPONSE composed with them in one
 * shader (`docs/MAP_NATIVE_3D.md` → Phase 2). It replaced the GLSL sky
 * material term for term.
 *
 * ## The one shading path's contract
 *
 * Ownership (lead decision): the sky owns the light INPUTS, the art direction
 * owns the MATERIAL RESPONSE, and they compose in a single shader:
 *
 *  - {@link CitySurface}: what is being lit — from the tiles;
 *  - {@link CitySkyLight}: what lights it — from the sky;
 *  - {@link CityMaterialResponse}: `(surface, light) → linear lit colour`,
 *    ending with `rolloff` (`detailedMaterial.ts`). The default is matte clay
 *    ({@link clayResponse}); the detailed look is `detailedMaterial.ts`.
 *
 * Gamma, haze and opacity are applied after the response, here, so the haze
 * stays the sky's and identical on every material.
 *
 * Like the map-lit buildings (`buildingMaterial.ts`): one material per format
 * and variant, shared by every tile, on the engine's uniforms; a tile's fade
 * is read per mesh.
 */
import { MeshBasicNodeMaterial, type Node, type Side } from 'three/webgpu';
import {
  abs,
  attribute,
  float,
  floor,
  max,
  mix,
  mod,
  modelWorldMatrix,
  normalize,
  smoothstep,
  step,
  varying,
  vec3,
  vec4,
} from 'three/tsl';

import { FLOODLIGHT, STREET_GLOW_HEIGHT_M } from '../atmosphere';
import { AO } from '../occlusion';
import { Z_UNITS_PER_METRE } from '../packing';
import type { CityTileFormat } from '../protocol';
import { cityTileSurface, rampAt, temperedTag } from './buildingSurface';
import type { BuildingUniforms } from './buildingMaterial';
import { dithered, type Float, mapBlending, premultiplied, terrainLift, type Vec3 } from './common';
import { rolloff } from './detailedMaterial';
import type { SkyNodes } from './skyNodes';

type Vec4 = Node<'vec4'>;

/** What is being lit — from the tiles. */
export interface CitySurface {
  /** Linear base colour (ramp / tagged / tinted). */
  albedo: Vec3;
  /** ENU, unit. */
  normal: Vec3;
  /** Baked occlusion, ground × corner (0…1). */
  ao: Float;
  /** The corner term alone. */
  cornerAo: Float;
  /** Metres. */
  heightAboveGround: Float;
  /** Metres (the ramp's input, capped). */
  buildingHeight: Float;
  /** ENU metres from the map centre. */
  world: Vec3;
  /** `osmMesher.ts` `facade` (0 on OpenMapTiles). */
  facade: Vec4;
  /** `osmMesher.ts` `colors` (0 on OpenMapTiles). */
  color: Vec4;
  /** `osmMesher.ts` `flags` (0 on OpenMapTiles). */
  flags: Float;
}

/** What lights it — from the sky. */
export interface CitySkyLight {
  /** ENU, unit, the real sun. */
  sunDir: Vec3;
  /** Direct sun, exposed (multiply by n·l). */
  sun: Vec3;
  /** The shadow map: 1 lit … 0 shadowed (soft). */
  sunVisibility: Float;
  /** Sky irradiance on a surface facing up. */
  skyUp: Vec3;
  /** Bounce on a surface facing down. */
  skyDown: Vec3;
  /** Street glow + floodlights, already shaped. */
  emitted: Vec3;
  /** `lib/map/landmarks/night.ts`. */
  nightFactor: Float;
}

/** The art direction's half: a surface under a light → linear lit colour. */
export type CityMaterialResponse = (surface: CitySurface, light: CitySkyLight) => Vec3;

/**
 * The default response: matte clay — sun × shadow (a little occluded), a
 * hemisphere of sky and bounce (occluded), and what the scene emits.
 */
export const clayResponse: CityMaterialResponse = (s, l) => {
  const facing = max(s.normal.dot(l.sunDir), 0);
  const hemisphere = mix(l.skyDown, l.skyUp, s.normal.z.mul(0.5).add(0.5));
  const light = l.sun
    .mul(facing)
    .mul(l.sunVisibility)
    .mul(mix(1, s.ao, 0.35))
    .add(hemisphere.mul(s.ao))
    .add(l.emitted);
  return rolloff(s.albedo.mul(light));
};

/** The detailed look's surface tint (`detailedMaterial.ts` → `surface`), when it is on. */
export type DetailedSurface = (ramp: Vec3, tagged: Vec3, color: Vec4) => Vec3;

export interface SkyBuildingMaterials {
  get(format: CityTileFormat, dithered: boolean): MeshBasicNodeMaterial;
  /** As `BuildingMaterials.invalidate`: a mesh gained the terrain lift. */
  invalidate(): void;
  dispose(): void;
}

export function createSkyBuildingMaterials(options: {
  uniforms: BuildingUniforms;
  sky: SkyNodes;
  response: CityMaterialResponse;
  /** The detailed look's tint; absent, city tiles keep the classic surface and its openings. */
  detailedSurface?: DetailedSurface;
  side: Side;
}): SkyBuildingMaterials {
  const built = new Map<string, MeshBasicNodeMaterial>();
  return {
    get(format, isDithered) {
      const key = `${format}:${isDithered}`;
      let material = built.get(key);
      if (!material) {
        material = buildMaterial(format, isDithered, options);
        built.set(key, material);
      }
      return material;
    },
    invalidate() {
      for (const material of built.values()) material.needsUpdate = true;
    },
    dispose() {
      for (const material of built.values()) material.dispose();
      built.clear();
    },
  };
}

function buildMaterial(
  format: CityTileFormat,
  isDithered: boolean,
  options: Parameters<typeof createSkyBuildingMaterials>[0],
): MeshBasicNodeMaterial {
  const { uniforms: u, sky, response, detailedSurface, side } = options;
  const osm = format === 'goway';

  // --- Vertex: the compact lanes (packing.ts), as the map-lit material reads them.
  const position = attribute('position', 'vec4');
  const normal = attribute('normal', 'vec4');
  const tone = floor(position.w.div(256));
  const vCornerAo = varying(position.w.sub(tone.mul(256)).div(255));
  const vHeightAboveGround = varying(position.z.mul(1 / Z_UNITS_PER_METRE));
  const vBuildingHeight = varying(tone);
  const vNormal = varying(normal.xyz);
  // The lift is metres; stored z is 1/32 m, scaled back by the model matrix.
  const local = vec3(
    position.xy,
    position.z.add(terrainLift('ground', u.uGrounded, Z_UNITS_PER_METRE)),
  );
  const world = modelWorldMatrix.mul(vec4(local, 1)).xyz;
  const vWorld = varying(sky.enu(world));
  // The shadow lookup starts a texel out along the normal (ENU → mercator: y
  // flips), in mercator, where the model matrix's anisotropic units are gone:
  // keeps a wall from shadowing itself.
  const offset = vec3(normal.x, normal.y.negate(), normal.z).mul(
    sky.shadowNormalOffset.div(sky.metresPerMercator),
  );
  const vShadow = varying(sky.shadowMatrix.mul(vec4(world.add(offset), 1)));
  // The per-building flags ride in the normal's spare lane (`packing.ts`).
  const vFlags = varying(floor(normal.w.mul(127).add(0.5)));
  const vColor = osm ? varying(attribute('color', 'vec4')) : vec4(0);
  const vFacade = osm ? varying(attribute('facade', 'vec4')) : vec4(0);

  // --- Fragment ---------------------------------------------------------------
  const n = normalize(vNormal);
  const ramped = rampAt(u, vBuildingHeight);
  // The surface colour, exactly as the map-lit material has it (or the
  // detailed look's tint, whose windows are its response's).
  const base = !osm
    ? ramped
    : detailedSurface
      ? detailedSurface(ramped, temperedTag(u, ramped, vColor), vColor)
      : cityTileSurface(u, ramped, n, vHeightAboveGround, vColor, vFacade);
  const albedo = base.pow(2.2);
  const groundAo = float(AO.groundMin).add(
    float(1 - AO.groundMin).mul(smoothstep(0, AO.groundReachM, vHeightAboveGround)),
  );
  const ao = groundAo.mul(vCornerAo);
  const flags = osm ? vFlags : float(0);

  // The light inputs — the sky's side of the contract. Warm street-level
  // light on the walls' foot at night (atmosphere.ts → STREET_GLOW).
  const street = float(1)
    .sub(abs(n.z))
    .mul(float(1).sub(smoothstep(0, STREET_GLOW_HEIGHT_M, vHeightAboveGround)));
  let emitted: Vec3 = sky.streetGlow.mul(street);
  if (osm) {
    // Floodlights on buildings that record being lit (atmosphere.ts → FLOODLIGHT).
    const floodlit = mod(flags, 2).mul(sky.nightFactor);
    const rise = vHeightAboveGround.div(max(vBuildingHeight, 4)).clamp(0, 1);
    const onWall = mix(1, FLOODLIGHT.top, rise);
    const shape = mix(onWall, FLOODLIGHT.roof, step(0.7, abs(n.z)));
    emitted = emitted.add(
      vec3(...FLOODLIGHT.color)
        .mul(FLOODLIGHT.intensity)
        .mul(floodlit)
        .mul(shape)
        .mul(mix(1, ao, 0.5)),
    );
  }

  const surface: CitySurface = {
    albedo,
    normal: n,
    ao,
    cornerAo: vCornerAo,
    heightAboveGround: vHeightAboveGround,
    buildingHeight: vBuildingHeight,
    world: vWorld,
    facade: vFacade,
    color: vColor,
    flags,
  };
  const light: CitySkyLight = {
    sunDir: sky.sunDir,
    sun: sky.sunColor,
    sunVisibility: sky.sunVisibility(vShadow),
    skyUp: sky.skyAmbient,
    skyDown: sky.groundBounce,
    emitted,
    nightFactor: sky.nightFactor,
  };
  const lit = max(response(surface, light), vec3(0)).pow(1 / 2.2);
  // Aerial perspective, the same as the ground pass's.
  const color = premultiplied(sky.aerial(lit, vWorld), u.uOpacity);

  const material = mapBlending(new MeshBasicNodeMaterial());
  material.positionNode = local;
  material.colorNode = isDithered ? dithered(color) : color;
  material.side = side;
  return material;
}
