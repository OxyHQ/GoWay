/**
 * The instanced-tree material in TSL (`docs/MAP_NATIVE_3D.md`): every tree is
 * one instance of a shared unit tree (`treeGeometry.ts`), placed, turned,
 * sized and tinted here from four 16-bit numbers (`trees.ts` →
 * `TreeInstances`), so a wood costs the CPU nothing per frame.
 *
 * The look is a maquette's — matte, soft, no highlight — lit as the buildings
 * are (MapLibre's `fill-extrusion` light, `common.ts`), with a gentle canopy
 * occlusion and a faint contact shadow under each tree. A few tint, width and
 * lean variants come from the seed, so a wood is not a field of clones.
 *
 * One material (and its dithered variant) serves every tile: a tile's stored
 * unit (`uUnitM`) and its fade are read per mesh (`userData`), as the
 * buildings' fade is. Branches of the old GLSL are selects here: every lane is
 * computed and the part chooses, which costs a tree's few vertices nothing.
 */
import { MeshBasicNodeMaterial, type Side, type Vector3 } from 'three/webgpu';
import {
  attribute,
  clamp,
  cos,
  float,
  floor,
  fract,
  length,
  min,
  mix,
  mod,
  normalize,
  select,
  sin,
  smoothstep,
  varying,
  vec3,
  vec4,
} from 'three/tsl';

import { AO } from '../occlusion';
import { CANOPY, SHADOW, SHADOW_RADIUS, STEM } from '../treeGeometry';
import { KIND_CONIFER, KIND_PALM, KIND_WOOD } from '../trees';
import {
  bindFloat,
  bindVec3,
  dithered,
  extrusionLit,
  mapBlending,
  perObject,
  opaque,
  terrainLift,
  type UniformRef,
} from './common';

/** How dark the contact shadow is at its centre (alpha over the ground). */
export const TREE_SHADOW_ALPHA = 0.22;

/**
 * The height below which trees are not drawn, metres, at a zoom: the tallest
 * trees show first as the map zooms in, all of them from zoom 18 (the
 * exploretrees / Apple Maps rule, eased: trees grow in over 3 m, never pop).
 * The engine writes it to `uTreeMinHeight` every frame; tested.
 */
export function treeMinHeightM(zoom: number): number {
  return Math.max(0, Math.min(1, (18 - zoom) / 2.5)) * 10;
}

/** Where a tree mesh carries its tile's metres per stored unit. */
export const TREE_UNIT_USERDATA_KEY = 'unitM';

/** The engine's tree uniforms, by the names the GLSL material used. */
export interface TreeUniformRefs {
  uCrown: UniformRef<Vector3>;
  uConifer: UniformRef<Vector3>;
  uTrunk: UniformRef<Vector3>;
  uTreeMinHeight: UniformRef<number>;
  uLightPosition: UniformRef<Vector3>;
  uLightIntensity: UniformRef<number>;
  uLightColor: UniformRef<Vector3>;
  uGrounded: UniformRef<number>;
}

export interface TreeMaterials {
  /** The shared tree material, settled or dithered (built on first use). */
  get(dithered: boolean): MeshBasicNodeMaterial;
  /**
   * Rebuild every variant's programs on their next draw: a mesh's geometry
   * gained an attribute the material reads only where present (the terrain
   * lift, `common.ts` → `terrainLift`). three re-checks a drawn mesh's program
   * only when its material's version moves, so without this a mesh drawn
   * before its tile was grounded keeps a program with no lift — and stands
   * at z = 0, under the terrain.
   */
  invalidate(): void;
  dispose(): void;
}

export function createTreeMaterials(refs: TreeUniformRefs, side: Side): TreeMaterials {
  const u = {
    uCrown: bindVec3(refs.uCrown),
    uConifer: bindVec3(refs.uConifer),
    uTrunk: bindVec3(refs.uTrunk),
    uTreeMinHeight: bindFloat(refs.uTreeMinHeight),
    uLightPosition: bindVec3(refs.uLightPosition),
    uLightIntensity: bindFloat(refs.uLightIntensity),
    uLightColor: bindVec3(refs.uLightColor),
    uGrounded: bindFloat(refs.uGrounded),
  };
  const built = new Map<boolean, MeshBasicNodeMaterial>();
  return {
    get(isDithered) {
      let material = built.get(isDithered);
      if (!material) {
        material = buildMaterial(u, side, isDithered);
        built.set(isDithered, material);
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
  u: {
    uCrown: ReturnType<typeof bindVec3>;
    uConifer: ReturnType<typeof bindVec3>;
    uTrunk: ReturnType<typeof bindVec3>;
    uTreeMinHeight: ReturnType<typeof bindFloat>;
    uLightPosition: ReturnType<typeof bindVec3>;
    uLightIntensity: ReturnType<typeof bindFloat>;
    uLightColor: ReturnType<typeof bindVec3>;
    uGrounded: ReturnType<typeof bindFloat>;
  },
  side: Side,
  isDithered: boolean,
): MeshBasicNodeMaterial {
  const unitM = perObject(TREE_UNIT_USERDATA_KEY, (value) => value as number, 1);

  // --- Vertex: place one instance of the unit tree ---------------------------
  const position = attribute('position', 'vec3');
  const normal = attribute('normal', 'vec3');
  // 0 trunk, 1 canopy, 2 contact shadow (treeGeometry.ts).
  const part = attribute('part', 'float');
  // x, y (tile units, y southward), seed, kind × 256 + height in half metres.
  const tree = attribute('aTree', 'vec4');
  const seed = tree.z.div(65536);
  const kind = floor(tree.w.div(256));
  const height = tree.w.sub(kind.mul(256)).mul(0.5);
  const conifer = mod(floor(kind.div(KIND_CONIFER)), 2);
  const palm = mod(floor(kind.div(KIND_PALM)), 2);
  const wood = mod(kind, KIND_WOOD * 2);
  const yaw = seed.mul(6.2831853);
  // Canopies vary in width as well as height.
  const width = float(0.86).add(fract(seed.mul(7.31)).mul(0.3));
  const c = cos(yaw);
  const s = sin(yaw);
  const isCanopy = part.greaterThan(CANOPY - 0.5).and(part.lessThan(CANOPY + 0.5));
  const scaleXY = select(isCanopy, width, float(1));
  // A slight curve: the trunk leans away from vertical toward its top, and
  // the canopy rides on it. Palms lean more. (The shadow does not lean.)
  const lean = select(palm.greaterThan(0.5), float(0.12), float(0.04)).mul(
    float(0.4).add(fract(seed.mul(3.17)).mul(0.6)),
  );
  const t = min(1, position.z.div(STEM.top));
  const leanX = select(part.lessThan(CANOPY + 0.5), lean.mul(t).mul(t), float(0));
  const px = position.x.mul(scaleXY).add(leanX);
  const py = position.y.mul(scaleXY);
  const nx = normal.x.div(scaleXY);
  const ny = normal.y.div(scaleXY);
  // Shorter than the zoom's threshold: shrink away over 3 m, then vanish.
  const grow = smoothstep(u.uTreeMinHeight.sub(1.5), u.uTreeMinHeight.add(1.5), height);
  const local = vec3(c.mul(px).sub(s.mul(py)), s.mul(px).add(c.mul(py)), position.z).mul(
    height.mul(grow),
  );
  const vNormal = varying(vec3(c.mul(nx).sub(s.mul(ny)), s.mul(nx).add(c.mul(ny)), normal.z));
  const vPart = varying(part);
  const vHeight = varying(local.z);
  // 0 at the canopy's foot, 1 at its top: the gentle top-lit gradient.
  const vCrown = varying(clamp(position.z.sub(0.2).div(0.8), 0, 1));
  const vRadial = varying(length(position.xy).div(SHADOW_RADIUS));
  // A few tint variants: lighter or darker, a touch warmer or cooler; woods a
  // shade deeper than park trees.
  const shade = select(wood.greaterThan(0.5), float(0.92), float(1)).mul(
    float(0.9).add(fract(seed.mul(13.7)).mul(0.2)),
  );
  const warmth = fract(seed.mul(5.31)).sub(0.5);
  const vTint = varying(
    vec3(warmth.mul(0.04).add(1), warmth.mul(0.02).add(1), float(1).sub(warmth.mul(0.05))).mul(
      shade,
    ),
  );
  const vConifer = varying(conifer.add(palm.mul(2)));
  const base3 = vec3(
    tree.x.mul(unitM),
    tree.y.negate().mul(unitM),
    terrainLift('aGround', u.uGrounded),
  );

  // --- Fragment --------------------------------------------------------------
  const n = normalize(vNormal);
  const canopy = vPart.greaterThan(CANOPY - 0.5);
  // vConifer: 0 broadleaf, 1 conifer, 2 palm (a lighter, warmer green).
  const canopyColour = select(
    vConifer.greaterThan(1.5),
    u.uCrown.mul(vec3(1.06, 1.05, 0.86)),
    select(vConifer.greaterThan(0.5), u.uConifer, u.uCrown),
  );
  const surface = select(canopy, canopyColour.mul(vTint), u.uTrunk);
  // Soft occlusion: a canopy's underside sees less sky and its crown more; a
  // trunk is mostly in its canopy's shade, darkest at the ground.
  const occlusion = select(
    canopy,
    mix(float(AO.groundMin + 0.1), 1, smoothstep(-0.6, 0.55, n.z)).mul(mix(0.9, 1.05, vCrown)),
    float(AO.groundMin).add(smoothstep(0, 3, vHeight).mul(0.2)),
  );
  const lit = opaque(extrusionLit(surface, n, occlusion, u));
  // The contact shadow: premultiplied black, fading to nothing at its rim.
  const shadowAlpha = float(TREE_SHADOW_ALPHA).mul(float(1).sub(smoothstep(0.15, 1, vRadial)));
  const color = select(vPart.greaterThan(SHADOW - 0.5), vec4(vec3(0), shadowAlpha), lit);

  const material = mapBlending(new MeshBasicNodeMaterial());
  material.positionNode = base3.add(local);
  material.colorNode = isDithered ? dithered(color) : color;
  material.side = side;
  return material;
}
