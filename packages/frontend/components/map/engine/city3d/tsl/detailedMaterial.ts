/**
 * The DETAILED city material in TSL (`materials.ts` holds the design, the
 * palette numbers' meaning and the JS mirrors the tests pin): matte clay by
 * day, moonlit blue-grey with warm windows by night, its facade relief and
 * windows only where `building:levels` is RECORDED. It is the response half of
 * the sky's one shading path (`skyBuildingMaterial.ts` → `CityMaterialResponse`)
 * and the per-building tint of the surface it starts from.
 *
 * Every parameter has a day and a night uniform (`materials.ts` →
 * `materialUniformValues`), blended here by the engine's one night seam.
 *
 * Written for WGSL's rules: the one derivative (`fwidth` of the storey grid)
 * is taken before any branch, and the facade's relief is computed only where
 * a storey rhythm shows — a branch with no derivative or texture read in it,
 * which WGSL allows anywhere.
 */
import type { Node } from 'three/webgpu';
import {
  abs,
  array,
  clamp,
  cross,
  dot,
  float,
  floor,
  Fn,
  fract,
  fwidth,
  If,
  int,
  max,
  min,
  mix,
  normalize,
  select,
  sign,
  smoothstep,
  step,
  exp,
  uint,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { FACADE } from '../facades';
import {
  FACADE_STYLES,
  MATERIAL_FLOAT_STEMS,
  MATERIAL_VEC3_STEMS,
  OPENING_AREA,
} from '../materials';
import { TAG_TEMPER } from './buildingSurface';
import { type Float, luma, type Vec3 } from './common';
import type { CityMaterialResponse, CitySkyLight, CitySurface } from './skyBuildingMaterial';

type Vec4 = Node<'vec4'>;
type UInt = Node<'uint'>;

/** The material at this frame's night factor: every field, day and night blended. */
export interface DetailedMat {
  glass: Vec3;
  windowGlow: Vec3;
  windowGlowCool: Vec3;
  albedoScale: Vec3;
  wrap: Float;
  aoGround: Float;
  aoReach: Float;
  aoCorner: Float;
  heightGradient: Float;
  edge: Float;
  tintLightness: Float;
  tintHue: Float;
  tagBlend: Float;
  tagSaturation: Float;
  skyFillGain: Float;
  skyFillChroma: Float;
  skySunGain: Float;
  windowStrength: Float;
  windowLitShare: Float;
}

const lower = (stem: string) => stem[0].toLowerCase() + stem.slice(1);

/** The palette's sRGB colours in the sky's linear light. */
const linear = (c: Vec3): Vec3 => max(c, vec3(0)).pow(2.2);

/** pcg3d (Jarzynski & Olano 2020): integer hash, identical on every GPU; 3 values in [0, 1]. */
export function pcgHash3(x: UInt, y: UInt, z: UInt): Vec3 {
  const k = uint(1664525);
  const c0 = uint(1013904223);
  let a = x.mul(k).add(c0);
  let b = y.mul(k).add(c0);
  let c = z.mul(k).add(c0);
  a = a.add(b.mul(c));
  b = b.add(c.mul(a));
  c = c.add(a.mul(b));
  a = a.bitXor(a.shiftRight(uint(16)));
  b = b.bitXor(b.shiftRight(uint(16)));
  c = c.bitXor(c.shiftRight(uint(16)));
  a = a.add(b.mul(c));
  b = b.add(c.mul(a));
  c = c.add(a.mul(b));
  return vec3(float(a), float(b), float(c)).mul(1 / 4294967295);
}

/** 1 on walls, 0 on roofs. */
const wallness = (n: Vec3): Float => float(1).sub(smoothstep(0.3, 0.6, abs(n.z)));

/** The derivative in x of `smoothstep(e0, e1, x)`: the relief's analytic slope. */
export function stepD(e0: Float | number, e1: Float | number, x: Float): Float {
  const lo = typeof e0 === 'number' ? float(e0) : e0;
  const width = (typeof e1 === 'number' ? float(e1) : e1).sub(lo);
  const t = clamp(x.sub(lo).div(width), 0, 1);
  return t.mul(float(1).sub(t)).mul(6).div(width);
}

/** What the facade does to a fragment (see `materials.ts` → the facade). */
interface Facade {
  normal: Vec3;
  shade: Float;
  albedo: Float;
  open: Float;
  far: Float;
  cell: [UInt, UInt, UInt];
}

// Per class (`materials.ts` → FACADE_STYLES; index = the flags' use, 0 unknown).
// (three's types lose the element type of a constant array.)
type Vec4Table = { element(index: Node<'int'>): Vec4 };
const OPENINGS = array(FACADE_STYLES.map((f) => vec4(...f.opening))) as unknown as Vec4Table;
const RELIEFS = array(FACADE_STYLES.map((f) => vec4(...f.relief))) as unknown as Vec4Table;

/** The facade's per-class tables as the shader holds them (for the tests). */
export const FACADE_TABLES = { openings: OPENINGS, reliefs: RELIEFS } as unknown as {
  openings: Node;
  reliefs: Node;
};

/**
 * The building's seed for the window hash, from the two bytes the mesher put
 * in an untagged surface's colour (`osmMesher.ts` → `withSeed`). ROUNDED, never
 * truncated: the colour arrives interpolated, 37/255 reading as 36.9999 on one
 * pixel and 37.0001 on the next, and a truncated seed gave one window two
 * draws of lit/unlit — speckle (seen at night in Eixample).
 */
export function buildingSeedOf(color: Vec4): UInt {
  return uint(color.r.mul(255).add(0.5)).add(uint(color.g.mul(255).add(0.5)).mul(uint(256)));
}

function facadeOf(facade: Vec4, color: Vec4, flags: Float, h: Float, n: Vec3): Facade {
  const storey = max(facade.z.div(100), 0.5);
  const levels = facade.w;
  const level = h.sub(facade.y.div(10)).div(storey);
  const bay = facade.x.div(256);
  // The only screen derivatives, taken before any branch.
  const fw = max(fwidth(vec2(bay, level)), vec2(1e-4));
  const valid = step(0.5, levels)
    .mul(float(1).sub(step(0.3, abs(n.z))))
    .mul(step(0, level))
    .mul(float(1).sub(step(levels, level)));
  const widest = max(fw.x, fw.y);
  // The window grid: gone once a storey is a few pixels tall.
  const detail = float(1)
    .sub(smoothstep(0.12, 0.3, widest))
    .mul(valid);
  // The relief, closer still: full from ~30 px a storey, gone by ~14 px.
  const near = float(1)
    .sub(smoothstep(0.035, 0.07, widest))
    .mul(valid);

  const normal = n.toVar();
  const shade = float(1).toVar();
  const albedo = float(1).toVar();
  const open = float(0).toVar();
  const cellX = uint(0).toVar();
  const cellY = uint(0).toVar();
  const cellZ = buildingSeedOf(color);

  // Everything below is paid only by a near wall with recorded storeys.
  If(detail.greaterThan(0), () => {
    const f = int(flags.add(0.5));
    const anyUse = f.shiftRight(int(1)).bitAnd(int(7));
    const lastUse = int(FACADE_STYLES.length - 1);
    const use = select(anyUse.greaterThan(lastUse), lastUse, anyUse);
    const era = f.shiftRight(int(4)).bitAnd(int(3));
    const o0 = OPENINGS.element(use);
    const r0 = RELIEFS.element(use);
    // Era: historic narrower openings and heavier cornices; early modern piers
    // (the 1920s-30s verticality); modern wider openings, flat and light.
    const e1 = era.equal(int(1));
    const e2 = era.equal(int(2));
    const e3 = era.equal(int(3));
    const ox0 = select(e1, o0.x.mul(0.85), select(e3, min(o0.x.mul(1.25), 0.42), o0.x));
    const ow = select(
      e1,
      max(o0.w, 0.12),
      select(e2, max(o0.w, 0.22), select(e3, o0.w.mul(0.3), o0.w)),
    );
    const ry = select(e1, r0.y.mul(1.4), select(e3, r0.y.mul(0.4), r0.y));

    const fr = vec2(fract(bay), fract(level));
    const groundFloor = level.lessThan(1).and(levels.greaterThanEqual(3));
    const sill = select(groundFloor, float(0.12), o0.y);
    const head = select(groundFloor, float(0.84), o0.z);
    const ox = abs(fr.x.sub(0.5));
    const side = sign(fr.x.sub(0.5));
    const ex = max(0.025, fw.x);
    const ey = max(0.025, fw.y);
    const inX = float(1).sub(smoothstep(ox0.sub(ex), ox0.add(ex), ox));
    const lo = smoothstep(sill.sub(ey), sill.add(ey), fr.y);
    const hi = float(1).sub(smoothstep(head.sub(ey), head.add(ey), fr.y));
    const opening = inX.mul(lo).mul(hi);
    open.assign(opening.mul(detail));
    cellX.assign(uint(max(floor(bay), 0)));
    cellY.assign(uint(max(floor(level), 0)));

    // The relief: a height field over the wall and its ANALYTIC slope along
    // the wall (u, metres) and up it (v = h). Zero where `near` is.
    const pierD = stepD(ox0.add(0.06), ox0.add(0.13), ox).mul(side);
    const inXD = stepD(ox0.sub(ex), ox0.add(ex), ox).mul(side).negate();
    const yD = stepD(sill.sub(ey), sill.add(ey), fr.y)
      .mul(hi)
      .sub(lo.mul(stepD(head.sub(ey), head.add(ey), fr.y)));
    const belowEaves = levels.sub(level).mul(storey);
    const corniceD = select(ry.greaterThan(0), stepD(0.3, 0.6, belowEaves), float(0));
    const aboveGround = level.sub(1).mul(storey);
    const courseD = select(
      levels.greaterThanEqual(3),
      stepD(-0.32, -0.22, aboveGround)
        .mul(float(1).sub(smoothstep(-0.04, 0.02, aboveGround)))
        .sub(smoothstep(-0.32, -0.22, aboveGround).mul(stepD(-0.04, 0.02, aboveGround))),
      float(0),
    );
    const g = clamp(
      vec2(
        ow.mul(pierD).sub(r0.x.mul(inXD).mul(lo).mul(hi)).div(FACADE.bayM),
        r0.x.negate().mul(inX).mul(yD).div(storey).add(ry.mul(corniceD)).add(r0.w.mul(courseD)),
      ).mul(near),
      vec2(-1.5),
      vec2(1.5),
    );
    const along = normalize(cross(vec3(0, 0, 1), n).add(vec3(1e-6, 0, 0)));
    normal.assign(normalize(n.sub(along.mul(g.x)).sub(vec3(0, 0, 1).mul(g.y))));

    // A recess is shaded, most under its head; a thin frame is a little
    // lighter; the ground floor sits on a slightly darker plinth.
    const frame = max(
      float(1)
        .sub(smoothstep(ox0.add(0.05).sub(ex), ox0.add(0.05).add(ex), ox))
        .mul(smoothstep(sill.sub(0.07).sub(ey), sill.sub(0.07).add(ey), fr.y))
        .mul(float(1).sub(smoothstep(head.add(0.06).sub(ey), head.add(0.06).add(ey), fr.y)))
        .sub(opening),
      0,
    );
    shade.assign(
      float(1).sub(near.mul(opening).mul(float(0.18).add(smoothstep(sill, head, fr.y).mul(0.22)))),
    );
    albedo.assign(
      float(1)
        .add(frame.mul(near).mul(0.07))
        .mul(select(groundFloor, float(1).sub(r0.z.mul(near)), float(1))),
    );
  });

  return { normal, shade, albedo, open, far: valid.sub(detail), cell: [cellX, cellY, cellZ] };
}

/**
 * The detailed material for its day and night values (`materials.ts` →
 * `materialUniformValues`), blended by the engine's one night seam. The
 * values are fixed for an engine's life (`cityMaterials()`), so they are the
 * shader's constants — no uniform to update per draw; only the blend moves.
 */
export function createDetailedMaterial(
  values: Record<string, number | readonly number[]>,
  nightFactor: Float,
) {
  const t = clamp(nightFactor, 0, 1);
  const fields: Record<string, Vec3 | Float> = {};
  for (const stem of MATERIAL_VEC3_STEMS) {
    const day = values[`uMat${stem}`] as readonly number[];
    const night = values[`uMat${stem}Night`] as readonly number[];
    fields[lower(stem)] = mix(vec3(day[0], day[1], day[2]), vec3(night[0], night[1], night[2]), t);
  }
  for (const stem of MATERIAL_FLOAT_STEMS) {
    fields[lower(stem)] = mix(
      float(values[`uMat${stem}`] as number),
      float(values[`uMat${stem}Night`] as number),
      t,
    );
  }
  const m = fields as unknown as DetailedMat;

  /**
   * The detailed look's surface (`buildingSurface.ts` → the tempered tag):
   * the tag clamped to a lightness hint and a per-building tint. An untagged
   * surface carries the building's seed in its unused rgb (`osmMesher.ts` →
   * `withSeed`); a tagged one varies by its own colour. No openings: the
   * windows are the response's.
   */
  const surface = (ramp: Vec3, tagged: Vec3, color: Vec4): Vec3 => {
    const seeded = color.a.lessThan(0.002);
    const v = select(seeded, color.r, fract(luma(color.rgb).mul(7)));
    const v2 = select(seeded, color.g, fract(color.b.mul(5)));
    const albedo = mix(
      ramp,
      mix(vec3(luma(tagged)), tagged, m.tagSaturation),
      color.a.mul(TAG_TEMPER.blend).mul(m.tagBlend),
    );
    const warm = vec3(m.tintHue.add(1), 1, float(1).sub(m.tintHue));
    const cool = vec3(float(1).sub(m.tintHue), 1, m.tintHue.add(1));
    return albedo.mul(v.sub(0.5).mul(2).mul(m.tintLightness).add(1)).mul(mix(cool, warm, v2));
  };

  // A shader function: the facade's branch needs one around it.
  const response: CityMaterialResponse = (s: CitySurface, l: CitySkyLight): Vec3 =>
    Fn(() => respond(s, l))() as unknown as Vec3;
  const respond = (s: CitySurface, l: CitySkyLight): Vec3 => {
    const n = s.normal;
    // The facade's relief bends the normal the light sees (n stays the
    // wall's, for what is wall and what is roof).
    const fc = facadeOf(s.facade, s.color, s.flags, s.heightAboveGround, n);
    const r = fc.normal;
    const albedo = s.albedo.mul(linear(m.albedoScale)).mul(fc.albedo);
    // The sky's hemisphere, answered with some of its hue and a gain.
    const hemisphere = mix(l.skyDown, l.skyUp, r.z.mul(0.5).add(0.5));
    const fill = mix(vec3(luma(hemisphere)), hemisphere, m.skyFillChroma).mul(m.skyFillGain);
    // Contact and corner occlusion and the wall gradient.
    const wall = wallness(n);
    const contact = float(1).sub(
      m.aoGround.mul(float(1).sub(smoothstep(0, m.aoReach, s.heightAboveGround))).mul(wall),
    );
    const corner = mix(1, s.cornerAo, m.aoCorner);
    const gradient = float(1).sub(
      m.heightGradient
        .mul(float(1).sub(clamp(s.heightAboveGround.div(max(s.buildingHeight, 3)), 0, 1)))
        .mul(wall),
    );
    const occlusion = contact.mul(corner).mul(gradient).mul(fc.shade);
    // Wrap diffuse toward the sun: the terminator is soft.
    const wrap = clamp(dot(r, normalize(l.sunDir)).add(m.wrap).div(m.wrap.add(1)), 0, 1);
    const sun = l.sun.mul(m.skySunGain).mul(wrap).mul(l.sunVisibility);
    const light = sun.add(fill).mul(occlusion);
    // 1 on the 45° roof bevel, fading out toward flat and vertical faces.
    const chamfer = smoothstep(0.35, 0.6, n.z).mul(float(1).sub(smoothstep(0.85, 0.97, n.z)));
    let lit = albedo.mul(light.add(l.emitted)).add(fill.mul(m.edge.mul(chamfer)));
    // Glass and glow over the lit colour (linear, as is light).
    lit = mix(lit, linear(m.glass).mul(light), fc.open.mul(m.windowStrength));
    const h = pcgHash3(fc.cell[0], fc.cell[1], fc.cell[2]);
    const on = step(float(1).sub(m.windowLitShare), h.x);
    const glow = linear(m.windowGlow);
    lit = lit.add(
      mix(glow, linear(m.windowGlowCool), h.y.mul(h.y))
        .mul(h.z.mul(0.28).add(0.72))
        .mul(on.mul(fc.open)),
    );
    lit = lit.add(glow.mul(m.windowLitShare.mul(OPENING_AREA * 0.8 * 0.86)).mul(fc.far));
    return rolloff(lit);
  };

  return { mat: m, surface, response };
}

/**
 * Highlights roll off above 0.8 instead of clipping (a wall facing a low
 * sun). Every material response ends with it, so none restates it.
 */
export function rolloff(x: Vec3): Vec3 {
  const soft = vec3(0.8).add(
    vec3(1)
      .sub(exp(x.sub(0.8).div(0.2).negate()))
      .mul(0.2),
  );
  return mix(x, soft, step(vec3(0.8), x));
}
