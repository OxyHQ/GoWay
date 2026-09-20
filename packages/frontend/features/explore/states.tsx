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
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiMap2Line } from '@oxy.so/bloom/icons/RiMap2Line';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiTimerLine } from '@oxy.so/bloom/icons/RiTimerLine';
import { RiWifiLine } from '@oxy.so/bloom/icons/RiWifiLine';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';

import type { GoWayFailureKind } from '@/lib/goway/errors';
import type { LocationErrorReason } from '@/lib/map/useUserLocation';

export interface PanelStateProps {
  icon: BloomIconComponent;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  /**
   * The action's glyph. Defaults to the retry arrow, which is right for the
   * failure states and wrong for an action that is not a repeat of anything.
   */
  actionIcon?: BloomIconComponent;
  /** Extra content below the action (a second explanation, a list). */
  children?: ReactNode;
  testID?: string;
}

/** One state, one shape: glyph, sentence, at most one action. */
export function PanelState({
  icon: Icon,
  title,
  body,
  actionLabel,
  onAction,
  actionIcon = RiRefreshLine,
  children,
  testID,
}: PanelStateProps) {
  const theme = useTheme();
  return (
    <View className="items-center gap-space-8 px-space-24 py-space-32" testID={testID}>
      <Icon width={24} height={24} fill={theme.colors.textSecondary} />
      <Text className="text-subtitle text-foreground text-center">{title}</Text>
      {body ? <Text className="text-bodySmall text-muted-foreground text-center">{body}</Text> : null}
      {actionLabel && onAction ? (
        <View className="pt-space-8">
          <Button variant="secondary" size="small" leadingIcon={actionIcon} onPress={onAction}>
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

/**
 * A location-dependent action that could not get a location.
 *
 * Issue #7 → Required states lists "location permission denied", and this is
 * the state it means — but four things resolve to "no coordinate" and only one
 * of them is the user declining. Each gets its own sentence, because the next
 * step differs: a decline can be re-asked, a browser-level block cannot and has
 * to be undone where the browser keeps it, an insecure page is not the user's
 * doing at all, and a device that cannot fix is worth simply trying again.
 *
 * The alternative origin is the point of the whole state: directions without a
 * current location should be a detour, not a wall. It is offered as an explicit
 * choice and never substituted silently — a route reported from somewhere the
 * user never said they were is worse than no route.
 */
export function LocationFailureState({
  reason,
  canAskAgain,
  onRetry,
  onUseMapOrigin,
  testID,
}: {
  reason: LocationErrorReason;
  /** From `useUserLocation()`. `false` means a retry provably cannot prompt. */
  canAskAgain: boolean;
  onRetry: () => void;
  /** Offered only when the map has a centre far enough from the destination. */
  onUseMapOrigin?: () => void;
  testID?: string;
}) {
  const copy = LOCATION_COPY[reason === 'denied' && !canAskAgain ? 'blocked' : reason];
  // The retry is only offered where it could actually change the answer.
  const retryable = copy.retryable;
  const mapButton = onUseMapOrigin ? (
    <View className={retryable ? 'pt-space-4' : 'pt-space-8'}>
      <Button variant={retryable ? 'text' : 'secondary'} size="small" leadingIcon={RiMap2Line} onPress={onUseMapOrigin}>
        Route from the map instead
      </Button>
    </View>
  ) : null;

  return (
    <PanelState
      icon={copy.icon}
      title={copy.title}
      body={copy.body}
      actionLabel={retryable ? 'Try again' : undefined}
      onAction={retryable ? onRetry : undefined}
      testID={testID ?? `state-location-${reason === 'denied' && !canAskAgain ? 'blocked' : reason}`}
    >
      {mapButton}
    </PanelState>
  );
}

interface LocationCopy {
  icon: BloomIconComponent;
  title: string;
  body: string;
  /** Whether repeating the identical request could plausibly succeed. */
  retryable: boolean;
}

const LOCATION_COPY: Record<LocationErrorReason | 'blocked', LocationCopy> = {
  denied: {
    icon: RiFocus3Line,
    title: 'You declined the location prompt',
    body: "GoWay only asks when you tap something that needs it, so nothing was shared. Try again to be asked once more.",
    retryable: true,
  },
  blocked: {
    icon: RiSettings3Line,
    title: 'Location is blocked for GoWay',
    body: "Your browser or device is refusing without asking, so trying again here won't prompt. Turn location back on for goway.to in its own site or app settings.",
    retryable: false,
  },
  insecureContext: {
    icon: RiLockLine,
    title: "This page isn't on a secure connection",
    body: 'Browsers only share location over https, and this page loaded over http — nobody declined anything. Open GoWay at https://goway.to and it will ask.',
    retryable: false,
  },
  unavailable: {
    icon: RiErrorWarningLine,
    title: 'Your device could not get a fix',
    body: 'Location is allowed, but nothing came back — location services may be off, or there may be no signal where you are.',
    retryable: true,
  },
  timeout: {
    icon: RiTimerLine,
    title: 'That took too long',
    body: 'Your device did not return a position in time. Somewhere with a clearer view of the sky usually helps.',
    retryable: true,
  },
};

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
