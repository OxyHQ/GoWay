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
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { useClaimTopEdge, windowEdgeGap } from '@oxy.so/bloom/layout';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';

import { useAuthGate } from '@/lib/authGate';
import { useTranslation } from '@/lib/i18n';

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
      <View className="flex-row items-center rounded-radius-max bg-card px-space-16 py-space-8 shadow-m">
        <Text className="text-subtitle text-foreground">{t('map.title')}</Text>
      </View>

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
