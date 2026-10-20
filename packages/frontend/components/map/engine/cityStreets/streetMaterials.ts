/**
 * The street surfaces and markings in TSL (`docs/MAP_NATIVE_3D.md` → Phase 2),
 * drawn by the city engine's renderer, the same look the GLSL had.
 * Without the city sky they are unlit, like the basemap they cover; under it
 * they are lit and hazed exactly as the sky's ground pass lights the basemap
 * (`tsl/skyPasses.ts`: sun × shadow + sky, `^1/2.2`, then haze), so the
 * streets take the buildings' shadows.
 *
 * One material per kind serves every tile. Its fine-detail visibility is
 * read per mesh from `userData[STREET_TILE_USERDATA_KEY]`.
 *
 * - **Shared geometry**: absolute vertex heights are baked from the terrain
 *   source, adaptively refined, and also used by vehicle contact.
 * - **Physical separation**: asphalt, kerbs and paint have actual heights,
 *   without camera-dependent displacement of surface depth.
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
  Fn,
  fract,
  fwidth,
  int,
  length,
  max,
  mix,
  modelViewMatrix,
  modelWorldMatrix,
  screenCoordinate,
  select,
  smoothstep,
  texture,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { mapBlending, perObject } from '../city3d/tsl/common';
import type { SkyNodes } from '../city3d/tsl/skyNodes';
import { MIN_HALF_PX, STREET_LIFT_M } from './meshBuffers';
import { ATLAS_SIZE, SDF_EDGE } from './streetAtlas';

/** Where a street mesh carries its tile (`StreetTile`). */
export const STREET_TILE_USERDATA_KEY = 'streetTile';

/** A street mesh's tile, read per mesh by the shared materials. */
export interface StreetTile {
  /** Arrows, words and names: 0 … 1 with the effective zoom. */
  detail: number;
}

/** The overlay's shared values the materials read on every render. */
export interface StreetMaterialInputs {
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
  const detail = tileValue((t) => t.detail, 0);
  const sky = inputs.sky ?? null;
  const night = sky ? sky.nightFactor : uniform(0).onRenderUpdate(() => inputs.nightFactor());
  const fade = uniform(1).onRenderUpdate(() => inputs.fade());
  // `projectionMatrix[3][3]` scales the anchor's w as the GLSL did.
  const pxPerM = uniform(1).onRenderUpdate(
    ({ camera }) => inputs.pxPerM() * (camera?.projectionMatrix.elements[15] ?? 0),
  );
  // Absolute elevations are baked once into the mesh from the shared ground
  // source. Contact, shadows and drawing read these exact same vertices.
  const onGround = (p: Node<'vec3'>) => vec4(p.xy, p.z.add(STREET_LIFT_M), 1);
  const place = (p: Node<'vec3'>) => cameraProjectionMatrix.mul(modelViewMatrix).mul(onGround(p));

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
    const position = attribute('position', 'vec3');
    // material, shade, depth layer, —
    const attr = attribute('attr', 'vec4');
    surfaces.vertexNode = place(position);
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
    const position = attribute('position', 'vec3');
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
    markings.vertexNode = place(p);
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
    // Paint and asphalt have different triangle edges on sloping terrain.
    // Use slope-aware decal offset in addition to the layer ordering, so a
    // bus/cycle tint cannot disappear into its own carriageway between vertices.
    markings.polygonOffset = true;
    markings.polygonOffsetFactor = -1;
    markings.polygonOffsetUnits = -1;
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
