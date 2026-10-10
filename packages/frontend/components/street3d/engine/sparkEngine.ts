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

import type { StreetSceneNavigation } from '@goway.to/sdk';

import { createCameraRig, MAX_PITCH, type CameraRig } from '../cameraRig';
import {
  easeInOut,
  GUIDED_MAX_PITCH_DEGREES,
  lerp3,
  nearestViewpoint,
  nextViewpoint,
  reachableViewpoints,
  STEP_DURATION_MS,
  VIEWPOINT_HEIGHT_METERS,
  viewFrustum,
  type ViewFrustum,
} from '../guidedNavigation';
import type { SceneAssetPlan } from '../assets';
import type {
  SceneViewerControlMode,
  SceneViewerLabel,
  SceneViewerPhase,
  SceneViewerStats,
  Vec3,
} from '../types';

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
  onLabels: (
    positions: ReadonlyMap<string, { x: number; y: number; depth: number } | null>,
  ) => void;
  /** Guided-navigation data from the manifest; absent → free orbit/walk only. */
  navigation?: StreetSceneNavigation;
  /** The viewpoints a step can reach from where the camera now stands (guided only). */
  onReachable: (indices: readonly number[]) => void;
  /** Each frame: every reachable marker's screen ellipse, or `null` when hidden. */
  onSteps: (positions: ReadonlyMap<number, StepMarkerPosition | null>) => void;
  /** The camera's field of view and side mask, whenever they change. */
  onFrustum: (frustum: ViewFrustum) => void;
}

/** A ground marker projected to the screen: centre, radius in px, vertical squash 0–1. */
export interface StepMarkerPosition {
  x: number;
  y: number;
  radius: number;
  squash: number;
}

export interface SceneEngine {
  setLabels(labels: readonly SceneViewerLabel[]): void;
  setMode(mode: SceneViewerControlMode): void;
  resetView(): void;
  resize(width: number, height: number): void;
  /** Guided: glide to the next viewpoint ahead (`1`) or behind (`-1`). */
  step(sign: 1 | -1): void;
  /** Guided: glide to a specific viewpoint. */
  goTo(index: number): void;
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
/** Guided turning with A/D or ←/→, radians per second. */
const TURN_SPEED = Math.PI / 2;
/** A pointer that moved less than this between down and up is a click, px. */
const CLICK_SLOP_PX = 6;
/** How long step markers stay after the pointer last moved, ms. */
const STEP_MARKERS_LINGER_MS = 1800;
/** Ground marker radius, metres. */
const STEP_MARKER_RADIUS_METERS = 0.35;
const FREE_VERTICAL_FOV = 60;

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
  const camera = new THREE.PerspectiveCamera(FREE_VERTICAL_FOV, 1, 0.05, 2000);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const rig: CameraRig = createCameraRig({ ...options.initialView, up: options.up });

  // ── Guided navigation ────────────────────────────────────────────────────
  //
  // With `navigation`, Walk is Street-View-style: the camera stands on a
  // captured viewpoint and glides between them; the look is free but pitch is
  // clamped and the FOV bounded by the capture. Orbit stays free (secondary).

  const viewpoints = options.navigation?.viewpoints ?? [];
  const capturedFov = options.navigation?.fieldOfView;
  const hasNavigation = viewpoints.length > 0;
  let mode: SceneViewerControlMode = 'orbit';
  let standing = hasNavigation ? nearestViewpoint(viewpoints, options.initialView.position) : -1;
  let placed = false;
  let glide: { from: Vec3; to: Vec3; start: number; index: number } | null = null;
  let queuedStep: (() => void) | null = null;
  let reachable: number[] = [];
  let fovZoom = 1;
  let stepsVisibleUntil = 0;
  const guided = () => hasNavigation && mode === 'walk';

  function reportReachable() {
    reachable =
      guided() && standing >= 0 ? reachableViewpoints(viewpoints, standing, options.up) : [];
    options.onReachable(reachable);
  }

  function enterGuided() {
    rig.setMode('walk');
    rig.setPitchLimit((GUIDED_MAX_PITCH_DEGREES * Math.PI) / 180);
    const start = viewpoints[standing];
    rig.placeAt(start.position);
    if (!placed) {
      placed = true;
      // Face where the publisher's opening view faces, from the viewpoint.
      const target = options.initialView.target;
      const toward: Vec3 = [
        target[0] - start.position[0],
        target[1] - start.position[1],
        target[2] - start.position[2],
      ];
      rig.lookToward(Math.hypot(...toward) > 0.1 ? toward : start.forward);
    }
    stepsVisibleUntil = performance.now() + STEP_MARKERS_LINGER_MS;
    reportReachable();
  }

  function goTo(index: number) {
    if (!guided() || index < 0 || index >= viewpoints.length || index === standing) return;
    if (glide) {
      queuedStep = () => goTo(index);
      return;
    }
    glide = {
      from: rig.pose().position,
      to: viewpoints[index].position,
      start: performance.now(),
      index,
    };
  }

  function stepToward(direction: Vec3) {
    if (!guided() || standing < 0) return;
    if (glide) {
      queuedStep = () => stepToward(direction);
      return;
    }
    const next = nextViewpoint(viewpoints, standing, direction, options.up);
    if (next) goTo(next.index);
  }

  function step(sign: 1 | -1) {
    const d = rig.direction();
    stepToward([d[0] * sign, d[1] * sign, d[2] * sign]);
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
    if (shown) {
      scene.remove(shown);
      shown.dispose();
    }
    shown = mesh;
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
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  };

  let press: { x: number; y: number; moved: boolean } | null = null;

  function onPointerDown(event: PointerEvent) {
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    press = pointers.size === 1 ? { x: event.clientX, y: event.clientY, moved: false } : null;
    if (pointers.size === 2) {
      const state = twoPointerState();
      pinchDistance = state.distance;
      pinchMid = state.mid;
    }
    keyTarget.focus({ preventScroll: true });
  }

  // Hovering anywhere over the viewer — the canvas or a marker on it — or
  // dragging reveals the step markers, like Street View's chevrons.
  function onHover() {
    stepsVisibleUntil = performance.now() + STEP_MARKERS_LINGER_MS;
  }

  function onPointerMove(event: PointerEvent) {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
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
      // the viewpoint graph.
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
    const wasClick = press && !press.moved && pointers.size === 1 && event.type === 'pointerup';
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchMid = null;
    press = null;
    if (wasClick && guided()) {
      // Click a spot ahead to walk toward it: the ray through the click picks
      // the direction, the viewpoint graph picks the destination.
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector3(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
        0.5,
      ).unproject(camera);
      ndc.sub(camera.position);
      stepToward([ndc.x, ndc.y, ndc.z]);
    }
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
    if (
      guided() &&
      (event.code === 'KeyW' ||
        event.code === 'ArrowUp' ||
        event.code === 'KeyS' ||
        event.code === 'ArrowDown')
    ) {
      event.preventDefault();
      // A held key keeps walking, one viewpoint per glide.
      if (!event.repeat || !glide) step(event.code === 'KeyW' || event.code === 'ArrowUp' ? 1 : -1);
      return;
    }
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
  keyTarget.addEventListener('pointermove', onHover);
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

  const stepPoint = new THREE.Vector3();
  const toPoint = new THREE.Vector3();
  const upVector = new THREE.Vector3(...options.up);

  function projectSteps(now: number) {
    const positions = new Map<number, StepMarkerPosition | null>();
    const visible = guided() && !glide && now < stepsVisibleUntil;
    const focal = height / 2 / Math.tan((camera.fov * Math.PI) / 360);
    for (const index of reachable) {
      if (!visible) {
        positions.set(index, null);
        continue;
      }
      const p = viewpoints[index].position;
      stepPoint.set(
        p[0] - options.up[0] * VIEWPOINT_HEIGHT_METERS,
        p[1] - options.up[1] * VIEWPOINT_HEIGHT_METERS,
        p[2] - options.up[2] * VIEWPOINT_HEIGHT_METERS,
      );
      viewSpace.copy(stepPoint).applyMatrix4(camera.matrixWorldInverse);
      const depth = -viewSpace.z;
      if (depth <= camera.near) {
        positions.set(index, null);
        continue;
      }
      projected.copy(stepPoint).project(camera);
      if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) {
        positions.set(index, null);
        continue;
      }
      // A circle on the ground seen from eye height is an ellipse: flatter the
      // farther and lower it is.
      toPoint.copy(stepPoint).sub(camera.position);
      const squash = Math.max(
        0.2,
        Math.min(1, Math.abs(toPoint.dot(upVector)) / Math.max(0.01, toPoint.length())),
      );
      positions.set(index, {
        x: ((projected.x + 1) / 2) * width,
        y: ((1 - projected.y) / 2) * height,
        radius: Math.max(6, Math.min(80, (STEP_MARKER_RADIUS_METERS * focal) / depth)),
        squash,
      });
    }
    options.onSteps(positions);
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

    if (glide) {
      const t = (now - glide.start) / STEP_DURATION_MS;
      rig.placeAt(lerp3(glide.from, glide.to, easeInOut(t)));
      if (t >= 1) {
        standing = glide.index;
        glide = null;
        stepsVisibleUntil = now + STEP_MARKERS_LINGER_MS;
        reportReachable();
        const next = queuedStep;
        queuedStep = null;
        next?.();
      }
    }

    if (guided()) {
      // Guided: A/D and ←/→ turn the head; they never strafe into the gap.
      let turn = 0;
      if (held.has('KeyA') || held.has('ArrowLeft')) turn -= 1;
      if (held.has('KeyD') || held.has('ArrowRight')) turn += 1;
      if (turn !== 0) rig.look(turn * TURN_SPEED * dt, 0);
    } else if (held.size > 0) {
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
    if (shown && firstFrameMs === null) firstFrameMs = now - started;
    projectLabels();
    projectSteps(now);

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
    setMode(next) {
      mode = next;
      if (guided()) {
        enterGuided();
      } else {
        glide = null;
        queuedStep = null;
        rig.setPitchLimit(MAX_PITCH);
        rig.setMode(next);
        reportReachable();
      }
    },
    resetView() {
      rig.reset();
      if (guided()) {
        standing = nearestViewpoint(viewpoints, options.initialView.position);
        placed = false;
        enterGuided();
      }
    },
    step,
    goTo,
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
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      keyTarget.removeEventListener('pointermove', onHover);
      keyTarget.removeEventListener('keydown', onKeyDown);
      keyTarget.removeEventListener('keyup', onKeyUp);
      keyTarget.removeEventListener('blur', onBlur);
      if (shown) {
        scene.remove(shown);
        shown.dispose();
        shown = null;
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
