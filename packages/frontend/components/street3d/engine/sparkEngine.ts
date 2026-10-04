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
 *    tree. `dispose()` stops the loop, frees both meshes and the Spark
 *    renderer, and forces the context to be lost so the GPU memory is
 *    reclaimed now, not at the next GC.
 *  - **Progressive detail.** The light `splat_preview` is drawn as soon as it
 *    decodes; the full `splat` streams in behind it and replaces it. The user
 *    is never staring at a spinner for a file they may not need.
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
import { SparkRenderer, SplatFileType, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';

import { createCameraRig, type CameraRig } from '../cameraRig';
import type { SceneAssetPlan } from '../assets';
import type { SceneViewerControlMode, SceneViewerLabel, SceneViewerPhase, SceneViewerStats, Vec3 } from '../types';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Receives key events; the canvas container, which is focusable. */
  keyTarget: HTMLElement;
  plan: SceneAssetPlan;
  initialView: { position: Vec3; target: Vec3 };
  /** World up in scene coordinates (from `worldTransform`). */
  up: Vec3;
  pixelRatio: number;
  tier: SceneViewerStats['tier'];
  onPhase: (phase: SceneViewerPhase) => void;
  onStats: (stats: SceneViewerStats) => void;
  /** Called each frame with every label's screen position, or `null` when hidden. */
  onLabels: (positions: ReadonlyMap<string, { x: number; y: number; depth: number } | null>) => void;
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
/** Metres per second of WASD walking; Shift runs. */
const WALK_SPEED = 4;
const RUN_MULTIPLIER = 3;
/** Labels farther than this from the camera are not drawn. */
const LABEL_MAX_DEPTH = 220;
const STATS_INTERVAL_MS = 1000;

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
  renderer.setPixelRatio(options.pixelRatio);
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const rig: CameraRig = createCameraRig({ ...options.initialView, up: options.up });

  let disposed = false;
  let phase: SceneViewerPhase = 'loading';
  let current: SplatMesh | null = null;
  const pending = new Set<SplatMesh>();
  const bytesByUrl = new Map<string, number>();
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

  function show(mesh: SplatMesh) {
    scene.add(mesh);
    if (current) {
      scene.remove(current);
      current.dispose();
    }
    current = mesh;
  }

  if (plan.first) {
    const firstIsFull = plan.first.role === 'splat';
    load(
      plan.first.url,
      (mesh) => {
        show(mesh);
        const elapsed = performance.now() - started;
        if (firstIsFull) fullLoadMs = elapsed;
        else previewLoadMs = elapsed;
        setPhase(firstIsFull ? 'full' : 'preview');
        if (plan.then) {
          load(
            plan.then.url,
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

  // ── Input ────────────────────────────────────────────────────────────────

  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  let pinchMid: { x: number; y: number } | null = null;

  const twoPointerState = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  function onPointerDown(event: PointerEvent) {
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const state = twoPointerState();
      pinchDistance = state.distance;
      pinchMid = state.mid;
    }
    keyTarget.focus({ preventScroll: true });
  }

  function onPointerMove(event: PointerEvent) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      // Drag to look: in orbit the scene turns under the finger; walking, the
      // view follows it like turning your head.
      const sign = rig.mode === 'orbit' ? -1 : 1;
      rig.look(sign * dx * LOOK_SPEED, -sign * dy * LOOK_SPEED);
    } else if (pointers.size === 2 && pinchMid) {
      const state = twoPointerState();
      if (pinchDistance > 0 && state.distance > 0) rig.zoom(pinchDistance / state.distance);
      const metresPerPixel = 0.02;
      rig.pan(-(state.mid.x - pinchMid.x) * metresPerPixel, (state.mid.y - pinchMid.y) * metresPerPixel);
      pinchDistance = state.distance;
      pinchMid = state.mid;
    }
  }

  function onPointerUp(event: PointerEvent) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchMid = null;
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    rig.zoom(Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.0015))));
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

  // ── Loop ─────────────────────────────────────────────────────────────────

  let last = performance.now();
  let frames = 0;
  let statsAt = last;

  function applyPose() {
    const pose = rig.pose();
    camera.up.set(...pose.up);
    camera.position.set(...pose.position);
    camera.lookAt(...pose.target);
    camera.updateMatrixWorld();
  }

  function frame() {
    if (disposed) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    if (held.size > 0) {
      let forward = 0;
      let right = 0;
      let up = 0;
      for (const code of held) {
        const move = MOVE_KEYS[code];
        if (!move) continue;
        forward += move[0];
        right += move[1];
        up += move[2];
      }
      const step = WALK_SPEED * (running ? RUN_MULTIPLIER : 1) * dt;
      rig.move(forward * step, right * step, up * step);
    }

    applyPose();
    renderer.render(scene, camera);
    if (current && firstFrameMs === null) firstFrameMs = now - started;
    projectLabels();

    frames += 1;
    if (now - statsAt >= STATS_INTERVAL_MS) {
      const fps = (frames * 1000) / (now - statsAt);
      frames = 0;
      statsAt = now;
      let bytes = 0;
      for (const value of bytesByUrl.values()) bytes += value;
      options.onStats({
        fps: Math.round(fps),
        firstFrameMs: firstFrameMs === null ? null : Math.round(firstFrameMs),
        previewLoadMs: previewLoadMs === null ? null : Math.round(previewLoadMs),
        fullLoadMs: fullLoadMs === null ? null : Math.round(fullLoadMs),
        bytes,
        pixelRatio: renderer.getPixelRatio(),
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
    setMode(mode) {
      rig.setMode(mode);
    },
    resetView() {
      rig.reset();
    },
    resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
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
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      keyTarget.removeEventListener('keydown', onKeyDown);
      keyTarget.removeEventListener('keyup', onKeyUp);
      keyTarget.removeEventListener('blur', onBlur);
      if (current) {
        scene.remove(current);
        current.dispose();
        current = null;
      }
      // Meshes still decoding are disposed when they land (see `load`).
      scene.remove(spark);
      spark.dispose();
      renderer.dispose();
      // Release the GPU memory now rather than whenever the context is GC'd.
      renderer.forceContextLoss();
    },
  };
}
