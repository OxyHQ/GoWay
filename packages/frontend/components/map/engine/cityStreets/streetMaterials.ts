/**
 * The street surfaces and markings in TSL (`docs/MAP_NATIVE_3D.md` → Phase 2),
 * drawn by the city engine's renderer, the same look the GLSL had.
 * Without the city sky they are unlit, like the basemap they cover; under it
 * they are lit and hazed exactly as the sky's ground pass lights the basemap
 * (`tsl/skyPasses.ts`: sun × shadow + sky, `^1/2.2`, then haze), so the
 * streets take the buildings' shadows.
 *
 * One material per kind serves every tile: a mesh's tile — its ground slot
 * (`groundAtlas.ts`), size, whether it is grounded and how much of its fine
 * detail shows — is read per mesh from `userData[STREET_TILE_USERDATA_KEY]`.
 *
 * - **On the drawn ground**: each vertex reads its tile's ground — MapLibre's
 *   terrain facets, raised by their twist — from the atlas, lifted `STREET_LIFT_M`.
 *   Every piece is cut to one facet, so every layer lies on the same plane.
 * - **No z-fighting**: coplanar layers are nudged toward the camera in clip
 *   space (`depthBias` × layer × w), a per-vertex polygon offset.
 * - **Lines never vanish**: a painted line thinner than a pixel is drawn a
 *   pixel wide at proportionally less alpha (`MIN_HALF_PX`), anti-aliased
 *   by its own across-coordinate; arrows and letters are SDF.
 * - **Day and night are two palettes**, blended by the night factor.
 */
import {
  CustomBlending,
  DoubleSide,
  MeshBasicNodeMaterial,
  type Node,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type Texture,
  type Vector3,
} from 'three/webgpu';
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  clamp,
  Discard,
  dot,
  float,
  floor,
  Fn,
  fract,
  fwidth,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  modelViewMatrix,
  modelWorldMatrix,
  screenCoordinate,
  select,
  smoothstep,
  texture,
  textureLoad,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { mapBlending, perObject } from '../city3d/tsl/common';
import type { SkyNodes } from '../city3d/tsl/skyNodes';
import { STREET_GROUND_MARGIN } from '../city3d/terrainGround';
import { MIN_HALF_PX, STREET_LIFT_M, STREET_Z_PER_M } from './meshBuffers';
import { ATLAS_SIZE, SDF_EDGE } from './streetAtlas';

/** Where a street mesh carries its tile (`StreetTile`). */
export const STREET_TILE_USERDATA_KEY = 'streetTile';

/** A street mesh's tile, read per mesh by the shared materials. */
export interface StreetTile {
  /** Its slot in the ground atlas. */
  slot: number;
  /** 1 while its slot holds its ground; 0 on a flat map. */
  grounded: number;
  tileSizeM: number;
  /** Arrows, words and names: 0 … 1 with the effective zoom. */
  detail: number;
}

/** The overlay's shared values the materials read on every render. */
export interface StreetMaterialInputs {
  groundAtlas: Texture;
  /**
   * Squares a side of MapLibre's terrain mesh on a street tile (128): the
   * facets the street stands on and its meshes were cut to (`terrainGround.ts`
   * → `facetAt`).
   */
  groundMeshCells: number;
  sdfAtlas: Texture;
  surfaceDay: Vector3[];
  surfaceNight: Vector3[];
  paintDay: Vector3[];
  paintNight: Vector3[];
  /** Live reads (the overlay's frame values). */
  nightFactor: () => number;
  fade: () => number;
  /** Device pixels per metre at the screen centre. */
  pxPerM: () => number;
  depthBias: number;
  /** The city sky's light inputs; `null` or absent: unlit. Its night factor replaces `nightFactor`. */
  sky?: SkyNodes | null;
}

export interface StreetMaterials {
  surfaces: MeshBasicNodeMaterial;
  markings: MeshBasicNodeMaterial;
  dispose(): void;
}

/** A palette as a uniform array of colours, indexed in the shader (three's types lose the element type). */
const vec3Array = (values: Vector3[]) =>
  uniformArray(values, 'vec3') as unknown as { element(index: Node<'int'>): Node<'vec3'> };

const tileValue = (read: (tile: StreetTile) => number, fallback: number) =>
  perObject(STREET_TILE_USERDATA_KEY, (tile) => read(tile as StreetTile), fallback);

export function createStreetMaterials(inputs: StreetMaterialInputs): StreetMaterials {
  const slot = tileValue((t) => t.slot, 0);
  const grounded = tileValue((t) => t.grounded, 0);
  const tileSize = tileValue((t) => t.tileSizeM, 1);
  const detail = tileValue((t) => t.detail, 0);
  const sky = inputs.sky ?? null;
  const night = sky ? sky.nightFactor : uniform(0).onRenderUpdate(() => inputs.nightFactor());
  const fade = uniform(1).onRenderUpdate(() => inputs.fade());
  // `projectionMatrix[3][3]` scales the anchor's w as the GLSL did.
  const pxPerM = uniform(1).onRenderUpdate(
    ({ camera }) => inputs.pxPerM() * (camera?.projectionMatrix.elements[15] ?? 0),
  );
  const depthBias = float(inputs.depthBias);

  // The ground the street stands on (`terrainGround.ts` → `streetGround`,
  // `streetGroundAt`, line for line): MapLibre's terrain mesh on this tile as
  // a terrain tile, each corner raised by the most a finer terrain tile rises
  // above it nearby, read facet-wise — each square two flat triangles split
  // north-west to south-east, as MapLibre splits them. Every street piece
  // lies inside one of them (`groundLattice.ts`), so every layer of the
  // street lies on the same flat facet: the paint stays on the asphalt, and
  // both above the terrain.
  const meshCells = inputs.groundMeshCells;
  const size = meshCells + 1 + 2 * STREET_GROUND_MARGIN;
  const groundAt = (p: Node<'vec2'>) =>
    Fn(() => {
      const mesh = clamp(
        vec2(p.x, p.y.negate()).div(tileSize).mul(meshCells).add(STREET_GROUND_MARGIN),
        0,
        size - 1,
      );
      const corner = min(floor(mesh), vec2(size - 2));
      const f = mesh.sub(corner);
      const i = ivec2(corner);
      const layer = int(slot);
      const at = (dx: number, dy: number) =>
        textureLoad(inputs.groundAtlas, i.add(ivec2(dx, dy))).depth(layer).r;
      const tl = at(0, 0);
      const tr = at(1, 0);
      const bl = at(0, 1);
      const br = at(1, 1);
      const h = select(
        f.y.greaterThanEqual(f.x),
        tl.add(bl.sub(tl).mul(f.y)).add(br.sub(bl).mul(f.x)),
        tl.add(tr.sub(tl).mul(f.x)).add(br.sub(tr).mul(f.y)),
      );
      return select(grounded.greaterThan(0.5), h, float(0));
    })();

  /** On the ground, in model space. */
  const onGround = (p: Node<'vec3'>) => vec4(p.xy, p.z.add(groundAt(p.xy)).add(STREET_LIFT_M), 1);

  /** On the ground, in clip space, nudged toward the camera by its layer. */
  const place = (p: Node<'vec3'>, layer: Node<'float'>) => {
    const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(onGround(p));
    return vec4(clip.xy, clip.z.sub(layer.add(1).mul(depthBias).mul(clip.w)), clip.w);
  };

  /**
   * The day and night palettes, blended — and under the sky, lit as the
   * ground pass lights the basemap and seen through the haze. `p` is the
   * vertex (the same one `place` puts on the ground).
   */
  const shadeAt = (p: Node<'vec3'>) => {
    if (!sky) {
      return (day: Node<'vec3'>, nightColour: Node<'vec3'>) =>
        mix(day, nightColour, clamp(night, 0, 1));
    }
    const world = modelWorldMatrix.mul(onGround(p));
    const vWorld = varying(sky.enu(world.xyz));
    const vShadow = varying(sky.shadowMatrix.mul(world));
    return (day: Node<'vec3'>, nightColour: Node<'vec3'>) => {
      const albedo = mix(day, nightColour, clamp(night, 0, 1));
      return sky.aerial(albedo.mul(sky.groundLight(sky.sunVisibility(vShadow))), vWorld);
    };
  };

  // --- Surfaces: paving, asphalt, tints ---------------------------------------
  const surfaces = mapBlending(new MeshBasicNodeMaterial());
  {
    // material, shade, depth layer, height above the ground (mm)
    const attr = attribute('attr', 'vec4');
    const position = vec3(attribute('position', 'vec2'), attr.w.div(STREET_Z_PER_M));
    surfaces.vertexNode = place(position, attr.z);
    const shade = shadeAt(position);
    const vMaterial = varying(attr.x);
    const vShade = varying(attr.y.div(255));
    const day = vec3Array(inputs.surfaceDay);
    const nightColours = vec3Array(inputs.surfaceNight);
    surfaces.colorNode = Fn(() => {
      // Fading in with zoom: a screen door, so depth stays exact.
      const noise = fract(
        fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189),
      );
      Discard(noise.greaterThanEqual(fade));
      const m = int(vMaterial.add(0.5));
      return vec4(shade(day.element(m), nightColours.element(m)).mul(vShade), 1);
    })();
    surfaces.side = DoubleSide;
  }

  // --- Markings: lines, crossings, arrows, words, names ------------------------
  const markings = new MeshBasicNodeMaterial();
  {
    // On the ground: a marking has no height of its own.
    const position = vec3(attribute('position', 'vec2'), 0);
    const offset = attribute('offset', 'vec2');
    const uv = attribute('uv', 'vec2');
    // colour, mode (0 flat, 1 line, 2 sdf), depth layer, —
    const attr = attribute('attr', 'vec4');
    const mode = attr.y;
    const isLine = mode.greaterThan(0.5).and(mode.lessThan(1.5));
    // A line: as wide as recorded, or a pixel and fainter; padded a pixel for its edge.
    const anchor = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(position, 1));
    const halfPx = length(offset).mul(pxPerM.div(max(anchor.w, 1e-9)));
    const widen = max(1, float(MIN_HALF_PX).div(max(halfPx, 1e-6)));
    const lineHalfPx = halfPx.mul(widen);
    const pad = lineHalfPx.add(1).div(lineHalfPx);
    const p = vec3(
      select(isLine, position.xy.add(offset.mul(widen).mul(pad)), position.xy),
      position.z,
    );
    markings.vertexNode = place(p, attr.z);
    const shade = shadeAt(p);
    const vColour = varying(attr.x);
    const vMode = varying(mode);
    const vUv = varying(select(isLine, vec2(uv.x.mul(pad), 0), uv));
    const vHalfPx = varying(select(isLine, lineHalfPx, float(1)));
    const vCoverage = varying(select(isLine, float(1).div(widen), float(1)));
    const day = vec3Array(inputs.paintDay);
    const nightColours = vec3Array(inputs.paintNight);
    markings.colorNode = Fn(() => {
      const line = clamp(float(1).sub(abs(vUv.x)).mul(vHalfPx).add(0.5), 0, 1).mul(vCoverage);
      const d = texture(inputs.sdfAtlas, vUv.div(ATLAS_SIZE)).r;
      const w = max(fwidth(d).mul(0.7), 1 / 255);
      const sdf = smoothstep(float(SDF_EDGE).sub(w), float(SDF_EDGE).add(w), d).mul(detail);
      const alpha = select(vMode.lessThan(0.5), float(0.85), select(vMode.lessThan(1.5), line, sdf))
        .mul(fade)
        .mul(0.92);
      Discard(alpha.lessThanEqual(0.002));
      const c = int(vColour.add(0.5));
      return vec4(shade(day.element(c), nightColours.element(c)).mul(alpha), alpha);
    })();
    markings.side = DoubleSide;
    // One pass: three draws a transparent double-sided material twice (back
    // faces, then front) unless told not to, and a flat marking is only ever
    // one of the two from any view — the second draw would draw nothing.
    markings.forceSinglePass = true;
    markings.transparent = true;
    markings.depthWrite = false;
    markings.blending = CustomBlending;
    markings.blendSrc = OneFactor;
    markings.blendDst = OneMinusSrcAlphaFactor;
  }

  return {
    surfaces,
    markings,
    dispose() {
      surfaces.dispose();
      markings.dispose();
    },
  };
}
