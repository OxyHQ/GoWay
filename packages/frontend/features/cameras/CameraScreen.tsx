/**
 * `/camera/<cameraId>` — one public camera: GoWay's copy of its picture, how
 * old it is, the provider's credit and licence, and (when the video worker has
 * counted) what was counted.
 *
 * Composed from Bloom only — `Screen`, `PageHeader`, `ScreenScrollView`,
 * `Loading`, `EmptyState`, `Badge`, `Admonition`, `GroupedSection` — as Oxy's
 * other apps compose their detail screens; the still is `expo-image`, as
 * everywhere else in GoWay (Bloom 15.0.0 does not export its image).
 *
 * Honest by construction: the picture is a still and says how old it is; a
 * stale or offline camera says so above the picture; the credit and licence
 * are always on screen. Public — no account, no location.
 */
import { useCallback, useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Badge } from '@oxy.so/bloom/badge';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { Text } from '@oxy.so/bloom/typography';
import type { AccentTone } from '@oxy.so/bloom/theme';
import {
  GoWayNotFoundError,
  OBSERVED_CLASSES,
  type Camera,
  type CameraObservation,
  type CameraStatus,
} from '@goway.to/sdk';

import { formatAge } from '@/lib/formatAge';
import { gowayClient } from '@/lib/goway/client';

import { frameAgeSeconds, snapshotSource } from './cameraStyle';
import { type CameraText, useCameraText } from './messages';
import { useCamera, useCameraObservations } from './queries';

/** Re-render this often so the age ticks and the still advances on its beat. */
const TICK_MS = 5_000;

const STATUS_COLOR: Readonly<Record<CameraStatus, AccentTone>> = {
  live: 'success',
  stale: 'warning',
  offline: 'error',
  unknown: 'default',
};

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const openLink = (href: string) => void Linking.openURL(href).catch(() => {});

export function CameraScreen() {
  const t = useCameraText();
  const router = useRouter();
  const params = useLocalSearchParams<{ cameraId?: string }>();
  const cameraId = typeof params.cameraId === 'string' ? params.cameraId : null;
  const camera = useCamera(cameraId);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const header = (
    <PageHeader
      title={camera.data?.name ?? ''}
      subtitle={camera.data?.roadName ?? undefined}
      onBack={close}
      backLabel={t('cameras.close')}
    />
  );

  return (
    <Screen header={header}>
      <ScreenScrollView>
        {camera.data ? (
          <CameraDetail camera={camera.data} t={t} />
        ) : camera.isPending ? (
          <Loading variant="spinner" size="lg" text={t('cameras.loading')} />
        ) : camera.error instanceof GoWayNotFoundError ? (
          <EmptyState title={t('cameras.notFound')} />
        ) : (
          <EmptyState
            title={t('cameras.failed')}
            action={{ label: t('cameras.retry'), onPress: () => void camera.refetch() }}
          />
        )}
      </ScreenScrollView>
    </Screen>
  );
}

function CameraDetail({ camera, t }: { camera: Camera; t: CameraText }) {
  const now = useNow();
  const [failed, setFailed] = useState(false);
  const observations = useCameraObservations(camera.id);
  const age = frameAgeSeconds(camera, now);
  const latest = observations.data?.items[0];

  return (
    <View className="gap-space-16 p-space-16">
      <View className="flex-row flex-wrap items-center gap-space-8">
        <Badge
          variant="subtle"
          color={STATUS_COLOR[camera.status]}
          content={t(`cameras.status.${camera.status}`)}
          size="sm"
          testID="camera-status"
        />
        {age !== null ? (
          <Text className="text-caption text-muted-foreground" testID="camera-age">
            {t('cameras.age', { age: formatAge(age) })}
          </Text>
        ) : null}
      </View>

      {camera.status === 'stale' ? (
        <Admonition type="warning">{t('cameras.stale')}</Admonition>
      ) : null}
      {camera.status === 'offline' ? (
        <Admonition type="warning">{t('cameras.offline')}</Admonition>
      ) : null}

      {camera.media.kind === 'snapshot' ? (
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
        <Admonition type="info">{t('cameras.notServed')}</Admonition>
      )}
      {failed ? <Admonition type="error">{t('cameras.pictureFailed')}</Admonition> : null}
      {camera.media.refreshSeconds ? (
        <Text className="text-caption text-muted-foreground">
          {t('cameras.refreshes', { seconds: camera.media.refreshSeconds })}
        </Text>
      ) : null}

      {latest ? <Counts observation={latest} t={t} /> : null}

      <GroupedSection>
        <GroupedSectionItem
          title={t('cameras.source')}
          value={camera.attribution.label}
          onPress={() => openLink(camera.attribution.href)}
          accessibilityRole="link"
          showChevron
        />
        <GroupedSectionItem
          title={t('cameras.licence')}
          value={camera.licence.label}
          onPress={() => openLink(camera.licence.href)}
          accessibilityRole="link"
          showChevron
        />
      </GroupedSection>
    </View>
  );
}

function Counts({ observation, t }: { observation: CameraObservation; t: CameraText }) {
  const classes = OBSERVED_CLASSES.filter((cls) => (observation.counts[cls] ?? 0) > 0);
  return (
    <GroupedSection title={t('cameras.counted')} footer={t('cameras.privacy')}>
      {observation.congestion ? (
        <GroupedSectionItem title={t(`cameras.congestion.${observation.congestion}`)} />
      ) : null}
      {classes.map((cls) => (
        <GroupedSectionItem
          key={cls}
          title={t(`cameras.class.${cls}`)}
          value={String(observation.counts[cls])}
        />
      ))}
      {observation.health !== 'ok' ? (
        <GroupedSectionItem title={t(`cameras.health.${observation.health}`)} />
      ) : null}
    </GroupedSection>
  );
}
