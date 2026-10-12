/**
 * The city-life materials, TSL (`docs/MAP_NATIVE_3D.md` → Phase 2), drawn by
 * the city engine's TSL pass.
 *
 * Positions are NOT uploaded per frame. The simulation streams two states per
 * agent — the previous step and the latest — as instanced attributes, and the
 * vertex stage places each instance between them by the fraction of a step the
 * frame is at. So a 20 Hz simulation draws at the display's rate with no
 * per-frame CPU work beyond a few uniforms.
 *
 * ## Level of detail, decided per instance on the GPU
 *
 * Every model is drawn twice — its near level (a library car's kit body,
 * ~900–1,050 triangles; a person 252) and its far level (36) — over the SAME
 * instance buffers. Each instance's anchor is projected and its on-screen size
 * estimated: the centre's pixels per metre scaled by depth (clip `w` against
 * the centre's, which is the projection's `[3][3]` because the frame is
 * centre-relative). Under {@link LOD_MIN_PX} it collapses in the near mesh and
 * draws in the far one, and vice versa. No CPU sort, no second buffer.
 *
 * ## The look
 *
 * The shared model library's vehicles (`../vehicles/`, read with its nodes,
 * `vehicles/libraryNodes.ts`): the kits' fixed colours, the body in the
 * simulation's soft pastel paint; and city life's own rounded people
 * (`people.ts`). Matte maquette lighting — a gentle hemisphere fill (sky
 * above, warm ground bounce below) under the map's own sun (`CityLight`, the
 * same as the buildings) — and a soft contact-shadow blob under every vehicle
 * and person, so they sit on the street instead of floating over it.
 *
 * People's legs swing about the hip with the distance they moved between the
 * two states, at their own phase; a person waiting at a kerb stands, swaying
 * slightly. On 3D terrain each agent stands on the ground the buildings and
 * trees do (`aGround`).
 *
 * What a model is (person or vehicle, taxi or not, which level) is decided
 * when its material is built: each material is the one branch it needs.
 */
import {
  BackSide,
  CustomBlending,
  DoubleSide,
  MeshBasicNodeMaterial,
  type Node,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type Vector3,
} from 'three/webgpu';
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  clamp,
  cos,
  distance,
  dot,
  float,
  floor,
  fract,
  max,
  mix,
  modelViewMatrix,
  normalize,
  pow,
  select,
  sin,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

import { mapBlending } from '../city3d/tsl/common';
import { libraryColour, libraryFrame } from '../vehicles/libraryNodes';
import { PERSON_HIP_M, PERSON_PART } from './people';

type Float = Node<'float'>;
type Vec2 = Node<'vec2'>;
type Vec3 = Node<'vec3'>;

/** An instance is drawn in detail only while it is at least this many CSS pixels long. */
export const LOD_MIN_PX = 22;

/** The overlay's values, read on every render. */
export interface LifeFrame {
  /** The fraction of a step the frame is at, 0–1. */
  alpha: () => number;
  /** Seconds, for the walk. */
  time: () => number;
  /** Seconds per simulation step. */
  step: number;
  /** CSS pixels per metre at the view centre. */
  pxPerM: () => number;
  /** A taxi's door colour, sRGB (the simulation's). */
  taxiDoors: Vector3;
}

/** The map's light (`CityLight`), live. */
export interface LifeLight {
  position: Vector3;
  intensity: () => number;
  color: Vector3;
}

/** One model, as its materials need it. */
export interface LifeModel {
  person: boolean;
  taxi: boolean;
  /** A taxi's door band, metres above the ground: [sills, waist]. */
  doorBand: [number, number];
  /** Cars: a style length of 1 is this many metres; the model is `modelLength` long. */
  maxLength: number;
  modelLength: number;
  /** The model's size for the detail test, metres. */
  nearSize: number;
  /** The contact shadow's footprint half-extents, metres, and its darkness. */
  shadowHalfSize: [number, number];
  shadowStrength: number;
}

/**
 * The frame's and the light's uniforms, ONE set for every city-life material:
 * a node shared by many materials updates once per render, not once each.
 */
const uniformsOf = new WeakMap<LifeFrame, ReturnType<typeof makeUniforms>>();
function makeUniforms(frame: LifeFrame) {
  return {
    alpha: uniform(0).onRenderUpdate(() => frame.alpha()),
    time: uniform(0).onRenderUpdate(() => frame.time()),
    // Pixels per metre at the centre, times the projection's [3][3].
    pxPerM: uniform(1).onRenderUpdate(
      ({ camera }) => frame.pxPerM() * (camera?.projectionMatrix.elements[15] ?? 0),
    ),
    taxiDoors: uniform(frame.taxiDoors),
  };
}
function shared(frame: LifeFrame) {
  let found = uniformsOf.get(frame);
  if (!found) {
    found = makeUniforms(frame);
    uniformsOf.set(frame, found);
  }
  return found;
}
const lightUniformsOf = new WeakMap<LifeLight, ReturnType<typeof makeLightUniforms>>();
function makeLightUniforms(light: LifeLight) {
  return {
    position: uniform(light.position),
    color: uniform(light.color),
    intensity: uniform(0.5).onRenderUpdate(() => light.intensity()),
  };
}
function sharedLight(light: LifeLight) {
  let found = lightUniformsOf.get(light);
  if (!found) {
    found = makeLightUniforms(light);
    lightUniformsOf.set(light, found);
  }
  return found;
}

/** `x mod y` as GLSL defines it (`x − y·floor(x/y)`), whatever the backend's `%`. */
const glslMod = (x: Float, y: number): Float => x.sub(floor(x.div(y)).mul(y));

/** Where an instance stands this frame, which way it faces, and its scale. */
function place(frame: LifeFrame, model: LifeModel, lod: 0 | 1 | 2) {
  const prev = attribute('aPrev', 'vec4');
  const curr = attribute('aCurr', 'vec4');
  const ground = attribute('aGround', 'float');
  const { alpha } = shared(frame);
  // A slot re-used by a new agent, or one that just appeared: no sweep across the map.
  const fresh = prev.w.equal(0).or(distance(prev.xy, curr.xy).greaterThan(40));
  const at: Vec2 = select(fresh, curr.xy, mix(prev.xy, curr.xy, alpha));
  const turn = glslMod(curr.z.sub(prev.z).add(Math.PI), 2 * Math.PI).sub(Math.PI);
  const heading: Float = select(fresh, curr.z, prev.z.add(turn.mul(alpha)));
  let scale: Float = mix(prev.w, curr.w, alpha);
  if (lod < 2) {
    const anchor = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(at, ground, 1));
    // Pixels per metre here: the centre's, scaled by depth (clip w).
    const { pxPerM } = shared(frame);
    const px = pxPerM.div(max(anchor.w, 1e-9)).mul(model.nearSize);
    // Off screen (past the frustum's sides, or behind the camera) is never
    // near: a pitched view has many agents just below its bottom edge.
    const reach = anchor.w.mul(1.15);
    const onScreen = anchor.w
      .greaterThan(0)
      .and(abs(anchor.x).lessThan(reach))
      .and(abs(anchor.y).lessThan(reach));
    const near = onScreen.and(px.greaterThanEqual(LOD_MIN_PX));
    scale = lod === 0 ? select(near, scale, float(0)) : select(near, float(0), scale);
  }
  return { prev, curr, ground, fresh, at, heading, scale };
}

/** `local` turned by `heading` and stood at `at` on the ground. */
function toWorld(local: Vec3, at: Vec2, heading: Float, z: Float): Vec3 {
  const c = cos(heading);
  const s = sin(heading);
  return vec3(
    at.x.add(c.mul(local.x)).sub(s.mul(local.y)),
    at.y.add(s.mul(local.x)).add(c.mul(local.y)),
    z,
  );
}

/** Blend as MapLibre blends custom layers: premultiplied. */
function premultipliedBlending<T extends MeshBasicNodeMaterial>(material: T): T {
  material.blending = CustomBlending;
  material.blendSrc = OneFactor;
  material.blendDst = OneMinusSrcAlphaFactor;
  return material;
}

const SKIN = [
  [0.96, 0.84, 0.74],
  [0.89, 0.73, 0.6],
  [0.76, 0.57, 0.42],
  [0.55, 0.39, 0.28],
  [0.38, 0.27, 0.2],
] as const;

/** One of five skin tones, by a pick in [0, 1). */
function skinTone(pick: Float): Vec3 {
  let tone: Vec3 = vec3(...SKIN[4]);
  for (let i = 3; i >= 0; i--) tone = select(pick.lessThan((i + 1) * 0.2), vec3(...SKIN[i]), tone);
  return tone;
}

/** A model's body at one level of detail (`lod` 0 near, 1 far). */
export function lifeBodyMaterial(
  frame: LifeFrame,
  light: LifeLight,
  model: LifeModel,
  lod: 0 | 1,
): MeshBasicNodeMaterial {
  const p = place(frame, model, lod);
  const style = attribute('aStyle', 'vec4');
  const position = attribute('position', 'vec3');
  const normal = attribute('normal', 'vec3');
  let local: Vec3;
  let n: Vec3;
  let colour: Vec3;
  let gloss: Float = float(0);
  if (model.person) {
    const { time } = shared(frame);
    const part = attribute('part', 'float');
    // Legs swing with the pace moved between the two states; someone waiting
    // at a kerb stands, swaying a little. Each person has their own phase.
    const speed = select(p.fresh, float(0), distance(p.prev.xy, p.curr.xy).div(frame.step));
    const gait = clamp(speed.div(1.3), 0, 1);
    const phase = style.w.mul(6.2831);
    const isLeg = part
      .greaterThan(PERSON_PART.legLeft - 0.5)
      .and(part.lessThan(PERSON_PART.legRight + 0.5));
    const side = select(part.lessThan(PERSON_PART.legLeft + 0.5), float(1), float(-1));
    const swing = side
      .mul(sin(time.mul(2 * Math.PI * 1.7).add(phase)))
      .mul(0.42)
      .mul(gait);
    // Rotate about the hip (x forward, z up).
    const hz = position.z.sub(PERSON_HIP_M);
    const c = cos(swing);
    const s = sin(swing);
    const leg = vec3(
      c.mul(position.x).add(s.mul(hz)),
      position.y,
      s.negate().mul(position.x).add(c.mul(hz)).add(PERSON_HIP_M),
    );
    // Idle: the upper body shifts its weight, slowly, only while standing.
    const sway = sin(time.mul(1.1).add(phase)).mul(0.035).mul(float(1).sub(gait));
    const body = vec3(position.x, position.y.add(sway.mul(max(hz, 0))), position.z);
    const posed: Vec3 = select(isLeg, leg, body);
    local = vec3(
      posed.x,
      posed.y,
      posed.z.add(
        abs(sin(time.mul(Math.PI * 1.7).add(phase)))
          .mul(0.03)
          .mul(gait),
      ),
    );
    n = normal;
    const clothes = style.xyz;
    colour = select(
      part.greaterThan(PERSON_PART.skin - 0.5).and(part.lessThan(PERSON_PART.skin + 0.5)),
      skinTone(fract(style.w.mul(7.31))),
      select(
        part.greaterThan(PERSON_PART.clothes - 0.5),
        clothes,
        mix(vec3(0.24, 0.26, 0.32), clothes, 0.3),
      ),
    );
  } else {
    const paint = attribute('paint', 'float');
    const framed = libraryFrame(position);
    const framedNormal = libraryFrame(normal);
    // Stretched along its length to the car's: a normal scales by the inverse.
    const stretch = style.w.mul(model.maxLength / model.modelLength);
    local = vec3(framed.x.mul(stretch), framed.y, framed.z);
    n = normalize(vec3(framedNormal.x.div(stretch), framedNormal.y, framedNormal.z));
    let tint: Vec3 = style.xyz;
    if (model.taxi) {
      // A taxi's doors: the flanks between the sills and the waist.
      const doors = shared(frame).taxiDoors;
      const onDoor = paint
        .greaterThan(0.5)
        .and(abs(n.y).greaterThan(0.55))
        .and(local.z.greaterThan(model.doorBand[0]))
        .and(local.z.lessThan(model.doorBand[1]));
      tint = select(onDoor, doors, tint);
    }
    colour = libraryColour(attribute('color', 'vec3'), paint, tint);
    gloss = paint;
  }
  const scaled = local.mul(p.scale);
  const world = toWorld(scaled, p.at, p.heading, scaled.z.add(p.ground));
  const c = cos(p.heading);
  const s = sin(p.heading);
  const vNormal = varying(vec3(c.mul(n.x).sub(s.mul(n.y)), s.mul(n.x).add(c.mul(n.y)), n.z));
  const vColor = varying(colour);
  const vGloss = varying(gloss);

  const material = mapBlending(new MeshBasicNodeMaterial());
  material.vertexNode = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(world, 1));
  const { position: lightPosition, color: lightColor, intensity } = sharedLight(light);
  const nn = normalize(vNormal);
  // Wrapped diffuse: a soft terminator, no hard dark side (matte maquette).
  const direct = clamp(dot(nn, normalize(lightPosition)).add(0.35).div(1.35), 0, 1);
  // Hemisphere fill: cool sky from above, a warm bounce from the street.
  const fill = mix(vec3(0.78, 0.74, 0.7), vec3(0.92, 0.95, 1), nn.z.mul(0.5).add(0.5));
  const lit = vColor
    .mul(
      fill
        .mul(float(0.5).add(float(1).sub(intensity).mul(0.2)))
        .add(lightColor.mul(direct).mul(0.55)),
    )
    // Paint catches a little sky at grazing angles.
    .add(select(vGloss.greaterThan(0.5), vec3(pow(max(nn.z, 0), 4).mul(0.04)), vec3(0)));
  material.colorNode = vec4(clamp(lit, 0, 1), 1);
  // The engine's model matrix is mirrored, so three calls the models' outward
  // faces back faces — as with the buildings (`cityMeshes.ts`).
  material.side = BackSide;
  return material;
}

/** The soft contact shadow: one quad per agent, a radial blob, premultiplied. */
export function lifeShadowMaterial(frame: LifeFrame, model: LifeModel): MeshBasicNodeMaterial {
  const p = place(frame, model, 2);
  const style = attribute('aStyle', 'vec4');
  const position = attribute('position', 'vec3');
  const lengthScale: Float = model.person
    ? float(1)
    : style.w.mul(model.maxLength / model.modelLength);
  // A little larger than the footprint, so the blob's soft edge shows round it.
  const local2 = position.xy
    .mul(vec2(...model.shadowHalfSize))
    .mul(vec2(lengthScale.mul(1.12), 1.3))
    .mul(p.scale);
  const world = toWorld(vec3(local2, 0), p.at, p.heading, p.ground.add(0.04));
  const vUv = varying(position.xy);

  const material = premultipliedBlending(new MeshBasicNodeMaterial());
  material.vertexNode = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(world, 1));
  // A superellipse falloff: a rounded rectangle for a car, a disc for a person.
  const q = abs(vUv);
  const d = pow(pow(q.x, 3).add(pow(q.y, 3)), 1 / 3);
  const a = float(model.shadowStrength).mul(float(1).sub(smoothstep(0.3, 1, d)));
  material.colorNode = vec4(0, 0, 0, a);
  material.side = DoubleSide;
  // A flat quad on the ground: one pass, not three's back-then-front pair
  // for a double-sided transparent material (two draws per model).
  material.forceSinglePass = true;
  material.transparent = true;
  material.depthWrite = false;
  return material;
}
