/**
 * The time-of-day scrubber: drag the hour, step the date, watch the sun, the
 * sky, the shadows and the light move. "Now" by default and one tap back to it.
 *
 * Exists only behind the city-sky flag (`lib/map/citySkyFlag.ts`), and only
 * once the city layer is actually drawing (`MapCanvas.web.tsx` renders it when
 * the layer attached). It is its own lazy chunk — `React.lazy` in
 * `MapCanvas.web.tsx` — so with the flag off not a byte of it, its strings
 * (`lib/messages/citySky.ts`) or its arithmetic (`lib/map/timeOfDay.ts`) is
 * downloaded. No three.js here: the control hands an instant to the map, and
 * the layer does the rest.
 *
 * PRIVACY: the caption reads the sun over the MAP CENTRE, which the layer
 * computes for drawing anyway; nothing here asks for or reads a location.
 */
import { matchLanguageTag } from '@goway.to/sdk';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { RiArrowLeftSLine } from '@oxy.so/bloom/icons/RiArrowLeftSLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { formatMessage, useTranslation } from '@/lib/i18n';
import {
  dayOffsetBetween,
  MAX_DAY_OFFSET,
  MINUTES_PER_DAY,
  minutesOfDay,
  scrubbedInstant,
  sunPhase,
} from '@/lib/map/timeOfDay';
import { CITY_SKY_EN, CITY_SKY_MESSAGES } from '@/lib/messages/citySky';

import { useMapChromeLift } from './chromeLift';

export interface TimeOfDayScrubberProps {
  /** The instant the map is lit for, or `null` for "now". */
  value: Date | null;
  onChange: (next: Date | null) => void;
  /** The sun over the map centre at that instant, as the layer last drew it. */
  sunAltitudeDeg: number | null;
}

/** Above the mark and the credit, which own the bottom edge. */
const BOTTOM_CLEARANCE = 64;

function TimeOfDayScrubberComponent({ value, onChange, sunAltitudeDeg }: TimeOfDayScrubberProps) {
  const { locale } = useTranslation();
  const theme = useTheme();
  const bottomEdge = useBottomEdgeInset();
  // On a phone the screen hands down its sheet's live top edge and the room
  // its own controls keep at the right (`chromeLift.ts`): the scrubber rides
  // above the sheet with the credit and stays clear of "My location".
  const chromeLift = useMapChromeLift();
  const riseValue = chromeLift?.lift;
  const fadeValue = chromeLift?.opacity;
  const ride = useAnimatedStyle(
    () =>
      riseValue && fadeValue
        ? { transform: [{ translateY: -riseValue.value }], opacity: fadeValue.value }
        : {},
    [riseValue, fadeValue],
  );

  // The clock the slider reads "now" against; ticks once a minute so the
  // thumb follows the real time while nobody is scrubbing.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (value) return;
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [value]);

  const t = useMemo(() => {
    const table =
      CITY_SKY_MESSAGES[matchLanguageTag(Object.keys(CITY_SKY_MESSAGES), locale) ?? 'en'];
    return (key: string, values?: Record<string, string | number>) =>
      formatMessage(table?.[key] ?? CITY_SKY_EN[key] ?? key, values);
  }, [locale]);

  const at = value ?? now;
  const minutes = minutesOfDay(at);
  const dayOffset = dayOffsetBetween(now, at);
  const clock = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale],
  );
  const date = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }),
    [locale],
  );

  const phase = sunAltitudeDeg === null ? null : sunPhase(sunAltitudeDeg);
  const caption =
    phase === null ? '' : t(`citySky.phase.${phase}`, { degrees: Math.round(sunAltitudeDeg ?? 0) });

  const step = (days: number) => onChange(scrubbedInstant(now, minutes, dayOffset + days));

  return (
    <Animated.View
      pointerEvents="box-none"
      className="absolute left-0 right-0 items-center"
      style={[
        {
          bottom: (bottomEdge > 0 ? bottomEdge : 0) + BOTTOM_CLEARANCE,
          paddingLeft: chromeLift ? 16 : 0,
          paddingRight: chromeLift?.rightClearance ?? 0,
        },
        ride,
      ]}
      testID="goway-time-of-day"
    >
      <View
        className="w-full max-w-[360px] gap-space-4 rounded-radius-16 bg-card/90 px-space-12 py-space-8 shadow-m"
        accessibilityRole="toolbar"
        accessibilityLabel={t('citySky.label')}
      >
        <View className="flex-row items-center justify-between gap-space-8">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('citySky.earlierDay')}
            disabled={dayOffset <= -MAX_DAY_OFFSET}
            onPress={() => step(-1)}
            className="h-8 w-8 items-center justify-center rounded-radius-max active:opacity-70"
          >
            <RiArrowLeftSLine width={18} height={18} fill={theme.colors.text} />
          </Pressable>
          <View className="flex-1 items-center">
            <Text className="text-body font-semibold text-foreground">
              {clock.format(at)} · {date.format(at)}
            </Text>
            <Text className="text-caption text-muted-foreground">{caption}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('citySky.laterDay')}
            disabled={dayOffset >= MAX_DAY_OFFSET}
            onPress={() => step(1)}
            className="h-8 w-8 items-center justify-center rounded-radius-max active:opacity-70"
          >
            <RiArrowRightSLine width={18} height={18} fill={theme.colors.text} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: value === null }}
            onPress={() => onChange(null)}
            className={`rounded-radius-max px-space-8 py-space-2 ${value === null ? 'bg-primary' : 'bg-muted'} active:opacity-80`}
            testID="goway-time-of-day-now"
          >
            <Text
              className={`text-caption font-semibold ${value === null ? 'text-primary-foreground' : 'text-foreground'}`}
            >
              {t('citySky.now')}
            </Text>
          </Pressable>
        </View>
        {/* The platform's own range input, not Bloom's Slider: this file is
            web-only, the input is keyboard- and screen-reader-accessible as
            it stands, and Bloom's Slider is already in another lazy route —
            imported from this chunk too, Expo hoisted it into the first-paint
            `__common` chunk (+11.7 KB measured; see
            ~/Oxy/docs/build-and-runtime-traps.md → Metro web chunking). */}
        <input
          type="range"
          min={0}
          max={MINUTES_PER_DAY - 1}
          step={5}
          value={minutes}
          aria-label={t('citySky.slider')}
          aria-valuetext={clock.format(at)}
          onChange={(event) =>
            onChange(scrubbedInstant(now, Number(event.currentTarget.value), dayOffset))
          }
          data-testid="goway-time-of-day-slider"
          style={{ width: '100%', margin: 0, accentColor: 'var(--primary)', cursor: 'pointer' }}
        />
      </View>
    </Animated.View>
  );
}

const TimeOfDayScrubber = memo(TimeOfDayScrubberComponent);
export default TimeOfDayScrubber;
