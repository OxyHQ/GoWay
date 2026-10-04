/**
 * One contribution's truthful status (issue #15): the pipeline state folded
 * with the privacy gate (`status.ts`), when its temporary source expires, and
 * — when it can still help — whether the area around it is at risk.
 *
 * The at-risk lookup sends the capture's OWN anchor (the contributor's data,
 * already shown to them on this screen) to GoWay's coverage endpoint as a small
 * box. It is held in memory only (`gcTime: 0`): this screen must not turn
 * contributions into a stored location history.
 */
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import type { CaptureAsset } from '@goway.to/sdk';

import { areaContaining, boxAround } from '@/features/street3d/coverageStyle';
import { useStreetCoverage } from '@/features/street3d/queries';
import { useTranslation } from '@/lib/i18n';

import { contributionStatus, sourceExpiry, type ContributionTone } from './status';

/** Coverage cells are coarse; a box this size always overlaps the right one. */
const LOOKUP_RADIUS_METERS = 150;

const TONE_CLASS: Record<ContributionTone, string> = {
  neutral: 'text-muted-foreground',
  progress: 'text-info-text',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-error-text',
};

export interface ContributionStatusCardProps {
  asset: CaptureAsset;
  busy: boolean;
  onWithdraw: (asset: CaptureAsset) => void;
}

export function ContributionStatusCard({ asset, busy, onWithdraw }: ContributionStatusCardProps) {
  const { t, locale } = useTranslation();
  const status = contributionStatus(asset);
  const expiry = sourceExpiry(asset);

  const anchor = asset.anchor?.coordinate;
  const coverage = useStreetCoverage(status.canStillHelp && anchor ? boxAround(anchor, LOOKUP_RADIUS_METERS) : null, {
    enabled: status.canStillHelp && anchor != null,
    gcTime: 0,
  });
  const area = anchor && coverage.data ? areaContaining(coverage.data.areas, anchor) : null;
  const atRisk = status.canStillHelp && area?.state === 'at_risk';

  const date = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };

  const kind = asset.mediaKind === 'video' ? t('contribute.kind.video') : t('contribute.kind.photo');

  return (
    <View className="gap-space-8 rounded-radius-lg border border-border p-space-12">
      <Text variant="body-semibold">
        {kind} · <Text className={TONE_CLASS[status.tone]}>{t(status.titleKey)}</Text>
      </Text>
      <Text className="text-muted-foreground">{t(status.bodyKey)}</Text>
      {status.privacyPassed && !status.terminal ? (
        <Text className="text-caption text-success-text">{t('contribute.status.privacyPassedLine')}</Text>
      ) : null}
      {expiry ? (
        <Text className="text-caption text-muted-foreground">
          {t('contribute.status.expires', { date: date(expiry.expiresAt) })}
          {expiry.protectedUntil ? ` ${t('contribute.status.protected', { date: date(expiry.protectedUntil) })}` : ''}
        </Text>
      ) : null}
      {atRisk ? (
        <View className="rounded-radius-8 bg-warning-subtle px-space-8 py-space-4">
          <Text className="text-caption text-warning-text">
            {area?.atRiskUntil
              ? t('contribute.status.atRiskUntil', { date: date(area.atRiskUntil) })
              : t('contribute.status.atRisk')}
          </Text>
        </View>
      ) : null}
      {/* Withdrawal is consent, not pipeline: it stays available for a
          rejected or privacy-failed capture too, until its source is gone. */}
      {asset.state !== 'deleted' && asset.state !== 'expired' && asset.state !== 'abandoned' ? (
        <Button appearance="outline" disabled={busy} onPress={() => onWithdraw(asset)}>
          {t('contribute.withdraw')}
        </Button>
      ) : null}
    </View>
  );
}
