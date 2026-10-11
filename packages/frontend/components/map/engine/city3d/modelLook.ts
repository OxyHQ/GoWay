/**
 * How a model is lit, by day and by night — the shading half of the model
 * layer (`models.ts`), shared by every model it draws: the SDK's, the route
 * flyover's vehicle, and GoWay's hand-crafted landmarks
 * (`docs/MAP_LANDMARKS.md`).
 *
 * ## Night, driven by the asset
 *
 * A GLB says how it glows in its own material `extras` (written by
 * `scripts/landmarks/glb.ts`), so nothing here knows which model is which:
 *
 *  - `extras.goway.night = { color, strength }`: the material emits that
 *    linear colour × strength × the night factor — a lit window, a lantern,
 *    the torch. Off by day (glTF's own `emissiveFactor` stays for light that
 *    is on by day too, like the car's headlamps).
 *  - `extras.goway.uplight = { color, reach, strength }`: the material takes
 *    a warm floodlight WASH at night, strongest at the base and on vertical
 *    faces, fading over `reach` metres of height — the uplit-facade look of a
 *    landmark at night. A shader patch, because the falloff is per fragment.
 *
 * The night factor (0 day … 1 night) is the layer's, set by the host
 * (`lib/map/landmarks/night.ts` decides it). At night the sun and the sky
 * light dim and turn blue, so the emissive light is what the eye reads.
 */
import * as THREE from 'three';

/** Linear RGB triple, as glTF factors and the extras carry colour. */
type Rgb = [number, number, number];

interface NightExtras {
  night?: { color: Rgb; strength: number };
  uplight?: { color: Rgb; reach: number; strength: number };
  /** Laid proud of a wall: drawn with a depth bias (`scripts/landmarks/glb.ts`). */
  decal?: boolean;
}

function extrasOf(material: THREE.Material): NightExtras | null {
  const goway = (material.userData as { goway?: NightExtras }).goway;
  return goway && (goway.night || goway.uplight || goway.decal) ? goway : null;
}

const isRgb = (v: unknown): v is Rgb =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));

/** One shared factor for every patched material of a layer (a uniform object). */
export interface NightUniform {
  value: number;
}

/**
 * Prepare one instance body (its materials are its own — `models.ts`
 * `instanceBody`) for night: patch the uplight shader into the materials that
 * ask for it, and remember which ones glow. Returns the glowing materials.
 */
export function prepareNight(body: THREE.Object3D, night: NightUniform): THREE.Material[] {
  const glowing: THREE.Material[] = [];
  body.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4().copy(body.matrixWorld).invert();
  body.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Asset metres of this mesh's vertices: its transform relative to the
    // body (a quantised GLB scales and offsets its node).
    const relative = new THREE.Matrix4().multiplyMatrices(toBody, mesh.matrixWorld);
    const e = relative.elements;
    const heightRow = new THREE.Vector4(e[1], e[5], e[9], e[13]);
    const up = new THREE.Vector3(e[1], e[5], e[9]).normalize();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const extras = extrasOf(material);
      const standard = material as THREE.MeshStandardMaterial;
      if (!extras || !standard.isMeshStandardMaterial) continue;
      if (extras.decal === true) {
        // A pane a few centimetres off its wall, under a depth buffer that
        // resolves decimetres at a kilometre: pull it toward the eye.
        standard.polygonOffset = true;
        standard.polygonOffsetFactor = -1;
        standard.polygonOffsetUnits = -4;
      }
      if (extras.night && isRgb(extras.night.color)) {
        standard.userData.gowayNight = {
          color: new THREE.Color(...extras.night.color),
          strength: Number(extras.night.strength) || 0,
        };
        glowing.push(standard);
      }
      const uplight = extras.uplight;
      if (uplight && isRgb(uplight.color) && uplight.reach > 0) {
        const colour = new THREE.Vector3(...uplight.color).multiplyScalar(
          Number(uplight.strength) || 0,
        );
        standard.onBeforeCompile = (shader) => {
          shader.uniforms.uGowayNight = night;
          shader.uniforms.uGowayUplight = { value: colour };
          shader.uniforms.uGowayReach = { value: uplight.reach };
          shader.uniforms.uGowayHeightRow = { value: heightRow };
          shader.uniforms.uGowayUp = { value: up };
          shader.vertexShader = shader.vertexShader
            .replace(
              '#include <common>',
              '#include <common>\nuniform vec4 uGowayHeightRow;\nuniform vec3 uGowayUp;\nvarying float vGowayHeight;\nvarying float vGowayWall;',
            )
            .replace(
              '#include <begin_vertex>',
              '#include <begin_vertex>\nvGowayHeight = dot(uGowayHeightRow, vec4(position, 1.0));\nvGowayWall = 1.0 - abs(dot(uGowayUp, normalize(normal)));',
            );
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              '#include <common>\nuniform float uGowayNight;\nuniform vec3 uGowayUplight;\nuniform float uGowayReach;\nvarying float vGowayHeight;\nvarying float vGowayWall;',
            )
            .replace(
              '#include <emissivemap_fragment>',
              // A floodlight wash: full at the base, ~5% at `reach`; walls
              // take it, roofs a little.
              '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGowayUplight * (uGowayNight * exp(-3.0 * max(vGowayHeight, 0.0) / uGowayReach) * (0.25 + 0.75 * clamp(vGowayWall, 0.0, 1.0)));',
            );
        };
        // One program for every uplit material (the uniforms differ, the code does not).
        standard.customProgramCacheKey = () => 'goway-uplight';
        standard.needsUpdate = true;
      }
    }
  });
  return glowing;
}

/** Set the glowing materials' emission for a night factor. */
export function applyNight(glowing: readonly THREE.Material[], factor: number): void {
  for (const material of glowing) {
    const standard = material as THREE.MeshStandardMaterial;
    const spec = standard.userData.gowayNight as
      | { color: THREE.Color; strength: number }
      | undefined;
    if (!spec) continue;
    standard.emissive.copy(spec.color).multiplyScalar(spec.strength * factor);
  }
}

/** The models' lights: a sky/ground hemisphere and the sun. */
export interface ModelLights {
  hemisphere: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  /** Re-derive both for a sun direction (ENU, toward the light), its colour and MapLibre's intensity, at a night factor. */
  update(input: {
    position: readonly [number, number, number];
    color: readonly [number, number, number];
    intensity: number;
    night: number;
  }): void;
}

const DAY_SKY = new THREE.Color(0xffffff);
const DAY_GROUND = new THREE.Color(0x8a8f99);
const NIGHT_SKY = new THREE.Color(0x7a84c8);
const NIGHT_GROUND = new THREE.Color(0x2c3050);

/**
 * Lights for a world whose up is +z (the model layer's centre-relative
 * mercator, y north). Tuned so a matte stone maquette under a high sun reads
 * as the city's buildings do, and at night as a blue silhouette that its own
 * lights carve out.
 */
export function createModelLights(): ModelLights {
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6);
  hemisphere.position.set(0, 0, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(0.3, -0.5, 0.8);
  return {
    hemisphere,
    sun,
    update({ position, color, intensity, night }) {
      const [x, y, z] = position;
      sun.position.set(x, y, Math.max(0.05, z));
      sun.color.setRGB(color[0], color[1], color[2]);
      const n = Math.max(0, Math.min(1, night));
      // MapLibre's intensity darkens unlit faces; a dim sky lets the sun shape more.
      sun.intensity = 2.0 * (1 - 0.88 * n);
      // The sky's diffuse share; the environment (`createModelEnvironment`)
      // adds the rest, and the reflections.
      hemisphere.intensity = (0.75 + (1 - intensity) * 0.5) * (1 - 0.2 * n);
      hemisphere.color.copy(DAY_SKY).lerp(NIGHT_SKY, n);
      hemisphere.groundColor.copy(DAY_GROUND).lerp(NIGHT_GROUND, n);
    },
  };
}

/**
 * A soft sky to reflect: glass and steel read as glass and steel only when
 * they mirror something, and with no environment a smooth material mirrors
 * black. A gradient sphere (zenith blue, a warm bright horizon, a grey
 * ground), up being the world's +z, pre-filtered once with three's PMREM.
 *
 * PMREM renders into its own targets, and this runs INSIDE the host's frame,
 * with the host's framebuffer bound — which three cannot see. So the binding
 * and the viewport are saved and put back by hand, and three's cached state
 * is reset after. Returns `null` (no reflections, nothing else changes) if
 * the context cannot do it.
 */
export function createModelEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture | null {
  if (typeof renderer.getContext !== 'function') return null;
  const gl = renderer.getContext();
  const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  const sky = new THREE.SphereGeometry(10, 32, 16);
  sky.rotateX(Math.PI / 2); // poles on ±z
  const position = sky.attributes.position;
  const colours = new Float32Array(position.count * 3);
  const zenith = new THREE.Color(0xb7cde6);
  const horizon = new THREE.Color(0xf4efe6);
  const ground = new THREE.Color(0x8f8d88);
  const c = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const up = position.getZ(i) / 10;
    if (up >= 0) c.copy(horizon).lerp(zenith, Math.min(1, up * 1.6));
    else c.copy(horizon).lerp(ground, Math.min(1, -up * 4));
    colours.set([c.r, c.g, c.b], i * 3);
  }
  sky.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  scene.add(new THREE.Mesh(sky, material));
  const pmrem = new THREE.PMREMGenerator(renderer);
  let texture: THREE.Texture | null = null;
  try {
    texture = pmrem.fromScene(scene, 0, 0.1, 100).texture;
  } catch {
    texture = null;
  } finally {
    pmrem.dispose();
    sky.dispose();
    material.dispose();
    renderer.resetState();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
  }
  return texture;
}

/** How much of the environment a model reflects at a night factor. */
export function environmentIntensity(night: number): number {
  return 0.6 * (1 - 0.8 * Math.max(0, Math.min(1, night)));
}
