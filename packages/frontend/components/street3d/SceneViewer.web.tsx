/**
 * `SceneViewer`, web — a Gaussian splat scene on a real `<canvas>`.
 *
 * The engine (`engine/sparkEngine.ts`, three.js + Spark) is loaded with a
 * dynamic `import()` on mount, so its multi-megabyte chunk is paid for only
 * by someone who actually opens a 3D view. It is reached through
 * `components/engine3d/lazyChunk.ts`, the one async boundary every three.js
 * consumer shares, so that three.js is never hoisted into the first-paint
 * `__common` chunk (see that file). Until it has drawn, the screen's
 * poster is what the user sees (see `features/street3d/Street3dScreen.tsx`).
 *
 * Device capability is judged BEFORE the engine is fetched: a device without
 * WebGL2 never downloads a renderer it cannot run, and a constrained one is
 * told to load the preview only, or a level-of-detail scene at a smaller
 * budget (`deviceProfile.ts`).
 *
 * Labels, the ground cursor and the touch thumbstick are elements positioned
 * by direct style writes from the engine's per-frame projection — sixty React
 * renders a second for forty labels is the wrong tool, and a label lagging its
 * building by a frame reads as the label sliding.
 */
import {
  type ComponentRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';

import { STREET3D_ASSET_ORIGIN } from '@/lib/config';
import { sceneUp } from '@/lib/street3d/geodesy';

import { planSceneAssets } from './assets';
import { assessDevice, type DeviceSignals } from './deviceProfile';
import type { SceneEngine } from './engine/sparkEngine';
import { STICK_RADIUS_PX } from './guidedNavigation';
import type {
  SceneViewerLabel,
  SceneViewerPhase,
  SceneViewerProps,
  SceneViewerStats,
  Vec3,
} from './types';

interface NavigatorSignals {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
  userAgentData?: { mobile?: boolean };
  userAgent?: string;
}

/** Read what the browser will tell us. Probes WebGL2 on a throwaway canvas. */
function readDeviceSignals(fullSplatBytes: number | undefined): DeviceSignals {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as NavigatorSignals;
  let webgl2 = false;
  let maxTextureSize: number | undefined;
  let gpuRenderer: string | undefined;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (gl) {
      webgl2 = true;
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) gpuRenderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    webgl2 = false;
  }
  return {
    webgl2,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 1,
    deviceMemoryGb: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    saveData: nav.connection?.saveData,
    effectiveType: nav.connection?.effectiveType,
    maxTextureSize,
    gpuRenderer,
    mobile: nav.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(nav.userAgent ?? ''),
    fullSplatBytes,
  };
}

/** `http:` asset URLs are tolerated only in a development build. */
const ALLOW_INSECURE_ASSETS = process.env.NODE_ENV !== 'production';

function SceneViewerComponent({
  manifest,
  labels,
  onLabelPress,
  controlMode = 'orbit',
  onPhaseChange,
  onStats,
  showStats = false,
  style,
  testID,
}: SceneViewerProps) {
  const hostRef = useRef<ComponentRef<typeof View>>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<SceneEngine | null>(null);
  const labelElements = useRef(new Map<string, HTMLElement>());
  const [stats, setStats] = useState<SceneViewerStats | null>(null);
  // Guided walk: the side mask, the ground cursor and the touch thumbstick.
  const [sideMask, setSideMask] = useState(0);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);
  const hasNavigation = (manifest.navigation?.viewpoints.length ?? 0) > 0;

  // Callbacks change identity every render; the engine is built once per
  // manifest and reads them through this ref.
  const handlers = useRef({ onPhaseChange, onStats });

  const visibleLabels = useMemo(() => labels ?? [], [labels]);
  // Read when the engine finishes loading, which is after the first render.
  const latest = useRef({ labels: visibleLabels, controlMode });
  useLayoutEffect(() => {
    handlers.current = { onPhaseChange, onStats };
    latest.current = { labels: visibleLabels, controlMode };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the engine is rebuilt per scene VERSION, never per render
  useEffect(() => {
    const host = hostRef.current as unknown as HTMLElement | null;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let cancelled = false;
    let observer: ResizeObserver | null = null;
    const report = (phase: SceneViewerPhase) => {
      if (!cancelled) handlers.current.onPhaseChange?.(phase);
    };

    const full = manifest.assets.find((asset) => asset.role === 'splat');
    // Only a splat loaded whole is weighed against memory: a `rad` tree holds
    // what its budget draws, and its `byteSize` is a header's.
    const device = assessDevice(
      readDeviceSignals(full?.format === 'spz' ? full.byteSize : undefined),
    );
    if (device.tier === 'unsupported') {
      report('unsupported');
      return;
    }
    const assetPolicy = {
      allowedOrigin: STREET3D_ASSET_ORIGIN,
      allowInsecure: ALLOW_INSECURE_ASSETS,
    };
    const plan = planSceneAssets(manifest, device.tier, assetPolicy);
    if (!plan.first && device.tier === 'full') {
      // Every splat URL was refused by the asset policy, or none was published.
      report('error');
      return;
    }
    const up: Vec3 = sceneUp(manifest.worldTransform.enuFromScene) ?? [0, 1, 0];

    report('loading');
    import('@/components/engine3d/lazyChunk')
      .then(({ createSceneEngine }) => {
        if (cancelled) return;
        const engine = createSceneEngine({
          canvas,
          keyTarget: host,
          plan,
          initialView: {
            position: manifest.initialView.position,
            target: manifest.initialView.target,
          },
          up,
          quality: {
            start: { lodScale: device.lodScale, pixelRatio: device.pixelRatio },
            max: { lodScale: device.maxLodScale, pixelRatio: device.maxPixelRatio },
            min: { lodScale: device.minLodScale, pixelRatio: 1 },
          },
          assetPolicy,
          tier: device.tier,
          onPhase: report,
          onStats: (next) => {
            if (cancelled) return;
            handlers.current.onStats?.(next);
            setStats(next);
          },
          navigation: manifest.navigation,
          onFrustum: (frustum) => {
            if (!cancelled) setSideMask(Math.round(frustum.sideMask * 1000) / 1000);
          },
          onCursor: (at) => {
            const element = cursorRef.current;
            if (!element) return;
            if (!at) {
              element.style.opacity = '0';
              return;
            }
            element.style.opacity = '1';
            element.style.width = `${(at.radius * 2).toFixed(1)}px`;
            element.style.height = `${(at.radius * 2).toFixed(1)}px`;
            element.style.transform = `translate(${(at.x - at.radius).toFixed(1)}px, ${(at.y - at.radius).toFixed(1)}px) scaleY(${at.squash.toFixed(3)})`;
          },
          onStick: (at) => {
            const base = stickRef.current;
            const knob = knobRef.current;
            if (!base || !knob) return;
            if (!at) {
              base.style.opacity = '0';
              return;
            }
            base.style.opacity = '1';
            base.style.transform = `translate(${(at.x - STICK_RADIUS_PX).toFixed(1)}px, ${(at.y - STICK_RADIUS_PX).toFixed(1)}px)`;
            knob.style.transform = `translate(${at.dx.toFixed(1)}px, ${at.dy.toFixed(1)}px)`;
          },
          onLabels: (positions) => {
            for (const [id, element] of labelElements.current) {
              const at = positions.get(id);
              if (!at) {
                element.style.visibility = 'hidden';
                continue;
              }
              element.style.visibility = 'visible';
              element.style.transform = `translate(-50%, -100%) translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
              // Nearer labels on top, so a far label never covers a near one.
              element.style.zIndex = String(10_000 - Math.round(at.depth));
            }
          },
        });
        engineRef.current = engine;
        engine.setLabels(latest.current.labels);
        engine.setMode(latest.current.controlMode);
        // A full-screen viewer takes the keyboard: WASD and the arrows work at
        // once, without a first click (which, walking, is itself a move).
        host.focus({ preventScroll: true });
        const resize = () => engine.resize(host.clientWidth, host.clientHeight);
        resize();
        observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
        observer?.observe(host);
      })
      .catch(() => report('error'));

    return () => {
      cancelled = true;
      observer?.disconnect();
      engineRef.current?.dispose();
      engineRef.current = null;
    };
    // The engine is rebuilt per scene VERSION, never per render.
  }, [manifest.id, manifest.version]);

  useEffect(() => {
    engineRef.current?.setMode(controlMode);
  }, [controlMode]);

  useEffect(() => {
    engineRef.current?.setLabels(visibleLabels);
  }, [visibleLabels]);

  const registerLabel = useCallback((id: string, element: HTMLElement | null) => {
    if (element) {
      element.style.visibility = 'hidden';
      labelElements.current.set(id, element);
    } else {
      labelElements.current.delete(id);
    }
  }, []);

  return (
    <View
      ref={hostRef}
      style={style}
      className="flex-1 overflow-hidden"
      testID={testID}
      // Focusable so WASD/arrow keys reach the viewer without global listeners.
      focusable
      // react-native-web passes this through as the DOM attribute.
      {...({ tabIndex: 0 } as object)}
      accessibilityLabel="Street 3D view"
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          touchAction: 'none',
          outline: 'none',
        }}
      />
      {hasNavigation ? <EdgeShade sideMask={sideMask} /> : null}
      {hasNavigation ? (
        <>
          <div ref={cursorRef} aria-hidden style={CURSOR_STYLE} />
          <div ref={stickRef} aria-hidden style={STICK_STYLE}>
            <div ref={knobRef} style={KNOB_STYLE} />
          </div>
        </>
      ) : null}
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        {visibleLabels.map((label) => (
          <SceneLabel
            key={label.id}
            label={label}
            register={registerLabel}
            onPress={onLabelPress}
          />
        ))}
      </View>
      {showStats && stats ? <StatsOverlay stats={stats} /> : null}
    </View>
  );
}

/**
 * The ground cursor: where a click walks to, under the pointer, drawn only
 * while that ground is walkable. Translucent white with a soft ring, like
 * Street View's: it sits ON the photograph, where a theme colour would read as
 * UI pasted over the street. Positioned per frame by the engine; it never
 * takes the pointer.
 */
const CURSOR_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.22)',
  border: '2px solid rgba(255, 255, 255, 0.85)',
  boxShadow: '0 0 8px rgba(0, 0, 0, 0.35)',
  pointerEvents: 'none',
  opacity: 0,
  transition: 'opacity 120ms ease-out',
  transformOrigin: '50% 50%',
} as const;

/**
 * The touch thumbstick, where the thumb landed and only while it holds: a
 * ring of the stick's reach and a knob that follows the thumb. Photographic
 * white over the scene, like the cursor. Positioned by the engine.
 */
const STICK_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: STICK_RADIUS_PX * 2,
  height: STICK_RADIUS_PX * 2,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.12)',
  border: '2px solid rgba(255, 255, 255, 0.6)',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
  opacity: 0,
} as const;

const KNOB_STYLE = {
  width: 40,
  height: 40,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.7)',
  boxShadow: '0 0 8px rgba(0, 0, 0, 0.35)',
} as const;

/**
 * Darkens what the capture never saw, and softly fades every edge.
 *
 * `sideMask` is the fraction of the width, per side, beyond the captured
 * horizontal field of view (a portrait capture on a landscape screen). Those
 * bands are shaded almost to black with a soft inner edge rather than drawn —
 * the splat there is extrapolation, and extrapolation is the shards and
 * needles. Shade is photographic black, not a theme colour: it stands for
 * "no imagery", which is the same in light and dark mode.
 */
function EdgeShade({ sideMask }: { sideMask: number }) {
  const band = `${(sideMask * 100).toFixed(2)}%`;
  const soft = `${(Math.min(0.5, sideMask + 0.06) * 100).toFixed(2)}%`;
  const sides =
    sideMask > 0
      ? `linear-gradient(to right, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.92) ${band}, rgba(0,0,0,0) ${soft}, ` +
        `rgba(0,0,0,0) calc(100% - ${soft}), rgba(0,0,0,0.92) calc(100% - ${band}), rgba(0,0,0,0.92) 100%)`
      : null;
  const vignette = 'radial-gradient(ellipse at center, rgba(0,0,0,0) 62%, rgba(0,0,0,0.38) 100%)';
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        background: sides ? `${sides}, ${vignette}` : vignette,
      }}
    />
  );
}

const SceneLabel = memo(function SceneLabel({
  label,
  register,
  onPress,
}: {
  label: SceneViewerLabel;
  register: (id: string, element: HTMLElement | null) => void;
  onPress?: (id: string) => void;
}) {
  const ref = useCallback(
    (node: ComponentRef<typeof Pressable> | null) =>
      register(label.id, node as unknown as HTMLElement | null),
    [label.id, register],
  );
  return (
    <Pressable
      ref={ref}
      onPress={() => onPress?.(label.id)}
      accessibilityRole="link"
      accessibilityLabel={label.name}
      style={{ position: 'absolute', left: 0, top: 0 }}
      className="max-w-48 rounded-radius-max bg-card px-space-8 py-space-4 shadow-s"
    >
      <Text className="text-caption text-foreground" numberOfLines={1}>
        {label.name}
      </Text>
    </Pressable>
  );
});

function StatsOverlay({ stats }: { stats: SceneViewerStats }) {
  const kb = Math.round(stats.bytes / 1024);
  const splats = `${(stats.splats / 1e6).toFixed(2)}M`;
  return (
    // Below the screen's top chrome, which owns the corners.
    <View
      pointerEvents="none"
      className="absolute rounded-radius-8 bg-card px-space-8 py-space-4"
      style={{ top: 64, left: 16 }}
    >
      <Text className="text-caption text-muted-foreground">
        {`${stats.fps} fps · ${splats} splats · ${kb} KB · dpr ${stats.pixelRatio} · lod ×${stats.lodScale.toFixed(2)} · ${stats.tier}`}
      </Text>
      <Text className="text-caption text-muted-foreground">
        {`first ${stats.firstFrameMs ?? '–'} ms · preview ${stats.previewLoadMs ?? '–'} ms · full ${stats.fullLoadMs ?? '–'} ms`}
      </Text>
    </View>
  );
}

export const SceneViewer = memo(SceneViewerComponent);
