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
import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { Pressable, View } from 'react-native';
import { useCanvasRegion } from '@oxy.so/bloom/canvas';
import { HeaderActions, type HeaderAction } from '@oxy.so/bloom/page-header';
import { canvasChromeInsets } from '@/lib/map/canvas-policy';
import { useOxy } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { Avatar } from '@oxy.so/bloom/avatar';
import { useTheme } from '@oxy.so/bloom/theme';
import { useClaimTopEdge, windowEdgeGap } from '@oxy.so/bloom/layout';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { AliaAvatarIcon } from '@alia.onl/sdk/avatar';

import { GowayLogo } from '@goway.to/maps';
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
  const router = useRouter();
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = canvasChromeInsets(useCanvasRegion());
  const gate = useAuthGate();
  const { user, openAccountDialog } = useOxy();

  const aliaChatRef = useRef<AliaChatSheetRef>(null);
  const aliaWelcomeSuggestions = useMemo(
    () => [
      { id: 'nearby', text: t('map.aliaSuggestion.nearby') },
      { id: 'directions', text: t('map.aliaSuggestion.directions') },
      { id: 'contribute', text: t('map.aliaSuggestion.contribute') },
    ],
    [t],
  );

  const [height, setHeight] = useState(0);
  useClaimTopEdge(height);

  const topGap = windowEdgeGap(insets.top);
  const leftGap = windowEdgeGap(insets.left, 0);
  const rightGap = windowEdgeGap(insets.right, 0);

  const handle = (user && getNormalizedUserHandle(user)) || '';
  const displayName = user?.name?.displayName?.trim() || handle;
  const accountLabel = displayName || t('map.signIn');

  const handleAccount = useCallback(() => {
    gate.run(() => openAccountDialog('accounts'));
  }, [gate, openAccountDialog]);

  const handleAskAlia = useCallback(() => {
    gate.run(() => aliaChatRef.current?.present());
  }, [gate]);

  const actions = useMemo<readonly HeaderAction[]>(
    () => [
      {
        id: 'ask-alia',
        label: t('map.askAlia'),
        icon: AliaAvatarIcon,
        onPress: handleAskAlia,
        group: 'discovery',
        priority: 30,
      },
      {
        id: 'lists',
        label: t('lists.title'),
        icon: RiListUnordered,
        onPress: () => router.push('/lists'),
        group: 'browse',
        priority: 20,
        labelVisibility: 'hidden',
      },
      {
        id: 'saved',
        label: t('saved.title'),
        onPress: () => router.push('/saved'),
        group: 'browse',
        priority: 10,
      },
      {
        id: 'contribute',
        label: t('map.contribute'),
        onPress: () => router.push('/contribute'),
        group: 'browse',
      },
    ],
    [handleAskAlia, router, t],
  );

  return (
    <>
      <View
        testID="map-top-bar"
        pointerEvents="box-none"
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        className="absolute left-0 right-0 top-0 flex-row items-center justify-between gap-space-12"
        style={{
          paddingTop: topGap,
          paddingLeft: leftGap,
          paddingRight: rightGap,
          paddingBottom: 0,
        }}
      >
        {/* The logo, not the word, and standing on the map rather than on a
          plate. Both follow from the artwork: it is a sticker whose heavy
          outline is what separates it from whatever it sits on, measured over
          the eight colours that actually cover a GoWay map (see `MapBrand`). A
          card behind it would add a rectangle to the map and buy nothing.

          `t('map.title')` stays as the accessible label — the logo is the app's
          name drawn rather than typed, and a screen reader should hear a name. */}
        <GowayLogo width={BRAND_WIDTH} label={t('map.title')} />
        <View className="flex-1 min-w-0 flex-row justify-end">
          <HeaderActions
            actions={actions}
            accessibilityLabel={t('map.actions')}
            style={{ width: 'auto', maxWidth: '100%', flexShrink: 1 }}
            testID="map-top-bar-actions"
          />
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
      {gate.canUsePrivateApi && (
        <AliaChatSheet
          ref={aliaChatRef}
          clientContext={t('map.aliaClientContext')}
          welcomeSuggestions={aliaWelcomeSuggestions}
        />
      )}
    </>
  );
}
