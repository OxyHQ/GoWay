/**
 * The floating top chrome over the map.
 *
 * It CLAIMS the top edge rather than reading it: it is the surface parked
 * there, so the side panel and the "Search this area" pill stack BELOW it
 * instead of underneath it. The claimed height is MEASURED — a constant plus
 * insets disagrees with reality the moment a translation wraps or the user
 * enlarges their font, and does so silently.
 *
 * This is also the only place the screen mentions identity. Signed in, the
 * avatar opens account management; signed out, `useAuthGate().run()` declines
 * to run the action and opens the in-app Oxy dialog instead. Either way the map
 * stays mounted underneath — there is no route to come back from.
 */
import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxy.so/services';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { Avatar } from '@oxy.so/bloom/avatar';
import { useTheme } from '@oxy.so/bloom/theme';
import { useClaimTopEdge, windowEdgeGap } from '@oxy.so/bloom/layout';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';

import { GowayLogo } from '@/components/brand';
import { useAuthGate } from '@/lib/authGate';
import { useTranslation } from '@/lib/i18n';

/**
 * How wide the logo draws in the bar.
 *
 * Derived rather than chosen: the account button opposite is `h-11` (44px), and
 * the wordmark's 1.582:1 makes 44px tall exactly 70px wide, so the two ends of
 * the bar occupy the same vertical band.
 */
const BRAND_WIDTH = 70;

export function MapTopBar() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const gate = useAuthGate();
  const { user, openAccountDialog } = useOxy();

  const [height, setHeight] = useState(0);
  useClaimTopEdge(height);

  const topGap = windowEdgeGap(insets.top);
  const sideGap = windowEdgeGap(Math.max(insets.left, insets.right), 0);

  const handle = (user && getNormalizedUserHandle(user)) || '';
  const displayName = user?.name?.displayName?.trim() || handle;
  const accountLabel = displayName || t('map.signIn');

  const handleAccount = useCallback(() => {
    gate.run(() => openAccountDialog('accounts'));
  }, [gate, openAccountDialog]);

  return (
    <View
      pointerEvents="box-none"
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
      className="absolute left-0 right-0 top-0 flex-row items-center justify-between gap-space-12"
      style={{ paddingTop: topGap, paddingHorizontal: sideGap, paddingBottom: 0 }}
    >
      {/* The logo, not the word, and standing on the map rather than on a
          plate. Both follow from the artwork: it is a sticker whose heavy
          outline is what separates it from whatever it sits on, measured over
          the eight colours that actually cover a GoWay map (see `MapBrand`). A
          card behind it would add a rectangle to the map and buy nothing.

          `t('map.title')` stays as the accessible label — the logo is the app's
          name drawn rather than typed, and a screen reader should hear a name. */}
      <GowayLogo width={BRAND_WIDTH} label={t('map.title')} />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accountLabel}
        onPress={handleAccount}
        className="h-11 w-11 items-center justify-center rounded-radius-max bg-card shadow-m active:opacity-80"
      >
        {user ? (
          <Avatar
            source={user.avatar ?? null}
            initials={displayName ? displayName.slice(0, 2).toUpperCase() : undefined}
            size="sm"
            alt={accountLabel}
          />
        ) : (
          <RiUserLine width={20} height={20} fill={theme.colors.text} />
        )}
      </Pressable>
    </View>
  );
}
