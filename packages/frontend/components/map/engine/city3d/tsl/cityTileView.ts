/**
 * One GoWay city tile, meshed and drawn by three.js's `WebGPURenderer` with
 * the TSL building material — the native-3D phase 1 prototype
 * (`docs/MAP_NATIVE_3D.md`). The SAME module runs in a browser (WebGL2 or
 * WebGPU) and in the native apps (`react-native-webgpu`: Dawn on Metal or
 * Vulkan); the host passes only what differs between them — the canvas, the
 * WebGPU context and device when it has them, and how a frame is presented.
 *
 * It meshes on the calling thread with `tileMeshing.ts`, the exact function
 * the web's mesh worker runs, and reports how long that took: on native that
 * number is Hermes's, which is the measurement the plan needs.
 *
 * Not a map: no MapLibre, no tile loading, a fixed orbiting camera. The
 * engine proper (`cityEngine.ts`) keeps drawing the web map until the phases
 * in the doc replace its WebGL materials with these.
 */
import {
  BufferAttribute,
  BufferGeometry,
  BackSide,
  Group,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Color,
  WebGPURenderer,
} from 'three/webgpu';

import type { MapAppearance } from '@/lib/map/provider';
import { BUILDINGS_LIGHT, buildingHeightRamp } from '@/lib/map/style/buildings3d';
import { CARTOGRAPHY_PALETTES } from '@/lib/map/style/palette';
import { cityLightFromSpec } from '@/components/map/city3dLight';

import { hexToRgb } from '../colour';
import { type PackedMesh, quantizedModelMatrix } from '../packing';
import { type TileId, tileSizeMetres } from '../tileMath';
import { meshCityTile } from '../tileMeshing';
import { createOsmBuildingMaterial } from './osmBuildingMaterial';

export interface CityTileViewOptions {
  /** A DOM canvas, or `react-native-webgpu`'s canvas (`context.canvas`). */
  canvas: unknown;
  /** The host's WebGPU context and device (native); omitted in a browser. */
  context?: unknown;
  device?: unknown;
  /** Browser only: draw through three's WebGL2 backend instead of WebGPU. */
  forceWebGL?: boolean;
  /** Drawing-buffer size in device pixels. */
  width: number;
  height: number;
  /** The tile's bytes (a GoWay city tile, `lib/map/cityTiles.ts`) and its address. */
  bytes: ArrayBuffer;
  tile: TileId;
  /** Light or dark: the palette's ramp and ground, and the style's static light. */
  appearance: MapAppearance;
  /** Called after each render: native presents the frame (`context.present()`). */
  present?: () => void;
  /** A clock in milliseconds (`performance.now`). */
  now: () => number;
}

export interface CityTileViewStats {
  /** Which backend three chose: `webgpu` (Dawn / the browser's) or `webgl2`. */
  backend: 'webgpu' | 'webgl2';
  /** Decode + mesh + pack, on the calling thread. */
  meshMs: number;
  /** Building geometry handed to the GPU. */
  vertices: number;
  triangles: number;
  bytes: number;
  draws: number;
  /** Renderer init (device, pipelines are compiled lazily on the first frame). */
  initMs: number;
}

export interface CityTileView {
  stats: CityTileViewStats;
  /** Draw one frame with the camera `bearingDeg` around the tile's centre; returns its CPU time. */
  frame(bearingDeg: number): number;
  dispose(): void;
}

/** MapLibre's vertical field of view (its default `fov` of 0.6435 rad). */
const FOV_DEG = 36.87;
const PITCH_DEG = 60;
/** Distance from the look-at point, metres: about z16.5 on a phone at this pitch. */
const DISTANCE_M = 900;

/** three's renderer options; its WebGPU handle types come from there, not from a DOM lib. */
type RendererParameters = NonNullable<ConstructorParameters<typeof WebGPURenderer>[0]>;

function geometryFor(chunk: PackedMesh['chunks'][number]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(chunk.position, 4));
  geometry.setAttribute('normal', new BufferAttribute(chunk.normal, 4, true));
  // City tiles always carry both lanes (`osmMesher.ts`); the material reads them.
  if (chunk.color) geometry.setAttribute('color', new BufferAttribute(chunk.color, 4, true));
  if (chunk.facade) geometry.setAttribute('facade', new BufferAttribute(chunk.facade, 4));
  geometry.setIndex(new BufferAttribute(chunk.index, 1));
  return geometry;
}

export async function createCityTileView(options: CityTileViewOptions): Promise<CityTileView> {
  const started = options.now();
  const renderer = new WebGPURenderer({
    canvas: options.canvas as HTMLCanvasElement,
    ...(options.context ? { context: options.context as RendererParameters['context'] } : {}),
    ...(options.device ? { device: options.device as RendererParameters['device'] } : {}),
    forceWebGL: options.forceWebGL === true,
    antialias: false,
  });
  // Palette values are written raw, as the WebGL engine and MapLibre do.
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setSize(options.width, options.height, false);
  const palette = CARTOGRAPHY_PALETTES[options.appearance];
  // The map's own ground (`land`), where the real engine draws over MapLibre's.
  renderer.setClearColor(new Color().setRGB(...hexToRgb(palette.land)), 1);
  await renderer.init();
  const initMs = options.now() - started;

  const meshStarted = options.now();
  const { mesh } = meshCityTile(options.bytes, tileSizeMetres(options.tile), undefined);
  const meshMs = options.now() - meshStarted;

  const ramp = buildingHeightRamp(palette);
  const { material } = createOsmBuildingMaterial(
    {
      low: hexToRgb(ramp.low),
      tall: hexToRgb(ramp.tall),
      veryTall: hexToRgb(ramp.veryTall),
      tallM: ramp.tallM,
      veryTallM: ramp.veryTallM,
    },
    // The style's static light (the running map aims it from the sun instead).
    cityLightFromSpec(BUILDINGS_LIGHT[options.appearance], 0),
  );
  // `cityMeshes.ts` → SIDE: the stored units mirror y once. In the map that is
  // cancelled by MapLibre's own mirror and the outward faces are FRONT; here
  // the camera is plain ENU, so the one mirror stands and they are BACK
  // (rendered both ways: FrontSide draws roofless shells).
  material.side = BackSide;

  const scene = new Scene();
  const city = new Group();
  scene.add(city);
  const centre: [number, number] = [0, 0];
  if (mesh) {
    // Stored units → local metres (x east, y north, z up), as the engine
    // places them, minus the tile's mesh centre so the camera orbits it.
    const q = new Matrix4().fromArray(
      quantizedModelMatrix(new Matrix4().elements, mesh.unitM, mesh.originM),
    );
    const toMetres = (x: number, y: number): [number, number] => [
      mesh.originM[0] + x * mesh.unitM,
      mesh.originM[1] - y * mesh.unitM,
    ];
    const [minX, maxY] = toMetres(mesh.bounds.min[0], mesh.bounds.min[1]);
    const [maxX, minY] = toMetres(mesh.bounds.max[0], mesh.bounds.max[1]);
    centre[0] = (minX + maxX) / 2;
    centre[1] = (minY + maxY) / 2;
    for (const chunk of mesh.chunks) {
      const part = new Mesh(geometryFor(chunk), material);
      part.matrixAutoUpdate = false;
      part.matrix.copy(q);
      part.frustumCulled = false;
      city.add(part);
    }
  }

  const camera = new PerspectiveCamera(FOV_DEG, options.width / options.height, 5, 20_000);
  camera.up.set(0, 0, 1);
  const stats: CityTileViewStats = {
    backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'webgpu'
      : 'webgl2',
    meshMs,
    vertices: mesh?.vertices ?? 0,
    triangles: mesh?.triangles ?? 0,
    bytes: mesh?.bytes ?? 0,
    draws: mesh?.chunks.length ?? 0,
    initMs,
  };

  return {
    stats,
    frame(bearingDeg) {
      const t0 = options.now();
      const bearing = (bearingDeg * Math.PI) / 180;
      const pitch = (PITCH_DEG * Math.PI) / 180;
      const ground = DISTANCE_M * Math.sin(pitch);
      // The camera stands `ground` metres BEHIND the look-at point along the
      // bearing (bearing 0 looks north) and rises with the pitch.
      camera.position.set(
        centre[0] - Math.sin(bearing) * ground,
        centre[1] - Math.cos(bearing) * ground,
        DISTANCE_M * Math.cos(pitch),
      );
      camera.lookAt(centre[0], centre[1], 0);
      renderer.render(scene, camera);
      options.present?.();
      return options.now() - t0;
    },
    dispose() {
      for (const child of city.children) (child as Mesh).geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
