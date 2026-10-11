/**
 * The city engine's TSL pass: three's `WebGPURenderer` — its WebGL2 backend
 * on the web — drawing in MapLibre's OWN context, frame and depth buffer
 * (`docs/MAP_NATIVE_3D.md` → Phase 2). It draws every material already ported
 * to TSL: the trees always, the buildings whenever the city sky is off (the
 * sky's building material is still GLSL). What is not ported yet still draws
 * with `WebGLRenderer` in the same frame; on native this pass is the renderer,
 * on WebGPU (Dawn).
 *
 * What makes it share MapLibre's frame rather than draw beside it:
 *
 *  - **MapLibre's context** (`context`), not a new one, so the same default
 *    framebuffer and the same depth buffer the basemap's 3D layers wrote.
 *  - **No offscreen target.** `WebGPURenderer` renders through an internal
 *    half-float target, then a full-screen quad, whenever the output needs
 *    tone mapping or a colour-space conversion. The palette's values are
 *    written raw (as `WebGLRenderer` did here), so the output is the working
 *    space with no tone mapping, and it draws straight into the map's frame.
 *  - **MapLibre owns the canvas.** three writes `canvas.width` on any resize,
 *    which would clear the frame the map has drawn so far. It gets a view of
 *    the canvas whose size it can read and whose writes are ignored, and its
 *    internal size follows the real one each frame ({@link hostCanvasView}).
 *  - **State.** The map changed GL state since three last looked; the
 *    backend's cache is reset before drawing, as `WebGLRenderer.resetState()`
 *    does, and MapLibre marks its own state dirty when the layer returns.
 */
import {
  type Camera,
  LinearSRGBColorSpace,
  type Side,
  NoToneMapping,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';

import {
  type BuildingMaterials,
  type BuildingUniformRefs,
  createBuildingMaterials,
  createBuildingUniforms,
} from './buildingMaterial';
import { createTreeMaterials, type TreeMaterials, type TreeUniformRefs } from './treeMaterial';

export interface TslPass {
  /** Where the engine adds the meshes it builds with TSL materials. */
  scene: Scene;
  /** The shared building materials (`buildingMaterial.ts`), on the engine's uniforms. */
  buildings: BuildingMaterials;
  /** The shared tree materials (`treeMaterial.ts`), on the engine's uniforms. */
  trees: TreeMaterials;
  /** `false` until the renderer's backend is up (it initialises asynchronously). */
  readonly ready: boolean;
  /** Draw the scene into the map's frame with `camera` (MapLibre's projection). */
  draw(camera: Camera): void;
  dispose(): void;
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

export function createTslPass(options: {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  buildingUniforms: BuildingUniformRefs;
  treeUniforms: TreeUniformRefs;
  /** Which faces each keeps (`cityMeshes.ts` → SIDE). */
  side: { buildings: Side; trees: Side };
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

  const buildings = createBuildingMaterials(
    createBuildingUniforms(options.buildingUniforms),
    options.side.buildings,
  );
  const trees = createTreeMaterials(options.treeUniforms, options.side.trees);

  return {
    scene,
    buildings,
    trees,
    get ready() {
      return ready;
    },
    draw(camera) {
      if (!ready || disposed) return;
      // Follow the map's canvas: three's size is in logical pixels × ratio 1,
      // and `setSize` only writes the (ignored) view and the viewport.
      if (size.width !== canvas.width || size.height !== canvas.height) {
        size = { width: canvas.width, height: canvas.height };
        renderer.setPixelRatio(1);
        renderer.setSize(size.width, size.height, false);
      }
      (renderer.backend as ResettableBackend).resetState?.();
      renderer.render(scene, camera);
    },
    dispose() {
      disposed = true;
      buildings.dispose();
      trees.dispose();
      renderer.dispose();
    },
  };
}
