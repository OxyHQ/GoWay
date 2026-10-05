import { ActivityIndicator, View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiCheckboxBlankCircleLine } from '@oxy.so/bloom/icons/RiCheckboxBlankCircleLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useTranslation } from '@/lib/i18n';
import type { CoachWarning } from './coach';
import { currentStep, formatClock, GUIDED_STEPS, hasStretchTarget, isLastStep, stepMessageKey, stepStatus, stretchPace } from './plan';
import type { RecordingBudget } from './recording';
import type { GuidedSession } from './useGuidedSession';

export type GuidedPhase = 'starting' | 'ready' | 'recording' | 'saving' | 'error';

interface GuidedOverlayProps {
  phase: GuidedPhase;
  session: GuidedSession;
  budget: RecordingBudget;
  /** The frame is taller than wide, or the device says it is held upright. */
  portrait: boolean;
  /** Translated status lines: what could be locked, what cannot be checked live. */
  notices: readonly string[];
  error?: string;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}

const WARNING_KEYS: Readonly<Record<CoachWarning, string>> = {
  blur: 'contribute.guided.warn.blur',
  exposure: 'contribute.guided.warn.exposure',
  dark: 'contribute.guided.warn.dark',
};

/** The coaching layer drawn over the camera preview, on every platform. */
export function GuidedOverlay({ phase, session, budget, portrait, notices, error, onStart, onStop, onCancel }: GuidedOverlayProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { plan } = session;
  const recording = phase === 'recording' && plan !== null;
  const step = plan ? currentStep(plan) : GUIDED_STEPS[0];
  const pace = !plan ? null
    : hasStretchTarget(step) ? t(`contribute.guided.pace.${stretchPace(session.stepSeconds)}`, { time: formatClock(session.stepSeconds) })
    : t('contribute.guided.pace.finish');

  return <View pointerEvents="box-none" className="absolute inset-0 justify-between p-space-16">
    <View pointerEvents="box-none" className="gap-space-8">
      <View className="flex-row items-center justify-between gap-space-8">
        <Button appearance="subtle" tone="neutral" size="sm" disabled={phase === 'saving'} onPress={onCancel}>{t('contribute.guided.cancel')}</Button>
        {recording && <View className="flex-row items-center gap-space-4 rounded-radius-max bg-background/85 px-space-12 py-space-4" accessibilityRole="timer">
          <View className="h-3 w-3 rounded-radius-max bg-error" />
          <Text variant="body-semibold">{t('contribute.guided.recording', { time: formatClock(session.elapsedSeconds) })}</Text>
        </View>}
      </View>
      <View pointerEvents="none" className="items-center gap-space-8" accessibilityLiveRegion="assertive">
        {portrait && phase !== 'error' && <Text accessibilityRole="alert" className="rounded-radius-16 bg-error-subtle px-space-12 py-space-8 text-error-text">{t('contribute.guided.warn.portrait')}</Text>}
        {session.warnings.map((warning) => <Text key={warning} accessibilityRole="alert" className="rounded-radius-16 bg-warning-subtle px-space-12 py-space-8 text-warning-text">{t(WARNING_KEYS[warning])}</Text>)}
      </View>
    </View>

    <View className="w-full max-w-xl gap-space-8 self-center rounded-radius-16 bg-background/90 p-space-16">
      {phase === 'starting' && <View className="flex-row items-center gap-space-8"><ActivityIndicator /><Text>{t('contribute.guided.preparing')}</Text></View>}
      {phase === 'error' && <Text accessibilityRole="alert">{error}</Text>}
      {phase === 'ready' && <>
        <Text variant="headline-semibold">{t('contribute.guided.title')}</Text>
        <Text>{t('contribute.guided.intro')}</Text>
        <Text className="text-caption text-muted-foreground">{t('contribute.guided.format', { resolution: budget.resolution, minutes: Math.max(1, Math.floor(budget.expectedMaxSeconds / 60)) })}</Text>
        <Text className="text-caption text-muted-foreground">{t('contribute.guided.locationHint')}</Text>
      </>}
      {(phase === 'ready' || recording) && <View className="gap-space-4">
        {recording && <Text className="text-caption text-muted-foreground">{t('contribute.guided.stepOf', { current: plan.index + 1, total: GUIDED_STEPS.length })}</Text>}
        {GUIDED_STEPS.map((item, index) => {
          const status = plan ? stepStatus(plan, index) : 'todo';
          return <View key={item} className="flex-row items-center gap-space-8">
            {status === 'done'
              ? <RiCheckboxCircleFill width={18} height={18} fill={theme.colors.success} />
              : <RiCheckboxBlankCircleLine width={18} height={18} fill={status === 'current' ? theme.colors.primary : theme.colors.textSecondary} />}
            <Text variant={status === 'current' ? 'body-semibold' : 'body-regular'} className={status === 'done' ? 'text-muted-foreground' : undefined}>
              {index + 1}. {t(stepMessageKey(item))}
            </Text>
          </View>;
        })}
        {recording && pace && <Text className="text-caption">{pace}</Text>}
      </View>}
      {notices.map((notice) => <Text key={notice} className="text-caption text-muted-foreground">{notice}</Text>)}
      {phase === 'saving' && <View className="flex-row items-center gap-space-8"><ActivityIndicator /><Text>{t('contribute.guided.saving')}</Text></View>}
      <View className="flex-row flex-wrap justify-end gap-space-8">
        {phase === 'ready' && <Button onPress={onStart}>{t('contribute.guided.start')}</Button>}
        {recording && !isLastStep(plan) && <Button appearance="outline" onPress={session.next}>{t('contribute.guided.next')}</Button>}
        {recording && <Button tone="danger" onPress={onStop}>{t('contribute.guided.stop')}</Button>}
      </View>
    </View>
  </View>;
}
