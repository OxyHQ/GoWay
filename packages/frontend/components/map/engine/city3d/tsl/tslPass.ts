/**
 * The city engine's renderer: three's `WebGPURenderer` — its WebGL2 backend
 * on the web — drawing in MapLibre's OWN context, frame and depth buffer
 * (`docs/MAP_NATIVE_3D.md` → Phase 2). Every material the engine draws is TSL
 * and drawn here: the buildings (map-lit, or under the city sky with its
 * shadow map and haze), the trees, the sky's ground passes, and every
 * overlay. On native this is the same pass, on WebGPU (Dawn).
 *
 * What makes it share MapLibre's frame rather than draw beside it:
 *
 *  - **MapLibre's context** (`context`), not a new one, so the same default
 *    framebuffer and the same depth buffer the basemap's 3D layers wrote.
 *  - **No offscreen target.** `WebGPURenderer` renders through an internal
 *    half-float target, then a full-screen quad, whenever the output needs
 *    tone mapping or a colour-space conversion. The palette's values are
 *    written raw (as three's `WebGLRenderer` once did here), so the output is the working
 *    space with no tone mapping, and it draws straight into the map's frame.
 *  - **MapLibre owns the canvas.** three writes `canvas.width` on any resize,
 *    which would clear the frame the map has drawn so far. It gets a view of
 *    the canvas whose size it can read and whose writes are ignored, and its
 *    internal size follows the real one each frame ({@link hostCanvasView}).
 *  - **State.** The map changed GL state since three last looked; the
 *    backend's cache is reset before drawing (what `resetState()` did on
 *    three's WebGL renderer), and MapLibre marks its own state dirty when the
 *    layer returns.
 */
import {
  type Camera,
  DoubleSide,
  LinearSRGBColorSpace,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  NoToneMapping,
  PerspectiveCamera,
  type RenderTarget,
  Scene,
  type Side,
  WebGPURenderer,
} from 'three/webgpu';

import {
  type BuildingMaterials,
  type BuildingUniformRefs,
  createBuildingMaterials,
  createBuildingUniforms,
} from './buildingMaterial';
import {
  type CityMaterialResponse,
  createSkyBuildingMaterials,
  type DetailedSurface,
} from './skyBuildingMaterial';
import type { SkyNodes } from './skyNodes';
import { vec4 } from 'three/tsl';
import { createTreeMaterials, type TreeMaterials, type TreeUniformRefs } from './treeMaterial';

export interface TslPass {
  /** Where the engine adds the meshes it builds with TSL materials. */
  scene: Scene;
  /**
   * The shared building materials, on the engine's uniforms: map-lit
   * (`buildingMaterial.ts`), or sky-lit under the city sky (`skyBuildingMaterial.ts`).
   */
  buildings: BuildingMaterials;
  /** The shared tree materials (`treeMaterial.ts`), on the engine's uniforms. */
  trees: TreeMaterials;
  /**
   * The sun's shadow casters' material (`sky.ts`): depth only, each building
   * keeping its own position — its terrain lift included — through the
   * override (`drawOffscreen`). Rebuilt with the buildings' materials
   * (`buildings.invalidate`): a program built before a tile was grounded has
   * no lift, and would cast from under the terrain.
   */
  caster: MeshBasicNodeMaterial;
  /** `false` until the renderer's backend is up (it initialises asynchronously). */
  readonly ready: boolean;
  /** Draw the scene into the map's frame with `camera` (MapLibre's projection). */
  draw(camera: Camera): void;
  /**
   * Draw another scene with its own camera into the same frame and depth
   * buffer: the model layer's (`models.ts` → Frames), whose world is y-north.
   */
  drawScene(scene: Scene, camera: Camera): boolean;
  /**
   * Draw `scene` into an offscreen `target` (cleared to white first), every
   * mesh with `override`'s colour and its own position (the sky's shadow map,
   * `sky.ts`), then return to the map's frame. `false`: nothing drawn.
   */
  drawOffscreen(scene: Scene, camera: Camera, target: RenderTarget, override: Material): boolean;
  /** Allocate `target`'s attachments without drawing (a sampled texture must exist). */
  initTarget(target: RenderTarget): boolean;
  /**
   * Build what `scene` draws with `camera` before it is drawn
   * (`materialWarmup.ts`), one {@link Warming.step} per frame from the host's
   * render callback: each step makes one mesh's index buffer, with the state
   * reset; once all are made, three's `compileAsync` builds the shaders in
   * slices between frames. The order is the safety: an index buffer made
   * between frames would be bound into whatever vertex array the map left
   * bound (MapLibre leaves its last one, and reuses it without rebinding); a
   * shader build, a uniform buffer or a vertex buffer touches no vertex array.
   */
  warm(scene: Scene, camera: Camera): Warming;
  dispose(): void;
}

/** How long a warm-up step may spend making index buffers in one frame, ms. */
const WARM_UPLOAD_MS = 4;

/** A warm-up in progress (`TslPass.warm`). */
export interface Warming {
  /**
   * One step, from the render callback: the next meshes' index buffers, or —
   * once all are made — the start of the builds. The scene's meshes must be
   * as visible as they were when the warm-up began. `true` while it needs
   * another frame; the builds then run on their own until {@link done}.
   */
  step(): boolean;
  /** Every material built (or failed to: it then builds on first use, as without a warm-up). */
  readonly done: Promise<void>;
}

/** The canvas as three may see it: its size, read-only; its events, the real ones. */
interface CanvasView {
  readonly width: number;
  readonly height: number;
  style: Record<string, string>;
  addEventListener: HTMLCanvasElement['addEventListener'];
  removeEventListener: HTMLCanvasElement['removeEventListener'];
}

/**
 * A view of the map's canvas for three: reads the real size, ignores writes.
 * three never resizes a canvas it does not own; context-loss events still
 * reach it from the real element.
 */
export function hostCanvasView(canvas: HTMLCanvasElement): CanvasView {
  return {
    get width() {
      return canvas.width;
    },
    set width(_ignored: number) {},
    get height() {
      return canvas.height;
    },
    set height(_ignored: number) {},
    style: {},
    addEventListener: canvas.addEventListener.bind(canvas),
    removeEventListener: canvas.removeEventListener.bind(canvas),
  } as CanvasView;
}

/** The slice of three's WebGL backend this pass resets (not in three's types). */
interface ResettableBackend {
  resetState?: () => void;
}

/** Decals must not bias the host's terrain on the next frame. */
export function withPolygonOffsetState<T>(gl: WebGL2RenderingContext, draw: () => T): T {
  const enabled = gl.isEnabled(gl.POLYGON_OFFSET_FILL);
  const factor = gl.getParameter(gl.POLYGON_OFFSET_FACTOR) as number;
  const units = gl.getParameter(gl.POLYGON_OFFSET_UNITS) as number;
  try {
    return draw();
  } finally {
    gl.polygonOffset(factor, units);
    if (enabled) gl.enable(gl.POLYGON_OFFSET_FILL);
    else gl.disable(gl.POLYGON_OFFSET_FILL);
  }
}

export function createTslPass(options: {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  buildingUniforms: BuildingUniformRefs;
  treeUniforms: TreeUniformRefs;
  /** Which faces each keeps (`cityMeshes.ts` → SIDE). */
  side: { buildings: Side; trees: Side };
  /**
   * The city sky: its light inputs and the material response the buildings
   * answer them with (`skyBuildingMaterial.ts`). Absent: map-lit buildings.
   */
  sky?: { nodes: SkyNodes; response: CityMaterialResponse; detailedSurface?: DetailedSurface };
  /** Called once the renderer is ready, so the host draws a frame with the city. */
  onReady: () => void;
}): TslPass {
  const canvas = hostCanvasView(options.canvas);
  const renderer = new WebGPURenderer({
    canvas: canvas as unknown as HTMLCanvasElement,
    context: options.gl,
    forceWebGL: true,
    antialias: false,
  });
  // Raw palette values into the map's frame: no conversion, so no offscreen target.
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  // The map owns the framebuffer: never clear what it has already drawn.
  renderer.autoClear = false;

  const scene = new Scene();
  // The meshes are placed by the engine (`placeEntry` writes `matrixWorld`).
  scene.matrixWorldAutoUpdate = false;
  let ready = false;
  let disposed = false;
  let size = { width: 0, height: 0 };
  renderer.init().then(
    () => {
      if (disposed) return;
      ready = true;
      options.onReady();
    },
    () => {
      // A backend that cannot start draws nothing; the map underneath is unaffected.
    },
  );

  const buildingUniforms = createBuildingUniforms(options.buildingUniforms);
  // Both faces: the mirrored model matrices make "front" ambiguous
  // (`cityMeshes.ts`), and a closed solid casts the same shadow either way.
  const caster = new MeshBasicNodeMaterial();
  caster.colorNode = vec4(1);
  caster.side = DoubleSide;
  // Draws nothing (no colour, no depth): it only makes a mesh's buffers (`warm`).
  const uploader = new MeshBasicNodeMaterial();
  uploader.colorNode = vec4(0);
  uploader.colorWrite = false;
  uploader.depthWrite = false;
  uploader.depthTest = false;
  uploader.side = DoubleSide;
  const uploadCamera = new PerspectiveCamera();
  const shared: BuildingMaterials = options.sky
    ? createSkyBuildingMaterials({
        uniforms: buildingUniforms,
        sky: options.sky.nodes,
        response: options.sky.response,
        detailedSurface: options.sky.detailedSurface,
        side: options.side.buildings,
      })
    : createBuildingMaterials(buildingUniforms, options.side.buildings);
  const buildings: BuildingMaterials = {
    get: (format, isDithered) => shared.get(format, isDithered),
    invalidate() {
      shared.invalidate();
      caster.needsUpdate = true;
    },
    dispose: () => shared.dispose(),
  };
  const trees = createTreeMaterials(options.treeUniforms, options.side.trees);

  /** Follow the map's canvas and forget the GL state the map changed. */
  const prepare = () => {
    // Follow the map's canvas: three's size is in logical pixels × ratio 1,
    // and `setSize` only writes the (ignored) view and the viewport.
    if (size.width !== canvas.width || size.height !== canvas.height) {
      size = { width: canvas.width, height: canvas.height };
      renderer.setPixelRatio(1);
      renderer.setSize(size.width, size.height, false);
    }
    (renderer.backend as ResettableBackend).resetState?.();
  };

  /** `false`: nothing drawn (the backend is not up, failed, or is gone). */
  const drawScene = (target: Scene, camera: Camera): boolean => {
    if (!ready || disposed) return false;
    withPolygonOffsetState(options.gl, () => {
      prepare();
      renderer.render(target, camera);
    });
    return true;
  };

  return {
    scene,
    buildings,
    trees,
    caster,
    get ready() {
      return ready;
    },
    draw(camera) {
      drawScene(scene, camera);
    },
    drawScene,
    drawOffscreen(target, camera, renderTarget, override) {
      if (!ready || disposed) return false;
      withPolygonOffsetState(options.gl, () => {
        prepare();
        renderer.setRenderTarget(renderTarget);
        renderer.setClearColor(0xffffff, 1);
        renderer.clear(true, true, false);
        const previous = target.overrideMaterial;
        target.overrideMaterial = override;
        try {
          renderer.render(target, camera);
        } finally {
          target.overrideMaterial = previous;
          renderer.setRenderTarget(null);
        }
      });
      return true;
    },
    warm(target, camera) {
      // One geometry per index buffer: those are what must be made here, and
      // meshes share them (every tile's trees, one index per tree shape).
      const byIndex = new Map<unknown, Mesh['geometry']>();
      target.traverseVisible((object) => {
        const mesh = object as Mesh;
        const index = mesh.isMesh && mesh.layers.test(camera.layers) ? mesh.geometry.index : null;
        if (index && !byIndex.has(index)) byIndex.set(index, mesh.geometry);
      });
      const pending = [...byIndex.values()];
      let resolve: () => void = () => {};
      const done = new Promise<void>((settle) => {
        resolve = settle;
      });
      let building = false;
      const upload = new Mesh(undefined, uploader);
      upload.frustumCulled = false;
      const uploads = new Scene();
      uploads.add(upload);
      return {
        done,
        step() {
          if (building || disposed) return false;
          if (!ready) return true;
          if (pending.length > 0) {
            // Drawn with one trivial material: one small build per vertex
            // layout, not one per material. As many as fit the step's budget
            // (at least one): past the first of a layout, each is a buffer.
            const started = performance.now();
            do {
              upload.geometry = pending.pop() as Mesh['geometry'];
              drawScene(uploads, uploadCamera);
            } while (pending.length > 0 && performance.now() - started < WARM_UPLOAD_MS);
            return true;
          }
          building = true;
          renderer.compileAsync(target, camera).then(resolve, resolve);
          return false;
        },
      };
    },
    initTarget(renderTarget) {
      if (!ready || disposed) return false;
      prepare();
      renderer.initRenderTarget(renderTarget);
      return true;
    },
    dispose() {
      disposed = true;
      buildings.dispose();
      caster.dispose();
      uploader.dispose();
      trees.dispose();
      renderer.dispose();
    },
  };
}
