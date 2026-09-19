/**
 * The states issue #7 asks to be DESIGNED rather than left blank.
 *
 * Each one says what happened, in the user's terms, and offers the one action
 * that could change it. None of them is a spinner over a white rectangle, and
 * none of them is a red banner for something that is not an error — a declined
 * location permission and a search with no matches are both normal outcomes.
 *
 * Bloom has no generic `EmptyState`, which is fine: an empty state is a
 * sentence plus at most one button, and composing it from `Text` and `Button`
 * keeps each one able to say its own true thing instead of all of them sharing
 * a shrug.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiWifiLine } from '@oxy.so/bloom/icons/RiWifiLine';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';

import type { GoWayFailureKind } from '@/lib/goway/errors';

export interface PanelStateProps {
  icon: BloomIconComponent;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Extra content below the action (a second explanation, a list). */
  children?: ReactNode;
  testID?: string;
}

/** One state, one shape: glyph, sentence, at most one action. */
export function PanelState({ icon: Icon, title, body, actionLabel, onAction, children, testID }: PanelStateProps) {
  const theme = useTheme();
  return (
    <View className="items-center gap-space-8 px-space-24 py-space-32" testID={testID}>
      <Icon width={24} height={24} fill={theme.colors.textSecondary} />
      <Text className="text-subtitle text-foreground text-center">{title}</Text>
      {body ? <Text className="text-bodySmall text-muted-foreground text-center">{body}</Text> : null}
      {actionLabel && onAction ? (
        <View className="pt-space-8">
          <Button variant="secondary" size="small" leadingIcon={RiRefreshLine} onPress={onAction}>
            {actionLabel}
          </Button>
        </View>
      ) : null}
      {children}
    </View>
  );
}

/**
 * The copy for a failed GoWay call.
 *
 * One map from the SDK's error taxonomy to a sentence, so "offline" and "the
 * geocoder is down" never collapse into "Something went wrong" — they need
 * different things from the user.
 */
export function FailureState({
  kind,
  what,
  onRetry,
}: {
  kind: GoWayFailureKind;
  /** What was being fetched: "search", "places nearby", "this place". */
  what: string;
  onRetry?: () => void;
}) {
  switch (kind) {
    case 'offline':
      return (
        <PanelState
          icon={RiWifiLine}
          title="You're offline"
          body={`GoWay can't reach ${what} right now. The map you've already loaded still works.`}
          actionLabel={onRetry ? 'Try again' : undefined}
          onAction={onRetry}
          testID="state-offline"
        />
      );
    case 'timeout':
      return (
        <PanelState
          icon={RiRefreshLine}
          title="That took too long"
          body={`${capitalize(what)} didn't answer in time.`}
          actionLabel={onRetry ? 'Try again' : undefined}
          onAction={onRetry}
          testID="state-timeout"
        />
      );
    case 'unavailable':
    case 'rateLimited':
      return (
        <PanelState
          icon={RiErrorWarningLine}
          title={`${capitalize(what)} is unavailable`}
          body="This is on our side, not yours. Browsing the map still works."
          actionLabel={onRetry ? 'Try again' : undefined}
          onAction={onRetry}
          testID="state-unavailable"
        />
      );
    case 'notFound':
      return (
        <PanelState
          icon={RiMapPin2Line}
          title="We couldn't find that place"
          body="It may have been removed, or the link may be out of date."
          testID="state-not-found"
        />
      );
    case 'malformed':
    case 'unknown':
    default:
      return (
        <PanelState
          icon={RiErrorWarningLine}
          title="Something went wrong"
          body={`GoWay couldn't load ${what}.`}
          actionLabel={onRetry ? 'Try again' : undefined}
          onAction={onRetry}
          testID="state-unknown"
        />
      );
  }
}

/** A search that ran and matched nothing. Not an error; a fact. */
export function NoResultsState({ query, onClear }: { query: string; onClear?: () => void }) {
  return (
    <PanelState
      icon={RiSearchLine}
      title={`No results for “${query}”`}
      body="Try a shorter search, or move the map to where you're looking."
      actionLabel={onClear ? 'Clear search' : undefined}
      onAction={onClear}
      testID="state-no-results"
    />
  );
}

/** The viewport is genuinely empty of anything GoWay knows about. */
export function NothingHereState({ onSearchArea }: { onSearchArea?: () => void }) {
  return (
    <PanelState
      icon={RiMapPin2Line}
      title="Nothing here yet"
      body="GoWay has no places in this area. Move the map, or zoom out to see more."
      actionLabel={onSearchArea ? 'Search this area' : undefined}
      onAction={onSearchArea}
      testID="state-nothing-here"
    />
  );
}

/**
 * Places exist but the zoom rules are hiding them.
 *
 * Worth saying out loud: a map that shows four pins where there are forty looks
 * broken unless it explains that it is being deliberate.
 */
export function ZoomForMoreState({ hidden }: { hidden: number }) {
  return (
    <PanelState
      icon={RiFocus3Line}
      title={`${hidden} more nearby`}
      body="Zoom in to see smaller places like cafés and shops."
      testID="state-zoom-for-more"
    />
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
