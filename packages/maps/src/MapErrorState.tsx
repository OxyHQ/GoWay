/**
 * The map's degraded state.
 *
 * A MapLibre canvas whose style or tiles never arrive renders a plain coloured
 * rectangle and reports nothing — indistinguishable from an app that is
 * simply slow, forever. So both forks watch for the two failures a hosted
 * source can produce (the style document, and the tiles it points at) and
 * cover the CANVAS — only the canvas — with this. Search, saved places, the sheet and every other piece of
 * chrome stay mounted and usable above it, because they are siblings of the
 * canvas, not children.
 */
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { useTheme } from '@oxy.so/bloom/theme';

import type { MapError } from './types';

export interface MapErrorStateProps {
  error: MapError;
  onRetry?: () => void;
  retryLabel?: string;
}

/** One sentence per reason — what happened, in the user's terms, not ours. */
const MESSAGES: Record<MapError['reason'], { title: string; body: string }> = {
  style: {
    title: 'Map unavailable',
    body: "We couldn't load the map's design. Everything else still works.",
  },
  tiles: {
    title: 'Map data unavailable',
    body: "We couldn't reach the map data for this area. Check your connection and try again.",
  },
  unsupported: {
    title: 'Map not supported here',
    body: 'This build has no map renderer for the current platform.',
  },
  runtime: {
    title: 'Map stopped',
    body: 'The map ran into a problem. Reloading it usually fixes it.',
  },
};

function MapErrorStateComponent({ error, onRetry, retryLabel = 'Try again' }: MapErrorStateProps) {
  const theme = useTheme();
  const copy = MESSAGES[error.reason] ?? MESSAGES.runtime;

  return (
    <View
      accessibilityRole="alert"
      style={[styles.cover, { backgroundColor: theme.colors.backgroundSecondary }]}
      testID="map-error-state"
    >
      <RiErrorWarningLine width={28} height={28} fill={theme.colors.textSecondary} />
      <Text variant="headline-semibold" style={[styles.centred, { color: theme.colors.text }]}>
        {copy.title}
      </Text>
      <Text
        variant="body-2-regular"
        style={[styles.centred, { color: theme.colors.textSecondary }]}
      >
        {copy.body}
      </Text>
      {onRetry ? (
        <Button
          appearance="outline"
          tone="neutral"
          size="sm"
          leadingIcon={RiRefreshLine}
          onPress={onRetry}
        >
          {retryLabel}
        </Button>
      ) : null}
    </View>
  );
}

export const MapErrorState = memo(MapErrorStateComponent);

const styles = StyleSheet.create({
  cover: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  centred: { textAlign: 'center' },
});
