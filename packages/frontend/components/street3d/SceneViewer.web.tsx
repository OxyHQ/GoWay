/**
 * `SceneViewer`, web — a Gaussian splat scene on a real `<canvas>`.
 *
 * The engine (`engine/sparkEngine.ts`, three.js + Spark) is loaded with a
 * dynamic `import()` on mount, so its multi-megabyte chunk is paid for only
 * by someone who actually opens a 3D view. Until it has drawn, the screen's
 * poster is what the user sees (see `features/street3d/Street3dScreen.tsx`).
 *
 * Device capability is judged BEFORE the engine is fetched: a device without
 * WebGL2 never downloads a renderer it cannot run, and a constrained one is
 * told to load the preview only (`deviceProfile.ts`).
 *
 * Labels are React elements positioned by direct style writes from the
 * engine's per-frame projection — sixty React renders a second for forty
 * labels is the wrong tool, and a label lagging its building by a frame
 * reads as the label sliding.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Fab } from '@oxy.so/bloom/fab';
import { RiArrowDownLine } from '@oxy.so/bloom/icons/RiArrowDownLine';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { Text } from '@oxy.so/bloom/typography';

import { STREET3D_ASSET_ORIGIN } from '@/lib/config';
import { useTranslation } from '@/lib/i18n';
import { sceneUp } from '@/lib/street3d/geodesy';

import { planSceneAssets } from './assets';
import { assessDevice, type DeviceSignals } from './deviceProfile';
import type { SceneEngine } from './engine/sparkEngine';
import type { SceneViewerLabel, SceneViewerPhase, SceneViewerProps, SceneViewerStats, Vec3 } from './types';

interface NavigatorSignals {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: { saveData?: boolean; effectiveType?: string };
}

/** Read what the browser will tell us. Probes WebGL2 on a throwaway canvas. */
function readDeviceSignals(fullSplatBytes: number | undefined): DeviceSignals {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as NavigatorSignals;
  let webgl2 = false;
  let maxTextureSize: number | undefined;
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    if (gl) {
      webgl2 = true;
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
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
  const hostRef = useRef<View>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<SceneEngine | null>(null);
  const labelElements = useRef(new Map<string, HTMLElement>());
  const [stats, setStats] = useState<SceneViewerStats | null>(null);
  const { t } = useTranslation();
  // Guided navigation: the reachable viewpoints (markers) and the side mask.
  const [reachable, setReachable] = useState<readonly number[]>([]);
  const [sideMask, setSideMask] = useState(0);
  const stepElements = useRef(new Map<number, HTMLElement>());
  const hasNavigation = (manifest.navigation?.viewpoints.length ?? 0) > 0;
  const guided = hasNavigation && controlMode === 'walk';

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
    const device = assessDevice(readDeviceSignals(full?.byteSize));
    if (device.tier === 'unsupported') {
      report('unsupported');
      return;
    }
    const plan = planSceneAssets(manifest, device.tier, {
      allowedOrigin: STREET3D_ASSET_ORIGIN,
      allowInsecure: ALLOW_INSECURE_ASSETS,
    });
    if (!plan.first && device.tier === 'full') {
      // Every splat URL was refused by the asset policy, or none was published.
      report('error');
      return;
    }
    const up: Vec3 = sceneUp(manifest.worldTransform.enuFromScene) ?? [0, 1, 0];

    report('loading');
    import('./engine/sparkEngine')
      .then(({ createSceneEngine }) => {
        if (cancelled) return;
        const engine = createSceneEngine({
          canvas,
          keyTarget: host,
          plan,
          initialView: { position: manifest.initialView.position, target: manifest.initialView.target },
          up,
          pixelRatio: device.pixelRatio,
          tier: device.tier,
          onPhase: report,
          onStats: (next) => {
            if (cancelled) return;
            handlers.current.onStats?.(next);
            setStats(next);
          },
          navigation: manifest.navigation,
          onReachable: (indices) => {
            if (!cancelled) setReachable(indices);
          },
          onFrustum: (frustum) => {
            if (!cancelled) setSideMask(Math.round(frustum.sideMask * 1000) / 1000);
          },
          onSteps: (positions) => {
            for (const [index, element] of stepElements.current) {
              const at = positions.get(index);
              if (!at) {
                element.style.opacity = '0';
                element.style.pointerEvents = 'none';
                continue;
              }
              element.style.opacity = '1';
              element.style.pointerEvents = 'auto';
              element.style.width = `${(at.radius * 2).toFixed(1)}px`;
              element.style.height = `${(at.radius * 2).toFixed(1)}px`;
              element.style.transform =
                `translate(${(at.x - at.radius).toFixed(1)}px, ${(at.y - at.radius).toFixed(1)}px) scaleY(${at.squash.toFixed(3)})`;
            }
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
        // A full-screen viewer takes the keyboard: W/S and the arrows work at
        // once, without a first click (which, guided, is itself a step).
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest.id, manifest.version]);

  useEffect(() => {
    engineRef.current?.setMode(controlMode);
  }, [controlMode]);

  useEffect(() => {
    engineRef.current?.setLabels(visibleLabels);
  }, [visibleLabels]);

  const registerStep = useCallback((index: number, element: HTMLElement | null) => {
    if (element) {
      element.style.opacity = '0';
      stepElements.current.set(index, element);
    } else {
      stepElements.current.delete(index);
    }
  }, []);

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
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none', outline: 'none' }}
      />
      {hasNavigation ? <EdgeShade sideMask={sideMask} /> : null}
      {guided
        ? reachable.map((index) => (
            <div
              key={index}
              ref={(node) => registerStep(index, node)}
              role="button"
              aria-label={t('street3d.viewer.stepHere')}
              onClick={() => engineRef.current?.goTo(index)}
              style={STEP_MARKER_STYLE}
            />
          ))
        : null}
      <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
        {visibleLabels.map((label) => (
          <SceneLabel key={label.id} label={label} register={registerLabel} onPress={onLabelPress} />
        ))}
      </View>
      {guided ? (
        <View pointerEvents="box-none" className="absolute left-0 right-0 items-center gap-space-8" style={{ bottom: 72 }}>
          <Fab
            size="sm"
            icon={RiArrowUpLine}
            appearance="subtle"
            tone="neutral"
            accessibilityLabel={t('street3d.viewer.stepForward')}
            onPress={() => engineRef.current?.step(1)}
          />
          <Fab
            size="sm"
            icon={RiArrowDownLine}
            appearance="subtle"
            tone="neutral"
            accessibilityLabel={t('street3d.viewer.stepBack')}
            onPress={() => engineRef.current?.step(-1)}
          />
        </View>
      ) : null}
      {showStats && stats ? <StatsOverlay stats={stats} /> : null}
    </View>
  );
}

/**
 * A ground "step here" marker. Translucent white with a soft ring, like Street
 * View's chevrons: it sits ON the photograph, where a theme colour would read
 * as UI pasted over the street. Positioned per frame by the engine.
 */
const STEP_MARKER_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.28)',
  border: '2px solid rgba(255, 255, 255, 0.85)',
  boxShadow: '0 0 8px rgba(0, 0, 0, 0.35)',
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 160ms ease-out',
  transformOrigin: '50% 50%',
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
  const ref = useCallback((node: View | null) => register(label.id, node as unknown as HTMLElement | null), [label.id, register]);
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
  return (
    // Below the screen's top chrome, which owns the corners.
    <View pointerEvents="none" className="absolute rounded-radius-8 bg-card px-space-8 py-space-4" style={{ top: 64, left: 16 }}>
      <Text className="text-caption text-muted-foreground">
        {`${stats.fps} fps · ${kb} KB · dpr ${stats.pixelRatio} · ${stats.tier}`}
      </Text>
      <Text className="text-caption text-muted-foreground">
        {`first ${stats.firstFrameMs ?? '–'} ms · preview ${stats.previewLoadMs ?? '–'} ms · full ${stats.fullLoadMs ?? '–'} ms`}
      </Text>
    </View>
  );
}

export const SceneViewer = memo(SceneViewerComponent);
