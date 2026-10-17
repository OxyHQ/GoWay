/**
 * The time-of-day scrubber: drag the hour, step the date, watch the sun, the
 * sky, the shadows and the light move.
 *
 * Opened on demand, never there by default (`docs/MAP_FEATURES.md` → "The
 * time of day"): the screen opens it from its own control (the sun in the
 * explore screen's top-right stack, or Settings → Map → "Change time…"), and
 * `MapCanvas.web.tsx` renders it only while it is open AND the city sky is
 * drawn. Closing it — its × button, or Escape anywhere inside it — goes back
 * to now: the map is never lit for another time without this control on
 * screen to say so. On open, focus moves to the hour slider; the screen puts
 * it back on its own control on close.
 *
 * It is its own lazy chunk — `React.lazy` in `MapCanvas.web.tsx` — so until
 * somebody opens it not a byte of it, its words (`lib/messages/citySky.ts`)
 * or its arithmetic (`lib/map/timeOfDay.ts`) is downloaded. No three.js
 * here: the control hands an instant to the map, and the layer does the rest.
 *
 * PRIVACY: the caption reads the sun over the MAP CENTRE, which the layer
 * computes for drawing anyway; nothing here asks for or reads a location.
 */
import { localizedLabel } from '@goway.to/sdk';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { RiArrowLeftSLine } from '@oxy.so/bloom/icons/RiArrowLeftSLine';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  creditRise,
  MAP_CREDIT_CLEARANCE,
  useMapChromeLift,
  useMapCreditHeight,
} from '@goway.to/maps';
import { CITY_SKY_LABELS, type CitySkyLabelKey } from '@/lib/messages/citySky';

/** The scrubber's DOM id: Escape is honoured only while focus is inside it. */
const SCRUBBER_ID = 'goway-time-of-day';

export interface TimeOfDayScrubberProps {
  /** The instant the map is lit for, or `null` for "now". */
  value: Date | null;
  onChange: (next: Date | null) => void;
  /** Close it — back to now. Absent: no close control (nothing can reopen it). */
  onClose?: () => void;
  /** The sun over the map centre at that instant, as the layer last drew it. */
  sunAltitudeDeg: number | null;
}

/** Above the mark and the credit, which own the bottom edge. */
const BOTTOM_CLEARANCE = 64;

function TimeOfDayScrubberComponent({
  value,
  onChange,
  onClose,
  sunAltitudeDeg,
}: TimeOfDayScrubberProps) {
  const { locale } = useTranslation();
  const theme = useTheme();
  const bottomEdge = useBottomEdgeInset();
  // On a phone the screen hands down its sheet's live top edge and the room
  // its own controls keep at the right (`chromeLift.ts`): the scrubber rides
  // above the sheet with the credit and stays clear of "My location".
  const chromeLift = useMapChromeLift();
  const riseValue = chromeLift?.lift;
  const fadeValue = chromeLift?.opacity;
  // ...and above the credit however many lines it wraps to (`creditRise.ts`).
  const creditHeight = useMapCreditHeight();
  const ride = useAnimatedStyle(() => {
    // Laid out higher than the chrome `creditRise` measures from, so only what
    // the credit takes beyond that.
    const overCredit = creditHeight
      ? Math.max(0, creditRise(creditHeight.value) - (BOTTOM_CLEARANCE - MAP_CREDIT_CLEARANCE))
      : 0;
    return riseValue && fadeValue
      ? { transform: [{ translateY: -(riseValue.value + overCredit) }], opacity: fadeValue.value }
      : { transform: [{ translateY: -overCredit }] };
  }, [riseValue, fadeValue, creditHeight]);

  // The clock the slider reads "now" against; ticks once a minute so the
  // thumb follows the real time while nobody is scrubbing.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (value) return;
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [value]);

  const t = useMemo(
    () => (key: CitySkyLabelKey, values?: Record<string, string | number>) =>
      formatMessage(localizedLabel(CITY_SKY_LABELS[key], locale), values),
    [locale],
  );

  // Opened on purpose, so focus goes to what it is for: the hour.
  const slider = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    slider.current?.focus({ preventScroll: true });
  }, []);
  // Escape closes it — only from inside, so a dialog over the map keeps its
  // own Escape.
  useEffect(() => {
    if (!onClose || typeof document === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const root = document.getElementById(SCRUBBER_ID);
      if (!root?.contains(document.activeElement)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    phase === null ? '' : t(`phase.${phase}`, { degrees: Math.round(sunAltitudeDeg ?? 0) });

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
      nativeID={SCRUBBER_ID}
      testID="goway-time-of-day"
    >
      <View
        className="w-full max-w-[360px] gap-space-4 rounded-radius-16 bg-card/90 px-space-12 py-space-8 shadow-m"
        accessibilityRole="toolbar"
        accessibilityLabel={t('label')}
      >
        {/* Two rows, so a 360 px phone has room for the whole time: what it
            is and the way out on top, the hour between the day steps below. */}
        <View className="flex-row items-center gap-space-8">
          <View className="flex-1">
            <Text className="text-body font-semibold text-foreground" numberOfLines={1}>
              {clock.format(at)}
            </Text>
            <Text className="text-caption text-muted-foreground" numberOfLines={2}>
              {caption ? `${date.format(at)} · ${caption}` : date.format(at)}
            </Text>
          </View>
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
              {t('now')}
            </Text>
          </Pressable>
          {onClose ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('close')}
              onPress={onClose}
              className="h-8 w-8 items-center justify-center rounded-radius-max active:opacity-70"
              testID="goway-time-of-day-close"
            >
              <RiCloseLine width={18} height={18} fill={theme.colors.text} />
            </Pressable>
          ) : null}
        </View>
        <View className="flex-row items-center gap-space-4">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('earlierDay')}
            disabled={dayOffset <= -MAX_DAY_OFFSET}
            onPress={() => step(-1)}
            className="h-8 w-8 items-center justify-center rounded-radius-max active:opacity-70"
            testID="goway-time-of-day-earlier"
          >
            <RiArrowLeftSLine width={18} height={18} fill={theme.colors.text} />
          </Pressable>
          {/* The platform's own range input, not Bloom's Slider: this file is
              web-only, the input is keyboard- and screen-reader-accessible as
              it stands, and Bloom's Slider is already in another lazy route —
              imported from this chunk too, Expo hoisted it into the first-paint
              `__common` chunk (+11.7 KB measured; see
              ~/Oxy/docs/build-and-runtime-traps.md → Metro web chunking). */}
          <input
            ref={slider}
            type="range"
            min={0}
            max={MINUTES_PER_DAY - 1}
            step={5}
            value={minutes}
            aria-label={t('slider')}
            aria-valuetext={clock.format(at)}
            onChange={(event) =>
              onChange(scrubbedInstant(now, Number(event.currentTarget.value), dayOffset))
            }
            data-testid="goway-time-of-day-slider"
            style={{
              flex: 1,
              minWidth: 0,
              margin: 0,
              accentColor: 'var(--primary)',
              cursor: 'pointer',
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('laterDay')}
            disabled={dayOffset >= MAX_DAY_OFFSET}
            onPress={() => step(1)}
            className="h-8 w-8 items-center justify-center rounded-radius-max active:opacity-70"
            testID="goway-time-of-day-later"
          >
            <RiArrowRightSLine width={18} height={18} fill={theme.colors.text} />
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const TimeOfDayScrubber = memo(TimeOfDayScrubberComponent);
export default TimeOfDayScrubber;
