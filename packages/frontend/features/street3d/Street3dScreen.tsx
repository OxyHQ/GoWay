/**
 * `/street3d/<sceneId>` — one published Street 3D scene, full screen.
 *
 * The same screen serves three hosts:
 *
 *  - **web**: the viewer itself, with GoWay chrome (back to map, report,
 *    "contribute here", the scene's credits, place labels).
 *  - **web, `?embed=1`**: the viewer with no app chrome, for the native
 *    WebView. Place taps and the viewer phase go to the native app over the
 *    bridge; the credits stay, because a data credit is never optional.
 *  - **native**: GoWay chrome around `SceneViewer.native`, which hosts the
 *    embed page. Report and contribute are native controls here, so they use
 *    the app's own Oxy session — nothing identity-bound ever runs in the
 *    WebView.
 *
 * Opening and closing are the 2D ⇄ 3D transition: the poster the map's chip
 * showed is painted first and scales in, the scene fades in over it once it
 * draws, and closing frames the map on the scene's bounds (see `handoff.ts`).
 */
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated, { FadeOut, Keyframe } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { Textarea } from '@oxy.so/bloom/textarea';
import { windowEdgeGap } from '@oxy.so/bloom/layout';
import { useTheme } from '@oxy.so/bloom/theme';
import {
  STREET_SCENE_REPORT_REASONS,
  type StreetSceneManifest,
  type StreetSceneReportReason,
} from '@goway.to/sdk';

import {
  SceneViewer,
  isSafeId,
  postToNative,
  type SceneViewerControlMode,
  type SceneViewerLabel,
  type SceneViewerPhase,
} from '@/components/street3d';
import { useAuthGate } from '@/lib/authGate';
import { STREET3D_ENABLED, WEB_ORIGIN } from '@/lib/config';
import { classifyGoWayError } from '@/lib/goway/errors';
import { usePlacesInBounds } from '@/lib/goway/queries';
import { useTranslation } from '@/lib/i18n';
import { placeLabelsForScene } from '@/lib/street3d/placeLabels';

import { sceneSummary, setReturnBounds, viewportForBounds } from './handoff';
import { useReportScene, useStreetScene } from './queries';

const IS_WEB = Platform.OS === 'web';
const MAX_NOTE = 500;

/** The poster arrives slightly small and transparent and settles — the map chip growing into the scene. */
const POSTER_ENTER = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.92 }] },
  100: { opacity: 1, transform: [{ scale: 1 }] },
}).duration(260);

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function posterOf(manifest: StreetSceneManifest | undefined, fallback: string | undefined): string | undefined {
  return manifest?.assets.find((asset) => asset.role === 'poster')?.url ?? fallback;
}

export function Street3dScreen() {
  const params = useLocalSearchParams<{ sceneId?: string | string[]; embed?: string | string[] }>();
  const rawId = firstParam(params.sceneId);
  const sceneId = rawId && isSafeId(rawId) ? rawId : null;
  const embed = IS_WEB && firstParam(params.embed) === '1';

  const router = useRouter();
  const { t, locale } = useTranslation();
  const gate = useAuthGate();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  const summary = sceneId ? sceneSummary(sceneId) : undefined;
  const scene = useStreetScene(STREET3D_ENABLED && sceneId ? sceneId : null);
  const manifest = scene.data;

  const [phase, setPhase] = useState<SceneViewerPhase>('loading');
  // Guided Walk is the default whenever the scene publishes where it can be
  // walked; free Orbit stays behind the toggle. `null` = not chosen yet.
  const [chosenMode, setMode] = useState<SceneViewerControlMode | null>(null);
  const guidedAvailable = (manifest?.navigation?.viewpoints.length ?? 0) > 0;
  const mode: SceneViewerControlMode = chosenMode ?? (guidedAvailable ? 'walk' : 'orbit');
  const [reporting, setReporting] = useState(false);
  const [showStats, setShowStats] = useState(false);

  // Labels: web only. On native the embedded page draws its own.
  const places = usePlacesInBounds(manifest?.bounds ?? null, { limit: 200, enabled: IS_WEB && manifest != null });
  const labels = useMemo<SceneViewerLabel[]>(
    () => (manifest && places.data ? placeLabelsForScene(places.data, manifest.worldTransform) : []),
    [manifest, places.data],
  );

  const handlePhase = useCallback(
    (next: SceneViewerPhase) => {
      setPhase(next);
      if (embed) postToNative({ type: 'phase', phase: next });
    },
    [embed],
  );

  const openPlace = useCallback(
    (placeId: string) => {
      if (!isSafeId(placeId)) return;
      if (embed) {
        if (postToNative({ type: 'place', placeId })) return;
        // Embedded somewhere that is not the GoWay app: open the place on
        // GoWay itself rather than navigating the host's frame.
        window.open(`${WEB_ORIGIN}/place/${encodeURIComponent(placeId)}`, '_blank', 'noopener');
        return;
      }
      router.push(`/place/${encodeURIComponent(placeId)}`);
    },
    [embed, router],
  );

  const close = useCallback(() => {
    const bounds = manifest?.bounds ?? summary?.bounds;
    if (router.canGoBack()) {
      if (bounds) setReturnBounds(bounds);
      router.back();
      return;
    }
    // Opened cold (a shared link): there is no map underneath to return to,
    // so open one already framed on the scene.
    if (bounds) {
      const viewport = viewportForBounds(bounds, width, height);
      router.replace({
        pathname: '/',
        params: { lat: String(viewport.latitude), lng: String(viewport.longitude), zoom: String(viewport.zoom) },
      });
    } else {
      router.replace('/');
    }
  }, [height, manifest?.bounds, router, summary?.bounds, width]);

  const contributeHere = useCallback(() => {
    gate.run(() => router.push('/contribute'));
  }, [gate, router]);

  const failure = scene.error ? classifyGoWayError(scene.error) : null;
  const unavailable = !STREET3D_ENABLED || !sceneId || failure?.kind === 'notFound';
  const drawn = phase === 'preview' || phase === 'full';
  const poster = posterOf(manifest, summary?.posterUrl);
  const top = windowEdgeGap(insets.top);
  const side = windowEdgeGap(Math.max(insets.left, insets.right), 0);
  const bottom = windowEdgeGap(insets.bottom);

  const formatDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };

  let notice: string | null = null;
  if (unavailable) notice = t('street3d.viewer.notFound');
  else if (failure && failure.kind !== 'aborted') notice = t('street3d.viewer.error');
  else if (phase === 'unsupported') notice = t('street3d.viewer.unsupported');
  else if (phase === 'error') notice = t('street3d.viewer.error');
  else if (!manifest || phase === 'loading') notice = t('street3d.viewer.loading');

  return (
    <View className="flex-1 bg-background">
      {manifest && !unavailable ? (
        <SceneViewer
          manifest={manifest}
          labels={labels}
          onLabelPress={openPlace}
          controlMode={mode}
          onPhaseChange={handlePhase}
          showStats={__DEV__ && showStats}
          testID="street3d-viewer"
        />
      ) : null}

      {poster && !drawn && !unavailable ? (
        <Animated.View
          entering={POSTER_ENTER}
          exiting={FadeOut.duration(320)}
          pointerEvents="none"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        >
          <Image source={{ uri: poster }} style={{ flex: 1 }} contentFit="cover" accessibilityIgnoresInvertColors />
        </Animated.View>
      ) : null}

      {!embed ? (
        <View
          pointerEvents="box-none"
          className="absolute left-0 right-0 top-0 flex-row items-center justify-between gap-space-8"
          style={{ paddingTop: top, paddingHorizontal: side }}
        >
          <Button size="sm" appearance="solid" tone="neutral" onPress={close} accessibilityLabel={t('street3d.viewer.close')}>
            {t('street3d.viewer.close')}
          </Button>
          {!unavailable ? (
            <View className="flex-row gap-space-8">
              <Button size="sm" appearance="solid" tone="neutral" onPress={contributeHere}>
                {t('street3d.contribute.cta')}
              </Button>
              <Button size="sm" appearance="solid" tone="neutral" onPress={() => gate.run(() => setReporting(true))}>
                {t('street3d.viewer.report')}
              </Button>
            </View>
          ) : null}
        </View>
      ) : null}

      {notice ? (
        <View pointerEvents="box-none" className="absolute left-0 right-0 items-center px-space-16" style={{ top: '45%' }}>
          <View accessibilityRole="alert" className="items-center gap-space-8 rounded-radius-12 bg-card px-space-16 py-space-12 shadow-m">
            <Text className="text-body text-foreground">{notice}</Text>
            {failure?.retryable && !unavailable ? (
              <Button size="sm" appearance="outline" onPress={() => void scene.refetch()}>
                {t('street3d.viewer.retry')}
              </Button>
            ) : null}
          </View>
        </View>
      ) : null}

      {manifest && !unavailable && (IS_WEB || !embed) ? (
        <View
          pointerEvents="box-none"
          className="absolute left-0 right-0 gap-space-8"
          style={{ bottom, paddingHorizontal: side }}
        >
          {manifest.quality.placement === 'approximate' ? (
            <View className="self-start rounded-radius-8 bg-warning-subtle px-space-8 py-space-4">
              <Text className="text-caption text-warning-text">{t('street3d.viewer.approximate')}</Text>
            </View>
          ) : null}

          {IS_WEB ? (
            <View pointerEvents="box-none" className="flex-row flex-wrap items-end justify-between gap-space-8">
              <View className="flex-row items-center gap-space-8 rounded-radius-max bg-card px-space-8 py-space-4 shadow-s">
                {/* Walk first when it is the guided default; Orbit is the secondary, free mode. */}
                {(guidedAvailable ? (['walk', 'orbit'] as const) : (['orbit', 'walk'] as const)).map((option) => (
                  <Button
                    key={option}
                    size="xs"
                    appearance={mode === option ? 'solid' : 'plain'}
                    tone="neutral"
                    onPress={() => setMode(option)}
                  >
                    {t(`street3d.viewer.controls.${option}`)}
                  </Button>
                ))}
                <Text className="text-caption text-muted-foreground">
                  {guidedAvailable && mode === 'walk' ? t('street3d.viewer.controls.hintGuided') : t('street3d.viewer.controls.hint')}
                </Text>
                {__DEV__ ? (
                  <Pressable onPress={() => setShowStats((value) => !value)} accessibilityRole="button">
                    <Text className="text-caption text-muted-foreground">perf</Text>
                  </Pressable>
                ) : null}
              </View>

              {/* The scene's own credits. A data credit is not optional, so it
                  is drawn in the embed too, and never behind a toggle. */}
              <View className="max-w-full items-end rounded-radius-8 bg-card px-space-8 py-space-4 shadow-s">
                {manifest.attributions.map((credit) => (
                  <Text key={credit} className="text-caption text-muted-foreground">
                    {credit}
                  </Text>
                ))}
                <Text className="text-caption text-muted-foreground">
                  {formatDate(manifest.observedFrom) === formatDate(manifest.observedTo)
                    ? t('street3d.viewer.observedSame', { date: formatDate(manifest.observedTo) })
                    : t('street3d.viewer.observed', { from: formatDate(manifest.observedFrom), to: formatDate(manifest.observedTo) })}
                </Text>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {reporting && sceneId && !embed ? (
        <ReportPanel sceneId={sceneId} onClose={() => setReporting(false)} />
      ) : null}
    </View>
  );
}

function ReportPanel({ sceneId, onClose }: { sceneId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const gate = useAuthGate();
  const report = useReportScene(sceneId);
  const [reason, setReason] = useState<StreetSceneReportReason>('privacy');
  const [note, setNote] = useState('');

  const options = useMemo(
    () => STREET_SCENE_REPORT_REASONS.map((value) => ({ value, label: t(`street3d.report.reason.${value}`) })),
    [t],
  );

  const failure = report.error ? classifyGoWayError(report.error) : null;

  const submit = () => {
    // Re-checked at submit: the session can end while the panel is open.
    gate.run(() => {
      const trimmed = note.trim();
      report.mutate(trimmed ? { reason, note: trimmed.slice(0, MAX_NOTE) } : { reason });
    });
  };

  return (
    <View
      className="absolute inset-0 items-center justify-center px-space-16"
      style={{ backgroundColor: theme.colors.overlay }}
    >
      <ScrollView
        className="w-full max-w-md rounded-radius-16 bg-card shadow-m"
        contentContainerClassName="gap-space-12 p-space-16"
        accessibilityViewIsModal
      >
        <Text variant="title-3-semibold">{t('street3d.report.title')}</Text>
        {report.isSuccess ? (
          <>
            <Text accessibilityLiveRegion="polite">{t('street3d.report.sent')}</Text>
            <Button onPress={onClose}>{t('street3d.report.done')}</Button>
          </>
        ) : (
          <>
            <RadioGroup value={reason} onValueChange={setReason} options={options} />
            <Textarea
              label={t('street3d.report.note')}
              value={note}
              onValueChange={setNote}
              maxLength={MAX_NOTE}
              showCount
              rows={3}
            />
            {failure && failure.kind !== 'aborted' ? (
              <Text accessibilityRole="alert" className="text-error-text">
                {failure.kind === 'unauthorized' ? t('street3d.report.signIn') : t('street3d.report.failed')}
              </Text>
            ) : null}
            <View className="flex-row justify-end gap-space-8">
              <Button appearance="plain" tone="neutral" onPress={onClose}>
                {t('street3d.report.cancel')}
              </Button>
              <Button onPress={submit} loading={report.isPending} disabled={report.isPending}>
                {t('street3d.report.submit')}
              </Button>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
