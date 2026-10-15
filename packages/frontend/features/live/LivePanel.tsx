/**
 * The live layer's panel: what is on (per-kind toggles), how fresh each feed
 * is, and — when something is tapped — what it is, where its data came from
 * and how old its position is.
 *
 * Honesty is the panel's job as much as the map's: every feed shown names its
 * source and the age of its last answer, a stale feed says "stale", a tapped
 * thing states its position's age and its source's licence, and the panel
 * says in so many words that nothing here is simulated.
 */
import { memo, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Chip } from '@oxy.so/bloom/chip';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import type { LiveKind, LiveSource } from '@goway.to/sdk/live';

import { entityDetails, formatAge, sourceFreshness } from './format';
import { LIVE_KIND_COLORS, LIVE_KIND_ORDER } from './kinds';
import type { LiveClientState } from './liveClient';
import type { LiveSample } from './liveStore';
import { type LiveText, useLiveText } from './messages';

/**
 * Each toggle carries its kind's map colour as a dot — the legend IS the map's
 * palette. Deliberately not Bloom icons: an icon a second lazy chunk also uses
 * is hoisted into the first-paint bundle (measured: the flyover's
 * `RiFlightTakeoffLine`, +578 B with the flag off).
 */
function KindDot({ color }: { color: string }) {
  return (
    <View
      className="rounded-radius-max"
      style={{ width: 10, height: 10, backgroundColor: color }}
    />
  );
}

/** The panel's width: narrow enough to leave the map, wide enough for a source line. */
const PANEL_WIDTH = 300;

export interface LivePanelProps {
  /** Open on mount; a phone starts with the pill alone. */
  initiallyExpanded: boolean;
  kinds: ReadonlySet<LiveKind>;
  onToggleKind: (kind: LiveKind) => void;
  state: LiveClientState;
  sources: readonly LiveSource[];
  serverNow: number;
  selected: LiveSample | null;
  selectedSource: LiveSource | undefined;
  onCloseSelected: () => void;
}

function statusLine(state: LiveClientState, t: LiveText): string | null {
  if (state.connection === 'connecting') return t('live.connecting');
  if (state.connection === 'offline') return t('live.offline');
  if (state.coverage === 'too_wide') return t('live.zoomIn');
  return null;
}

function SourceRow({
  source,
  serverNow,
  t,
}: {
  source: LiveSource;
  serverNow: number;
  t: LiveText;
}) {
  const unhealthy = source.status === 'stale' || source.status === 'unavailable';
  return (
    <View className="flex-row items-center gap-space-4" testID={`live-source-${source.id}`}>
      <View
        className="rounded-radius-max"
        style={{
          width: 8,
          height: 8,
          backgroundColor: unhealthy ? '#a8a29e' : LIVE_KIND_COLORS[source.kind],
        }}
      />
      <Text className="flex-1 text-caption text-foreground" numberOfLines={1}>
        {source.name}
      </Text>
      <Text className={`text-caption ${unhealthy ? 'text-error-text' : 'text-muted-foreground'}`}>
        {source.status === 'live' || source.status === 'starting'
          ? sourceFreshness(source, serverNow, t)
          : t(`live.status.${source.status}`)}
      </Text>
    </View>
  );
}

function Details({
  sample,
  source,
  onClose,
  t,
}: {
  sample: LiveSample;
  source: LiveSource | undefined;
  onClose: () => void;
  t: LiveText;
}) {
  const theme = useTheme();
  const details = entityDetails(sample.entity, t);
  const ageKey = sample.estimated ? 'live.detail.estimateAge' : 'live.detail.age';
  return (
    <View className="gap-space-4 border-t border-border pt-space-8" testID="live-details">
      <View className="flex-row items-start gap-space-8">
        <View className="flex-1">
          <Text className="text-body text-foreground" numberOfLines={1}>
            {details.title}
          </Text>
          {details.subtitle ? (
            <Text className="text-caption text-muted-foreground" numberOfLines={1}>
              {details.subtitle}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('live.detail.close')}
          onPress={onClose}
          hitSlop={8}
        >
          <RiCloseLine width={18} height={18} fill={theme.colors.textSecondary} />
        </Pressable>
      </View>
      {details.rows.map((row) => (
        <View key={row.label} className="flex-row justify-between gap-space-8">
          <Text className="text-caption text-muted-foreground">{row.label}</Text>
          <Text className="text-caption text-foreground">{row.value}</Text>
        </View>
      ))}
      <Text
        className={`text-caption ${sample.freshness === 'stale' ? 'text-error-text' : 'text-muted-foreground'}`}
        testID="live-details-age"
      >
        {sample.freshness === 'stale'
          ? `${t(ageKey, { age: formatAge(sample.ageSeconds) })} · ${t('live.detail.stale')}`
          : t(ageKey, { age: formatAge(sample.ageSeconds) })}
      </Text>
      {sample.entity.kind === 'transit' ? (
        <Text className="text-caption text-muted-foreground" testID="live-details-track">
          {sample.estimated
            ? t('live.detail.estimated')
            : sample.approximate
              ? t('live.detail.approximate')
              : sample.onTrack
                ? t('live.detail.onTrack')
                : ''}
        </Text>
      ) : null}
      {source ? (
        <View className="flex-row flex-wrap items-center gap-space-4">
          <Text className="text-caption text-muted-foreground">{`${t('live.detail.source')}:`}</Text>
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(source.attribution.href).catch(() => {})}
          >
            <Text className="text-caption text-foreground underline">
              {source.attribution.label}
            </Text>
          </Pressable>
          <Text className="text-caption text-muted-foreground">·</Text>
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(source.licence.href).catch(() => {})}
          >
            <Text className="text-caption text-foreground underline">{source.licence.label}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function LivePanelComponent(props: LivePanelProps) {
  const t = useLiveText();
  const [expanded, setExpanded] = useState(props.initiallyExpanded);
  const status = statusLine(props.state, t);
  // Feeds worth a line: of a kind that is on, and being polled for this view.
  const shown = props.sources.filter(
    (source) => props.kinds.has(source.kind) && source.status !== 'idle',
  );
  // A tap on the map opens the card even when the panel is folded away.
  const open = expanded || props.selected !== null;

  return (
    <View
      pointerEvents="box-none"
      className="items-end"
      style={{ width: PANEL_WIDTH, maxWidth: '92%' }}
    >
      <View
        className="w-full gap-space-8 rounded-radius-16 bg-card/95 p-space-12 shadow-m"
        testID="live-panel"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setExpanded((value) => !value)}
          className="flex-row items-center gap-space-4"
          testID="live-panel-toggle"
        >
          <View
            className="rounded-radius-max"
            style={{ width: 8, height: 8, backgroundColor: '#dc2626' }}
          />
          <Text className="flex-1 text-bodySmall text-foreground">{t('live.title')}</Text>
          {!open && status ? (
            <Text className="text-caption text-muted-foreground">{status}</Text>
          ) : null}
        </Pressable>
        {open ? (
          <>
            <View className="flex-row flex-wrap gap-space-4">
              {LIVE_KIND_ORDER.map((kind) => {
                const on = props.kinds.has(kind);
                return (
                  <Chip
                    key={kind}
                    role="checkbox"
                    size="sm"
                    variant="inverted"
                    selected={on}
                    onPress={() => props.onToggleKind(kind)}
                    startIcon={
                      // The kind's colour while it is drawn; grey while it is off.
                      <KindDot color={on ? LIVE_KIND_COLORS[kind] : '#a8a29e'} />
                    }
                    accessibilityLabel={t(`live.kind.${kind}`)}
                    testID={`live-kind-${kind}`}
                  >
                    {t(`live.kind.${kind}`)}
                  </Chip>
                );
              })}
            </View>
            {status ? <Text className="text-caption text-muted-foreground">{status}</Text> : null}
            {shown.length > 0 ? (
              <View className="gap-space-4">
                {shown.map((source) => (
                  <SourceRow key={source.id} source={source} serverNow={props.serverNow} t={t} />
                ))}
              </View>
            ) : props.state.connection === 'connected' && props.state.coverage === 'ok' ? (
              <Text className="text-caption text-muted-foreground">{t('live.noSources')}</Text>
            ) : null}
            <Text className="text-caption text-muted-foreground">{t('live.real')}</Text>
            {props.selected ? (
              <Details
                sample={props.selected}
                source={props.selectedSource}
                onClose={props.onCloseSelected}
                t={t}
              />
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

export const LivePanel = memo(LivePanelComponent);
