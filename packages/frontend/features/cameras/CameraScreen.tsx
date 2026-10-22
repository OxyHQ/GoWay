/**
 * `/camera/<cameraId>` — one public camera: GoWay's copy of its picture, how
 * old it is, the provider's credit and licence, and (when the video worker has
 * counted) what was counted.
 *
 * Honest by construction: the picture is a still and says how old it is; a
 * stale or offline camera says so above the picture; the credit and licence
 * are always on screen. Public — no account, no location.
 */
import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import {
  GoWayNotFoundError,
  OBSERVED_CLASSES,
  type Camera,
  type CameraObservation,
} from '@goway.to/sdk';

import { gowayClient } from '@/lib/goway/client';
import { formatAge } from '@/lib/formatAge';

import { frameAgeSeconds, snapshotSource } from './cameraStyle';
import { type CameraText, useCameraText } from './messages';
import { useCamera, useCameraObservations } from './queries';

/** Re-render this often so the age ticks and the still advances on its beat. */
const TICK_MS = 5_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function CameraScreen() {
  const t = useCameraText();
  const router = useRouter();
  const { top, bottom } = useSafeAreaInsets();
  const params = useLocalSearchParams<{ cameraId?: string }>();
  const cameraId = typeof params.cameraId === 'string' ? params.cameraId : null;
  const camera = useCamera(cameraId);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const notFound = camera.error instanceof GoWayNotFoundError;

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName="gap-space-12 px-space-16"
        contentContainerStyle={{ paddingTop: top + 56, paddingBottom: bottom + 24 }}
      >
        {camera.data ? (
          <CameraDetail camera={camera.data} t={t} />
        ) : camera.isPending ? (
          <Text className="text-muted-foreground" accessibilityLiveRegion="polite">
            {t('cameras.loading')}
          </Text>
        ) : (
          <View className="gap-space-8">
            <Text accessibilityRole="alert" className="text-error-text">
              {notFound ? t('cameras.notFound') : t('cameras.failed')}
            </Text>
            {!notFound ? (
              <Button appearance="plain" tone="neutral" onPress={() => void camera.refetch()}>
                {t('cameras.retry')}
              </Button>
            ) : null}
          </View>
        )}
      </ScrollView>
      <View
        pointerEvents="box-none"
        className="absolute left-0 right-0 top-0 flex-row px-space-16"
        style={{ paddingTop: top + 8 }}
      >
        <Button
          size="sm"
          appearance="solid"
          tone="neutral"
          onPress={close}
          accessibilityLabel={t('cameras.close')}
        >
          {t('cameras.close')}
        </Button>
      </View>
    </View>
  );
}

function CameraDetail({ camera, t }: { camera: Camera; t: CameraText }) {
  const now = useNow();
  const [failed, setFailed] = useState(false);
  const observations = useCameraObservations(camera.id);
  const age = frameAgeSeconds(camera, now);
  const served = camera.media.kind === 'snapshot';
  const latest = observations.data?.items[0];

  return (
    <>
      <View className="gap-space-4">
        <Text variant="title-2-semibold" accessibilityRole="header">
          {camera.name}
        </Text>
        {camera.roadName ? <Text className="text-muted-foreground">{camera.roadName}</Text> : null}
        <Text
          className={camera.status === 'live' ? 'text-foreground' : 'text-error-text'}
          testID="camera-status"
        >
          {t(`cameras.status.${camera.status}`)}
        </Text>
      </View>

      {camera.status === 'stale' ? (
        <Text className="text-error-text">{t('cameras.stale')}</Text>
      ) : null}
      {camera.status === 'offline' ? (
        <Text className="text-error-text">{t('cameras.offline')}</Text>
      ) : null}

      {served ? (
        <View
          className="aspect-video w-full overflow-hidden rounded-radius-12 bg-muted"
          accessibilityRole="image"
          accessibilityLabel={camera.name}
        >
          <Image
            // A still, refreshed on the camera's own beat (`snapshotSource`).
            source={{
              uri: snapshotSource(
                gowayClient.cameras.snapshotUrl(camera.id),
                camera.media.refreshSeconds ?? 60,
                now,
              ),
            }}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            transition={150}
            onError={() => setFailed(true)}
            onLoad={() => setFailed(false)}
            accessibilityIgnoresInvertColors
          />
        </View>
      ) : (
        <Text className="text-muted-foreground">{t('cameras.notServed')}</Text>
      )}
      {failed ? <Text className="text-error-text">{t('cameras.pictureFailed')}</Text> : null}

      {age !== null ? (
        <Text className="text-caption text-muted-foreground" testID="camera-age">
          {t('cameras.age', { age: formatAge(age) })}
        </Text>
      ) : null}
      {camera.media.refreshSeconds ? (
        <Text className="text-caption text-muted-foreground">
          {t('cameras.refreshes', { seconds: camera.media.refreshSeconds })}
        </Text>
      ) : null}

      {latest ? <Counts observation={latest} t={t} /> : null}

      <View className="flex-row flex-wrap items-center gap-space-4">
        <Text className="text-caption text-muted-foreground">{`${t('cameras.source')}:`}</Text>
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(camera.attribution.href).catch(() => {})}
        >
          <Text className="text-caption text-foreground underline">{camera.attribution.label}</Text>
        </Pressable>
        <Text className="text-caption text-muted-foreground">·</Text>
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(camera.licence.href).catch(() => {})}
        >
          <Text className="text-caption text-foreground underline">{camera.licence.label}</Text>
        </Pressable>
      </View>
    </>
  );
}

function Counts({ observation, t }: { observation: CameraObservation; t: CameraText }) {
  const rows = OBSERVED_CLASSES.filter((cls) => (observation.counts[cls] ?? 0) > 0);
  return (
    <View className="gap-space-4 rounded-radius-12 bg-card p-space-12">
      <Text variant="body-semibold">{t('cameras.counted')}</Text>
      {observation.congestion ? (
        <Text>{t(`cameras.congestion.${observation.congestion}`)}</Text>
      ) : null}
      {rows.map((cls) => (
        <View key={cls} className="flex-row justify-between">
          <Text className="text-muted-foreground">{t(`cameras.class.${cls}`)}</Text>
          <Text>{observation.counts[cls]}</Text>
        </View>
      ))}
      {observation.health !== 'ok' ? (
        <Text className="text-caption text-muted-foreground">
          {t(`cameras.health.${observation.health}`)}
        </Text>
      ) : null}
      <Text className="text-caption text-muted-foreground">{t('cameras.privacy')}</Text>
    </View>
  );
}
