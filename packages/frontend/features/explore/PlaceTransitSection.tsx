/**
 * The public transport around a place: stops, their lines, and what leaves
 * next, drawn by Bloom's `PlaceTransit`.
 *
 * Absent — `null`, not a skeleton or a "no transit" line — while it loads, when
 * the request failed, when no served operator covers the place, and when no
 * stop is in range. Issue #7: never show a field that is merely absent.
 *
 * Under the stops: the credit and licence of every operator whose stops are
 * drawn (the data is only re-served under them), and one sentence saying how to
 * tell a live prediction (a dot) from the published timetable.
 */
import { Linking, View } from 'react-native';
import type { Place } from '@goway.to/sdk';
import { PlaceTransit } from '@oxy.so/bloom/place-details';
import { Text } from '@oxy.so/bloom/typography';
import { useEffect, useState } from 'react';

import { formatDistance } from '@/lib/goway/format';
import { useNearbyTransit } from '@/lib/goway/queries';
import { transitView } from '@/lib/goway/transit';
import { useTranslation } from '@/lib/i18n';

export interface PlaceTransitSectionProps {
  place: Place;
  testID?: string;
}

function CreditLink({ label, href }: { label: string; href: string }) {
  return (
    <Text
      role="link"
      accessibilityRole="link"
      className="text-caption text-muted-foreground underline"
      onPress={() => void Linking.openURL(href)}
    >
      {label}
    </Text>
  );
}

/** How often the countdowns re-read the clock between refreshes of the answer. */
const CLOCK_TICK_MS = 10_000;

/**
 * The current time, re-read every {@link CLOCK_TICK_MS}: a "4 min" is only true
 * against the clock it was counted from, and `Date.now()` is not something a
 * render may call.
 */
function useClock(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

export function PlaceTransitSection({ place, testID }: PlaceTransitSectionProps) {
  const { t, locale } = useTranslation();
  const query = useNearbyTransit(place.location);
  const answer = query.data;
  // Never earlier than the answer itself: it was computed at `dataUpdatedAt`.
  const nowMs = Math.max(useClock(), query.dataUpdatedAt);
  const view = answer
    ? transitView(answer, { nowMs, locale, timeZone: place.timezone, t, formatDistance })
    : null;

  if (!view || view.stops.length === 0) return null;

  return (
    <View className="gap-space-8" testID={testID ?? 'place-transit'}>
      <Text className="text-bodySmall font-semibold text-foreground">{t('transit.heading')}</Text>
      <PlaceTransit
        stops={view.stops}
        departureLimit={3}
        realtimeLabel={t('transit.live')}
        emptyLabel={t('transit.empty')}
        accessibilityLabel={t('transit.label')}
        testID="place-transit-stops"
      />
      <Text className="text-caption text-muted-foreground">
        {view.anyRealtime ? t('transit.note') : t('transit.noteScheduled')}
      </Text>
      <View className="flex-row flex-wrap items-center gap-x-space-8 gap-y-space-4">
        {view.credits.map((credit) => (
          <View key={credit.operatorId} className="flex-row flex-wrap items-center gap-space-4">
            <CreditLink label={credit.attribution.label} href={credit.attribution.href} />
            <Text className="text-caption text-muted-foreground">·</Text>
            <CreditLink label={credit.licence.label} href={credit.licence.href} />
            {credit.updated ? (
              <Text className="text-caption text-muted-foreground">{`· ${credit.updated}`}</Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
