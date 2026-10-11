import { View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { useTranslation } from '@/lib/i18n';

const PHONE_TIPS = [
  'contribute.guide.phone.landscape',
  'contribute.guide.phone.slow',
  'contribute.guide.phone.sides',
  'contribute.guide.phone.people',
] as const;
const CAMERA_TIPS = [
  'contribute.guide.camera.mount',
  'contribute.guide.camera.interval',
  'contribute.guide.camera.walk',
  'contribute.guide.camera.export',
  'contribute.guide.camera.repeat',
] as const;

/**
 * How to capture a street so it becomes a good 3D scene.
 *
 * Phone photos and videos, and 360° photos and videos (#91) exported as an
 * equirectangular panorama, are what the app accepts; a 360° camera is the
 * recommended way to map a street, so it gets its own advice.
 */
export function CaptureGuide() {
  const { t } = useTranslation();
  return (
    <View className="gap-space-12 rounded-radius-lg border border-border p-space-16">
      <Text variant="body-semibold">{t('contribute.guide.title')}</Text>
      <Text className="text-muted-foreground">{t('contribute.guide.why')}</Text>

      <Text variant="body-semibold">{t('contribute.guide.phone.title')}</Text>
      {PHONE_TIPS.map((key) => (
        <Text key={key}>• {t(key)}</Text>
      ))}

      <View className="gap-space-4">
        <Text variant="body-semibold">{t('contribute.guide.camera.title')}</Text>
        <Text className="text-caption text-muted-foreground">
          {t('contribute.guide.camera.upload')}
        </Text>
      </View>
      <Text>{t('contribute.guide.camera.recommendation')}</Text>
      {CAMERA_TIPS.map((key) => (
        <Text key={key}>• {t(key)}</Text>
      ))}
      <Text className="text-caption text-muted-foreground">{t('contribute.guide.privacy')}</Text>
    </View>
  );
}
