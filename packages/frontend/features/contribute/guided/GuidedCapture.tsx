/**
 * `GuidedCapture` — the shared contract, and the fallback.
 *
 * Metro resolves `GuidedCapture.web.tsx` on web and `GuidedCapture.native.tsx`
 * on iOS and Android, so this file is normally never bundled. TypeScript has
 * no platform extensions and resolves `./GuidedCapture` here, which is what
 * makes both forks answer to the same `GuidedCaptureProps`. Any other platform
 * gets an honest "camera unavailable" rather than a missing-module crash.
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import { GuidedOverlay } from './GuidedOverlay';
import { recordingBudget } from './recording';
import type { GuidedCaptureProps } from './types';
import { useGuidedSession } from './useGuidedSession';

export function GuidedCapture({ policy, onCancel }: GuidedCaptureProps) {
  const { t } = useTranslation();
  const session = useGuidedSession();
  const budget = useMemo(() => recordingBudget(policy.video), [policy.video]);
  return <View className="flex-1 bg-background">
    <GuidedOverlay phase="error" session={session} budget={budget} portrait={false} notices={[]}
      error={t('contribute.guided.error.camera')} onStart={() => {}} onStop={() => {}} onCancel={onCancel} />
  </View>;
}

export type { GuidedCaptureProps, GuidedRecording } from './types';
