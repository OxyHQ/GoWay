/**
 * The Gaussian-splat engine behind the web `SceneViewer`: three.js + Spark.
 *
 * This is the ONLY module in GoWay that imports `three` or `@sparkjsdev/spark`,
 * and it is only ever reached through a dynamic `import()` from
 * `SceneViewer.web.tsx` — so the ~3 MB renderer is a separate chunk that a
 * visitor who never opens a 3D view never downloads, and native bundles never
 * contain it at all. Replacing the renderer is replacing this file.
 *
 * Responsibilities, in order of how easy they are to get wrong:
 *
 *  - **Dispose everything.** Splat buffers, sort workers and the WebGL
 *    context hold GPU memory the page does not get back by unmounting a React
 *    tree. `dispose()` stops the loop, frees every mesh and the Spark
 *    renderer (its page pool included), and forces the context to be lost so
 *    the GPU memory is reclaimed now, not at the next GC.
 *  - **Progressive detail.** An `spz` scene draws the light `splat_preview`
 *    as soon as it decodes; the full `splat` streams in behind it and
 *    replaces it. A `rad` scene is a level-of-detail tree, paged: its coarse
 *    levels draw first and Spark streams only the chunks the view and the
 *    device's budget need. The user is never staring at a spinner for a file
 *    they may not need.
 *  - **Up comes from the transform, never from three.js.** Published scene
 *    space is metric ENU around the anchor (x east, y north, z up) and Spark
 *    decodes `.spz` values as stored, with no axis flip of its own (checked by
 *    rendering a real reconstruction: facades vertical, sky up). So the mesh
 *    is NOT rotated into three.js's Y-up; the camera's `up` is set to the
 *    scene's up (`sceneUp(enuFromScene)`), and `initialView` and the place
 *    labels stay in scene coordinates untouched. A future frame convention is
 *    a transform change, not a viewer change.
 *  - **Labels are not pixels.** Place labels are DOM elements positioned by
 *    projecting a scene point each frame. They never touch the splat, so a
 *    renamed place needs no retraining, and they are hidden when behind the
 *    camera or outside the frustum.
 */
import { PagedSplats, SparkRenderer, SplatFileType, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

import type { StreetSceneAsset, StreetSceneNavigation } from '@goway.to/sdk';

import { createCameraRig, MAX_PITCH, type CameraPose, type CameraRig } from '../cameraRig';
import {
  CAPTURE_HEIGHT_METERS,
  easeInOut,
  glideDurationMs,
  groundHit,
  pitchLimitDegrees,
  RUN_SPEED_MPS,
  STICK_RADIUS_PX,
  stickInput,
  viewFrustum,
  type ViewFrustum,
  WALK_SPEED_MPS,
} from '../guidedNavigation';
import { createWalkableRegion, reachOf } from '../walkableRegion';
import { radChunksAllowed, type AssetPolicy, type SceneAssetPlan } from '../assets';
import type {
  SceneViewerControlMode,
  SceneViewerLabel,
  SceneViewerPhase,
  SceneViewerStats,
  Vec3,
} from '../types';
import { createQualityGovernor, type QualityBounds, qualityLadder } from '../qualityGovernor';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Receives key events; the canvas container, which is focusable. */
  keyTarget: HTMLElement;
  plan: SceneAssetPlan;
  initialView: { position: Vec3; target: Vec3 };
  /** World up in scene coordinates (from `worldTransform`). */
  up: Vec3;
  /**
   * Where the LoD budget (a multiplier on Spark's per-platform base) and the
   * pixel ratio start, and how far `qualityGovernor.ts` may move them
   * (`deviceProfile.ts`).
   */
  quality: QualityBounds;
  /** The rule every asset URL passed — applied again to a RAD's chunk files. */
  assetPolicy: AssetPolicy;
  tier: SceneViewerStats['tier'];
  onPhase: (phase: SceneViewerPhase) => void;
  onStats: (stats: SceneViewerStats) => void;
  /** Called each frame with every label's screen position, or `null` when hidden. */
  onLabels: (
    positions: ReadonlyMap<string, { x: number; y: number; depth: number } | null>,
  ) => void;
  /** Guided-navigation data from the manifest; absent → free orbit/walk only. */
  navigation?: StreetSceneNavigation;
  /**
   * Guided, a mouse over walkable ground: where a click would take you, as a
   * ring under the pointer; `null` when it is not over walkable ground. Called
   * each frame it shows (the same object, rewritten) and once when it hides.
   */
  onCursor: (cursor: GroundCursor | null) => void;
  /** Guided, touch: the thumbstick while a thumb holds it, `null` once released. */
  onStick: (stick: Thumbstick | null) => void;
  /** The camera's field of view and side mask, whenever they change. */
  onFrustum: (frustum: ViewFrustum) => void;
}

/** A ground ring projected to the screen: centre, radius in px, vertical squash 0–1. */
export interface GroundCursor {
  x: number;
  y: number;
  radius: number;
  squash: number;
}

/** Where a thumb landed (px) and how far the knob is from there (px, at most the stick's radius). */
export interface Thumbstick {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface SceneEngine {
  setLabels(labels: readonly SceneViewerLabel[]): void;
  setMode(mode: SceneViewerControlMode): void;
  resetView(): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Radians per pixel of drag. */
const LOOK_SPEED = 0.005;
/** Metres per second of WASD flying without navigation; Shift runs. */
const FREE_WALK_SPEED = 4;
const RUN_MULTIPLIER = 3;
/** Labels farther than this from the camera are not drawn. */
const LABEL_MAX_DEPTH = 220;
const STATS_INTERVAL_MS = 1000;
/** Guided turning with ←/→, radians per second. */
const TURN_SPEED = Math.PI / 2;
/** A pointer that moved less than this between down and up is a click, px. */
const CLICK_SLOP_PX = 6;
/** Two touch taps closer than this in time and space are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP_PX = 32;
/**
 * A touch that lands in the left third of the viewer, below its top third (the
 * chrome), is a thumbstick; anywhere else it looks. Fractions of the viewer.
 */
const STICK_ZONE_RIGHT = 1 / 3;
const STICK_ZONE_TOP = 1 / 3;
/** Ground cursor radius, metres. */
const CURSOR_RADIUS_METERS = 0.35;
const FREE_VERTICAL_FOV = 60;
const DEG = Math.PI / 180;
/**
 * Far plane, metres. Spark culls splats beyond it, and an environment shell
 * reaches kilometres from the anchor. Nothing here writes depth, so a deep
 * frustum costs no precision.
 */
const FAR_PLANE_METERS = 10_000;
/**
 * A paged scene is `full` once its pager has had nothing in flight or queued
 * for this long. Chunks arrive in bursts separated by worker round trips of a
 * few milliseconds; half a second of quiet means this view has streamed.
 */
const LOD_SETTLE_MS = 500;

/**
 * A RAD level-of-detail tree that counts the bytes it streams. Spark reports
 * no progress for paged fetches, but every chunk passes through
 * `fetchDecodeChunk`, and the header gives each chunk's size.
 */
class CountedLodTree extends PagedSplats {
  private readonly onBytes: (bytes: number) => void;

  constructor(url: string, onBytes: (bytes: number) => void) {
    // Scene assets are public and cookie-free: never send credentials to the
    // CDN. The file type is explicit, as for `spz`: a content-hashed key need
    // not end in `.rad`.
    super({ rootUrl: url, fileType: SplatFileType.RAD, withCredentials: false });
    this.onBytes = onBytes;
  }

  override async fetchDecodeChunk(chunk: number) {
    const decoded = await super.fetchDecodeChunk(chunk);
    const { meta } = await this.getRadMeta();
    this.onBytes(meta.chunks[chunk]?.bytes ?? 0);
    return decoded;
  }
}

const MOVE_KEYS: Record<string, [forward: number, right: number, up: number]> = {
  KeyW: [1, 0, 0],
  ArrowUp: [1, 0, 0],
  KeyS: [-1, 0, 0],
  ArrowDown: [-1, 0, 0],
  KeyA: [0, -1, 0],
  ArrowLeft: [0, -1, 0],
  KeyD: [0, 1, 0],
  ArrowRight: [0, 1, 0],
  KeyE: [0, 0, 1],
  KeyQ: [0, 0, -1],
};

export function createSceneEngine(options: EngineOptions): SceneEngine {
  const { canvas, keyTarget, plan } = options;
  const started = performance.now();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  const { ladder, start: startStep } = qualityLadder(options.quality);
  const governor = createQualityGovernor(ladder, startStep);
  renderer.setPixelRatio(ladder[startStep].pixelRatio);
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FREE_VERTICAL_FOV, 1, 0.05, FAR_PLANE_METERS);
  // The loop below draws every frame, so Spark's `onDirty` (for renderers that
  // draw on demand) is not wired: a streamed chunk, a sort or a LoD update is
  // picked up by the next frame anyway.
  const spark = new SparkRenderer({
    renderer,
    // The LoD budget — splats drawn, sorted and streamed at once — is Spark's
    // per-platform base scaled by the device tier, then steered frame by frame
    // by the quality governor (see the loop below). Foveation keeps Spark's
    // defaults: full detail in a 90° cone around the view axis covers the
    // ≤ 60° vertical view, and splats behind the camera at a fifth of the
    // detail are what a guided turn sees first, refined within a traversal.
    lodSplatScale: ladder[startStep].lodScale,
    // Pool paged splats as 32-byte extended splats, not 16-byte packed ones.
    // Packed centres are float16: 6 cm steps from 64 m out and 12.5 cm from
    // 128 m, which a street block a few hundred metres across reaches, and a
    // facade there stripes visibly from walking distance. Extended centres are
    // float32. Only paged (`rad`) meshes use the pool; `spz` is unaffected.
    pagedExtSplats: true,
  });
  // The page pool is allocated, from this field, when the first paged mesh is
  // drawn — and it is resident twice: GPU textures plus three.js's CPU copy —
  // so it is sized ONCE, for the most the governor may climb to. Half Spark's
  // per-platform pool per unit of budget keeps its memory at what Spark sizes
  // for packed splats (268 MB desktop, 134 MB Android, 100 MB iOS) at the base
  // budget; past 1.5× the pool stops growing with the ceiling, so a discrete
  // GPU's 2× ceiling holds 192 pages (12.6M extended splats, ~400 MB) — 2.5×
  // what it draws, room to turn around without refetching.
  spark.maxPagedSplats =
    Math.round((spark.maxPagedSplats * Math.min(options.quality.max.lodScale, 1.5)) / 2 / 65536) *
    65536;
  scene.add(spark);

  const rig: CameraRig = createCameraRig({ ...options.initialView, up: options.up });

  // ── Guided walk ──────────────────────────────────────────────────────────
  //
  // With `navigation`, Walk is free walking over the observed ground only
  // (`walkableRegion.ts`): every frame the wished-for position is clamped into
  // the region (so a wall of unobserved space is slid along, never shown) and
  // set at the captured height there. The look is free but pitch is clamped and
  // the FOV bounded by the capture. Viewpoints are never shown or snapped to.
  // Orbit stays free (secondary).

  const capturedFov = options.navigation?.fieldOfView;
  const region = options.navigation
    ? createWalkableRegion(options.navigation.viewpoints, options.up, reachOf(options.navigation))
    : null;
  const hasNavigation = region !== null;
  const upLength = Math.hypot(...options.up) || 1;
  const up: Vec3 = [options.up[0] / upLength, options.up[1] / upLength, options.up[2] / upLength];
  let mode: SceneViewerControlMode = 'orbit';
  /** Where the walker stands; kept across a detour through Orbit. */
  const standing: Vec3 = [0, 0, 0];
  let placed = false;
  /** A click's walk: eased from `from` to `to`; `done` is the eased share already walked. */
  let glide: { from: Vec3; to: Vec3; start: number; duration: number; done: number } | null = null;
  let fovZoom = 1;
  const guided = () => region !== null && mode === 'walk';

  function enterGuided() {
    if (!region) return;
    rig.setMode('walk');
    rig.setPitchLimit(pitchLimitDegrees(capturedFov) * DEG);
    if (placed) {
      rig.placeAt(standing);
      return;
    }
    placed = true;
    // The publisher's opening position, onto the walkable ground, facing
    // where the opening view faces.
    region.clamp(options.initialView.position, standing);
    rig.placeAt(standing);
    const target = options.initialView.target;
    const toward: Vec3 = [
      target[0] - standing[0],
      target[1] - standing[1],
      target[2] - standing[2],
    ];
    if (Math.hypot(...toward) > 0.1) rig.lookToward(toward);
  }

  const walkForward: Vec3 = [0, 0, 0];
  const walkRight: Vec3 = [0, 0, 0];
  const wish: Vec3 = [0, 0, 0];
  /** Thumbstick input, `[forward, right]` in −1…1. */
  const stick: [number, number] = [0, 0];

  /** One frame of guided walking: keys, thumbstick or a click's glide, then the clamp. */
  function walk(now: number, dt: number) {
    if (!region) return;
    let turn = 0;
    if (held.has('ArrowLeft')) turn -= 1;
    if (held.has('ArrowRight')) turn += 1;
    if (turn !== 0) rig.look(turn * TURN_SPEED * dt, 0);

    // Keys walk (Shift runs); a thumbstick's full deflection runs.
    let forward = 0;
    let right = 0;
    if (held.has('KeyW') || held.has('ArrowUp')) forward += 1;
    if (held.has('KeyS') || held.has('ArrowDown')) forward -= 1;
    if (held.has('KeyD')) right += 1;
    if (held.has('KeyA')) right -= 1;
    const keys = Math.hypot(forward, right);
    const keySpeed = keys > 0 ? (running ? RUN_SPEED_MPS : WALK_SPEED_MPS) / keys : 0;
    forward = forward * keySpeed + stick[0] * RUN_SPEED_MPS;
    right = right * keySpeed + stick[1] * RUN_SPEED_MPS;
    const speed = Math.hypot(forward, right);

    if (speed > 0) {
      glide = null;
      const k = (dt * Math.min(speed, RUN_SPEED_MPS)) / speed;
      rig.walkAxes(walkForward, walkRight);
      for (let i = 0; i < 3; i++)
        wish[i] = standing[i] + (walkForward[i] * forward + walkRight[i] * right) * k;
    } else if (glide) {
      const t = (now - glide.start) / glide.duration;
      const eased = easeInOut(t);
      const share = eased - glide.done;
      glide.done = eased;
      for (let i = 0; i < 3; i++) wish[i] = standing[i] + (glide.to[i] - glide.from[i]) * share;
      if (t >= 1) glide = null;
    } else {
      return;
    }
    // Incremental, so a glide or a key held into the edge slides along it.
    region.clamp(wish, standing);
    rig.placeAt(standing);
  }

  const ray = new THREE.Vector3();
  const rayDirection: Vec3 = [0, 0, 0];
  const hit: Vec3 = [0, 0, 0];

  /** The ground under viewer point (x, y) px, into `hit`; `false` above the horizon. */
  function groundUnder(x: number, y: number): boolean {
    if (!region) return false;
    ray
      .set((x / width) * 2 - 1, -(y / height) * 2 + 1, 0.5)
      .unproject(camera)
      .sub(camera.position);
    rayDirection[0] = ray.x;
    rayDirection[1] = ray.y;
    rayDirection[2] = ray.z;
    return groundHit(
      standing,
      rayDirection,
      up,
      region.heightAt(standing) - CAPTURE_HEIGHT_METERS,
      hit,
    );
  }

  /** Click or double tap: glide to the walkable ground nearest the point under (x, y). */
  function goToward(x: number, y: number) {
    if (!region || !guided() || !groundUnder(x, y)) return;
    const to = region.clamp(hit, [0, 0, 0]);
    const meters = Math.hypot(to[0] - standing[0], to[1] - standing[1], to[2] - standing[2]);
    if (meters < 0.05) return;
    glide = {
      from: [...standing],
      to,
      start: performance.now(),
      duration: glideDurationMs(meters),
      done: 0,
    };
  }

  let frustum: ViewFrustum = viewFrustum(1, capturedFov, 1);
  function applyFrustum(aspect: number) {
    frustum = hasNavigation
      ? viewFrustum(aspect, capturedFov, fovZoom)
      : { verticalDegrees: FREE_VERTICAL_FOV, horizontalDegrees: 0, sideMask: 0 };
    camera.fov = frustum.verticalDegrees;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    options.onFrustum(frustum);
  }

  let disposed = false;
  let phase: SceneViewerPhase = 'loading';
  let shown: SplatMesh | null = null;
  let environment: SplatMesh | null = null;
  const pending = new Set<SplatMesh>();
  const bytesByUrl = new Map<string, number>();
  /** Bytes of RAD headers and chunks fetched so far. */
  let lodBytes = 0;
  /** When the pager last had a chunk in flight or queued (paged scenes). */
  let lodBusyAt = 0;
  let firstFrameMs: number | null = null;
  let previewLoadMs: number | null = null;
  let fullLoadMs: number | null = null;

  const setPhase = (next: SceneViewerPhase) => {
    if (disposed || phase === next) return;
    phase = next;
    options.onPhase(next);
  };

  function load(url: string, onReady: (mesh: SplatMesh) => void, onFail: () => void) {
    const mesh = new SplatMesh({
      url,
      // Content-hashed keys need not end in `.spz`; never let the loader guess.
      fileType: SplatFileType.SPZ,
      // Scene assets are public and cookie-free: never send credentials to the
      // CDN, whichever origin it is on.
      withCredentials: false,
      onProgress: (event: ProgressEvent) => {
        bytesByUrl.set(url, event.loaded);
      },
    });
    pending.add(mesh);
    mesh.initialized.then(
      () => {
        pending.delete(mesh);
        if (disposed) {
          mesh.dispose();
          return;
        }
        onReady(mesh);
      },
      () => {
        pending.delete(mesh);
        mesh.dispose();
        if (!disposed) onFail();
      },
    );
  }

  /**
   * Open a RAD level-of-detail tree: read its header, refuse it unless every
   * chunk it names may be fetched under the asset policy, then hand Spark a
   * paged mesh. No chunk is requested before the check: Spark pages chunks
   * in only for a mesh that is in the scene.
   */
  function openLodTree(
    asset: StreetSceneAsset,
    onReady: (mesh: SplatMesh) => void,
    onFail: () => void,
  ) {
    const tree = new CountedLodTree(asset.url, (bytes) => {
      lodBytes += bytes;
    });
    tree.getRadMeta().then(
      ({ meta, chunksStart }) => {
        if (disposed) {
          tree.dispose();
          return;
        }
        if (!radChunksAllowed(asset.url, meta.chunks, options.assetPolicy)) {
          tree.dispose();
          onFail();
          return;
        }
        lodBytes += chunksStart;
        onReady(new SplatMesh({ paged: tree }));
      },
      () => {
        tree.dispose();
        if (!disposed) onFail();
      },
    );
  }

  function show(mesh: SplatMesh) {
    scene.add(mesh);
    if (shown) {
      scene.remove(shown);
      shown.dispose();
    }
    shown = mesh;
  }

  if (plan.first?.format === 'rad') {
    // Drawn from the first LoD splats on; the loop reports `preview` and
    // `full` as the tree streams (see `frame`).
    openLodTree(plan.first, show, () => setPhase('error'));
  } else if (plan.first) {
    const firstIsFull = plan.first.role === 'splat';
    load(
      plan.first.url,
      (mesh) => {
        show(mesh);
        const elapsed = performance.now() - started;
        if (firstIsFull) fullLoadMs = elapsed;
        else previewLoadMs = elapsed;
        setPhase(firstIsFull ? 'full' : 'preview');
        if (plan.upgrade) {
          load(
            plan.upgrade.url,
            (full) => {
              show(full);
              fullLoadMs = performance.now() - started;
              setPhase('full');
            },
            // The preview is already drawing; a failed upgrade is not an error
            // worth replacing a working scene with.
            () => undefined,
          );
        }
      },
      () => setPhase('error'),
    );
  } else {
    // Nothing this device may load (preview tier with no preview asset): the
    // poster stays, and the screen says why.
    setPhase(options.tier === 'unsupported' ? 'unsupported' : 'preview');
  }

  if (plan.environment) {
    // The far shell shares the scene's frame, so it needs no transform, and
    // Spark sorts every splat together by distance, so it draws behind the
    // street without a layer of its own. It is a backdrop: a failure leaves
    // the scene drawing, not an error.
    openLodTree(
      plan.environment,
      (mesh) => {
        scene.add(mesh);
        environment = mesh;
      },
      () => undefined,
    );
  }

  // ── Input ────────────────────────────────────────────────────────────────

  /** Pointers that look, pan or pinch (never the thumbstick's), client px. */
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let pinchMid: { x: number; y: number } | null = null;

  const twoPointerState = () => {
    const [a, b] = [...pointers.values()];
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  let press: { x: number; y: number; moved: boolean } | null = null;
  /** The mouse over the viewer, viewer px; `null` when it is not, or a button is down. */
  let hover: { x: number; y: number } | null = null;
  /** The thumb on the thumbstick: where it landed, viewer px, and whether it has moved. */
  let thumb: { id: number; x0: number; y0: number; moved: boolean } | null = null;
  const thumbstick: Thumbstick = { x: 0, y: 0, dx: 0, dy: 0 };
  let lastTap: { x: number; y: number; at: number } | null = null;

  function releaseStick() {
    thumb = null;
    stick[0] = 0;
    stick[1] = 0;
    options.onStick(null);
  }

  /** A touch tap: the second of two close together walks there. */
  function tap(x: number, y: number) {
    const now = performance.now();
    if (
      lastTap &&
      now - lastTap.at < DOUBLE_TAP_MS &&
      Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_TAP_SLOP_PX
    ) {
      lastTap = null;
      goToward(x, y);
    } else {
      lastTap = { x, y, at: now };
    }
  }

  function onPointerDown(event: PointerEvent) {
    canvas.setPointerCapture?.(event.pointerId);
    keyTarget.focus({ preventScroll: true });
    hover = null;
    if (
      guided() &&
      event.pointerType === 'touch' &&
      !thumb &&
      event.offsetX < width * STICK_ZONE_RIGHT &&
      event.offsetY > height * STICK_ZONE_TOP
    ) {
      // A thumbstick appears where the thumb lands — once it moves.
      thumb = { id: event.pointerId, x0: event.offsetX, y0: event.offsetY, moved: false };
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    press = pointers.size === 1 ? { x: event.clientX, y: event.clientY, moved: false } : null;
    if (pointers.size === 2) {
      const state = twoPointerState();
      pinchDistance = state.distance;
      pinchMid = state.mid;
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (thumb && event.pointerId === thumb.id) {
      const dx = event.offsetX - thumb.x0;
      const dy = event.offsetY - thumb.y0;
      if (!thumb.moved && Math.hypot(dx, dy) <= CLICK_SLOP_PX) return;
      thumb.moved = true;
      stickInput(dx, dy, stick);
      const length = Math.hypot(dx, dy);
      const k = length > STICK_RADIUS_PX ? STICK_RADIUS_PX / length : 1;
      thumbstick.x = thumb.x0;
      thumbstick.y = thumb.y0;
      thumbstick.dx = dx * k;
      thumbstick.dy = dy * k;
      options.onStick(thumbstick);
      return;
    }
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      // No button down: a mouse hovering, which the ground cursor follows.
      hover = event.pointerType === 'mouse' ? { x: event.offsetX, y: event.offsetY } : null;
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PX)
      press.moved = true;
    if (pointers.size === 1) {
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      // Drag to look: in orbit the scene turns under the finger; walking, the
      // view follows it like turning your head.
      const sign = rig.mode === 'orbit' ? -1 : 1;
      rig.look(sign * dx * LOOK_SPEED, -sign * dy * LOOK_SPEED);
    } else if (pointers.size === 2 && pinchMid && guided()) {
      // Guided pinch narrows the view (a zoom), never moves the camera off
      // the observed ground.
      const state = twoPointerState();
      if (pinchDistance > 0 && state.distance > 0) zoomFov(pinchDistance / state.distance);
      pinchDistance = state.distance;
      pinchMid = state.mid;
    } else if (pointers.size === 2 && pinchMid) {
      const state = twoPointerState();
      if (pinchDistance > 0 && state.distance > 0) rig.zoom(pinchDistance / state.distance);
      const metresPerPixel = 0.02;
      rig.pan(
        -(state.mid.x - pinchMid.x) * metresPerPixel,
        (state.mid.y - pinchMid.y) * metresPerPixel,
      );
      pinchDistance = state.distance;
      pinchMid = state.mid;
    }
  }

  function onPointerUp(event: PointerEvent) {
    const released = event.type === 'pointerup';
    if (thumb && event.pointerId === thumb.id) {
      // A thumb that never moved was a tap, and may be half a double tap.
      const tapped = !thumb.moved && released;
      releaseStick();
      if (tapped) tap(event.offsetX, event.offsetY);
      return;
    }
    const wasClick = press && !press.moved && pointers.size === 1 && released;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchMid = null;
    press = null;
    if (!wasClick || !guided()) return;
    // Walking, a click goes to the ground under it; on touch a double tap
    // does, since a single one is too easily the start of a look.
    if (event.pointerType === 'touch') tap(event.offsetX, event.offsetY);
    else goToward(event.offsetX, event.offsetY);
  }

  function onPointerLeave() {
    hover = null;
  }

  function zoomFov(factor: number) {
    fovZoom = Math.max(0.4, Math.min(1, fovZoom * factor));
    applyFrustum(width / height);
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    const factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.0015)));
    if (guided()) zoomFov(factor);
    else rig.zoom(factor);
  }

  const held = new Set<string>();
  let running = false;
  function onKeyDown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code in MOVE_KEYS || event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      held.add(event.code);
      running = event.shiftKey;
      event.preventDefault();
    }
  }
  function onKeyUp(event: KeyboardEvent) {
    held.delete(event.code);
    running = event.shiftKey;
  }
  function onBlur() {
    held.clear();
  }

  function onContextLost(event: Event) {
    event.preventDefault();
    setPhase('error');
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('webglcontextlost', onContextLost);
  keyTarget.addEventListener('keydown', onKeyDown);
  keyTarget.addEventListener('keyup', onKeyUp);
  keyTarget.addEventListener('blur', onBlur);

  // ── Labels ───────────────────────────────────────────────────────────────

  let labels: readonly SceneViewerLabel[] = [];
  const projected = new THREE.Vector3();
  const viewSpace = new THREE.Vector3();
  let width = 1;
  let height = 1;

  function projectLabels() {
    const positions = new Map<string, { x: number; y: number; depth: number } | null>();
    for (const label of labels) {
      viewSpace.set(...label.position).applyMatrix4(camera.matrixWorldInverse);
      // Behind the camera (view space looks down -z) or too far to read.
      const depth = -viewSpace.z;
      if (depth <= camera.near || depth > LABEL_MAX_DEPTH) {
        positions.set(label.id, null);
        continue;
      }
      projected.set(...label.position).project(camera);
      if (projected.x < -1.05 || projected.x > 1.05 || projected.y < -1.05 || projected.y > 1.05) {
        positions.set(label.id, null);
        continue;
      }
      positions.set(label.id, {
        x: ((projected.x + 1) / 2) * width,
        y: ((1 - projected.y) / 2) * height,
        depth,
      });
    }
    options.onLabels(positions);
  }

  const cursor: GroundCursor = { x: 0, y: 0, radius: 0, squash: 1 };
  let cursorShown = false;
  const toPoint = new THREE.Vector3();
  const upVector = new THREE.Vector3(...up);

  /** The ground cursor under a hovering mouse, while that ground is walkable. */
  function projectCursor() {
    const at = hover;
    if (
      !at ||
      !region ||
      !guided() ||
      pointers.size > 0 ||
      !groundUnder(at.x, at.y) ||
      !region.contains(hit)
    ) {
      if (cursorShown) {
        cursorShown = false;
        options.onCursor(null);
      }
      return;
    }
    viewSpace.set(...hit).applyMatrix4(camera.matrixWorldInverse);
    const depth = Math.max(camera.near, -viewSpace.z);
    // A circle on the ground seen from eye height is an ellipse: flatter the
    // farther and lower it is.
    toPoint.set(...hit).sub(camera.position);
    const focal = height / 2 / Math.tan((camera.fov * Math.PI) / 360);
    cursor.x = at.x;
    cursor.y = at.y;
    cursor.radius = Math.max(6, Math.min(80, (CURSOR_RADIUS_METERS * focal) / depth));
    cursor.squash = Math.max(
      0.2,
      Math.min(1, Math.abs(toPoint.dot(upVector)) / Math.max(0.01, toPoint.length())),
    );
    cursorShown = true;
    options.onCursor(cursor);
  }

  // ── Loop ─────────────────────────────────────────────────────────────────

  let last = performance.now();
  let frames = 0;
  let statsAt = last;

  const pose: CameraPose = { position: [0, 0, 0], target: [0, 0, 0], up: [0, 0, 0] };
  function applyPose() {
    rig.pose(pose);
    camera.up.set(...pose.up);
    camera.position.set(...pose.position);
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld();
  }

  function frame() {
    if (disposed) return;
    const now = performance.now();
    const interval = now - last;
    const dt = Math.min(0.1, interval / 1000);
    last = now;

    if (guided()) {
      walk(now, dt);
    } else if (held.size > 0) {
      let forward = 0;
      let right = 0;
      let rise = 0;
      for (const code of held) {
        const move = MOVE_KEYS[code];
        if (!move) continue;
        forward += move[0];
        right += move[1];
        rise += move[2];
      }
      const step = FREE_WALK_SPEED * (running ? RUN_MULTIPLIER : 1) * dt;
      rig.move(forward * step, right * step, rise * step);
    }

    applyPose();
    renderer.render(scene, camera);
    const step = governor.frame(interval, now, spark.pager?.isPending() ?? false);
    if (step !== null) {
      spark.lodSplatScale = ladder[step].lodScale;
      if (renderer.getPixelRatio() !== ladder[step].pixelRatio)
        renderer.setPixelRatio(ladder[step].pixelRatio);
    }
    // A paged scene has drawn only once the LoD traversal has handed it splats.
    const drawing = shown !== null && (!shown.paged || shown.paged.numSplats > 0);
    if (drawing && firstFrameMs === null) firstFrameMs = now - started;
    if (drawing && shown?.paged) {
      if (phase === 'loading') {
        previewLoadMs = now - started;
        lodBusyAt = now;
        setPhase('preview');
      } else if (phase === 'preview') {
        if (spark.pager?.isPending()) lodBusyAt = now;
        else if (now - lodBusyAt >= LOD_SETTLE_MS) {
          fullLoadMs = now - started;
          setPhase('full');
        }
      }
    }
    projectLabels();
    projectCursor();

    frames += 1;
    if (now - statsAt >= STATS_INTERVAL_MS) {
      const fps = (frames * 1000) / (now - statsAt);
      frames = 0;
      statsAt = now;
      let bytes = lodBytes;
      for (const value of bytesByUrl.values()) bytes += value;
      options.onStats({
        fps: Math.round(fps),
        firstFrameMs: firstFrameMs === null ? null : Math.round(firstFrameMs),
        previewLoadMs: previewLoadMs === null ? null : Math.round(previewLoadMs),
        fullLoadMs: fullLoadMs === null ? null : Math.round(fullLoadMs),
        splats: spark.activeSplats,
        bytes,
        pixelRatio: renderer.getPixelRatio(),
        lodScale: spark.lodSplatScale,
        tier: options.tier,
      });
    }
  }

  // Stop drawing in a hidden tab: a splat scene is a busy GPU loop, and a
  // background tab burning battery is the kind of cost nobody sees.
  function onVisibility() {
    if (disposed) return;
    if (document.hidden) {
      renderer.setAnimationLoop(null);
    } else {
      last = performance.now();
      renderer.setAnimationLoop(frame);
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  renderer.setAnimationLoop(frame);

  return {
    setLabels(next) {
      labels = next;
    },
    setMode(next) {
      mode = next;
      if (guided()) {
        enterGuided();
      } else {
        glide = null;
        if (thumb) releaseStick();
        rig.setPitchLimit(MAX_PITCH);
        rig.setMode(next);
      }
    },
    resetView() {
      rig.reset();
      if (guided()) {
        glide = null;
        placed = false;
        enterGuided();
      }
    },
    resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      renderer.setSize(width, height, false);
      applyFrustum(width / height);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      keyTarget.removeEventListener('keydown', onKeyDown);
      keyTarget.removeEventListener('keyup', onKeyUp);
      keyTarget.removeEventListener('blur', onBlur);
      for (const mesh of [shown, environment]) {
        if (!mesh) continue;
        scene.remove(mesh);
        mesh.dispose();
      }
      shown = null;
      environment = null;
      // Meshes still decoding, and trees still reading their header, are
      // disposed when they land (see `load` and `openLodTree`). The Spark
      // renderer frees the page pool and the sort and LoD workers.
      scene.remove(spark);
      spark.dispose();
      renderer.dispose();
      // Release the GPU memory now rather than whenever the context is GC'd.
      renderer.forceContextLoss();
    },
  };
}
