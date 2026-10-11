/**
 * `https://goway.to/attribution` — where the map's data comes from, the credit
 * each source asks for, and the notices their licences require.
 *
 * The map's credit line links here for elevation ("© Mapterhorn" →
 * `/attribution#elevation`, `lib/map/provider.ts` → `TERRAIN_ATTRIBUTION_LINK`),
 * because the Copernicus DEM licence requires a source notice and a liability
 * sentence wherever GLO-30-derived data is shown to the public, and the
 * upstream attribution page carries neither. The notices are rendered from
 * `lib/map/credits.ts` verbatim; only the headings are translated.
 *
 * Public and signed-out by design, like the map it credits, and plain text: a
 * crawler, a screen reader and a lawyer all read it the same way.
 */
import { useCallback } from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';

import { useTranslation } from '@/lib/i18n';
import { CREDIT_SECTIONS } from '@/lib/map/credits';

export function AttributionScreen() {
  const router = useRouter();
  const { t } = useTranslation();

  const open = useCallback((href: string) => {
    void Linking.openURL(href).catch(() => {
      // An unopenable link must not take the page down with it.
    });
  }, []);

  const back = useCallback(() => {
    // Opened from a credit link it is usually the first page in the tab.
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-space-16 p-space-20">
        <Button appearance="plain" tone="neutral" onPress={back}>
          {t('credits.back')}
        </Button>
        <Text variant="title-1-bold" accessibilityRole="header">
          {t('credits.title')}
        </Text>
        <Text>{t('credits.intro')}</Text>
        {CREDIT_SECTIONS.map((section) => (
          // `nativeID` is the `id` react-native-web renders: `#elevation` lands here.
          <View key={section.id} nativeID={section.id} className="gap-space-8">
            <Text variant="title-3-semibold" accessibilityRole="header">
              {t(`credits.${section.id}.heading`)}
            </Text>
            <Text>{t(`credits.${section.id}.body`)}</Text>
            <View className="flex-row flex-wrap gap-space-12">
              {section.links.map((link) => (
                <Pressable
                  key={link.href}
                  accessibilityRole="link"
                  accessibilityLabel={link.label}
                  onPress={() => open(link.href)}
                  hitSlop={6}
                >
                  <Text className="text-primary underline">{link.label}</Text>
                </Pressable>
              ))}
            </View>
            {section.notices.length > 0 ? (
              <View className="gap-space-4 rounded-radius-8 bg-muted p-space-12">
                <Text variant="body-semibold">{t('credits.notices')}</Text>
                {section.notices.map((notice) => (
                  <Text key={notice} selectable className="text-muted-foreground">
                    {notice}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
