/**
 * What a contributor is told about one capture — issue #15.
 *
 * A capture has TWO independent facts: where it is in the pipeline
 * (`asset.state`) and whether it has cleared privacy (`asset.privacy.state`).
 * The old screen printed the first and ignored the second, which made
 * "Accepted" read as "done" for media that had not yet been blurred. This
 * folds both into one truthful headline plus a plain explanation, as message
 * keys so every locale says the same thing.
 *
 * Rules the copy keys below hold to:
 *
 *  - Say what is true now, not what might happen. "Selected for
 *    reconstruction" is not "will become a scene".
 *  - Expiry is about the TEMPORARY source media, never about a published
 *    scene: published output survives its inputs, and nothing here may imply
 *    otherwise.
 */
import type { CaptureAsset } from '@goway.to/sdk';

export type ContributionStatusKey =
  | 'expected'
  | 'abandoned'
  | 'checking'
  | 'privacyPending'
  | 'privacyProcessing'
  | 'privacyFailed'
  | 'blocked'
  | 'accepted'
  | 'rejected'
  | 'waitingForOverlap'
  | 'reconstructionCandidate'
  | 'integrated'
  | 'expired'
  | 'deleted';

export type ContributionTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export interface ContributionStatus {
  key: ContributionStatusKey;
  /** `contribute.status.<key>.title` */
  titleKey: string;
  /** `contribute.status.<key>.body` */
  bodyKey: string;
  tone: ContributionTone;
  /** No further pipeline change will happen to this capture. */
  terminal: boolean;
  /** The privacy check cleared this capture (shown as its own line). */
  privacyPassed: boolean;
  /**
   * The capture can still help an area: an "area at risk" hint is meaningful
   * for it. Terminal and not-yet-uploaded captures cannot.
   */
  canStillHelp: boolean;
}

function status(
  key: ContributionStatusKey,
  tone: ContributionTone,
  flags: { terminal?: boolean; privacyPassed?: boolean; canStillHelp?: boolean } = {},
): ContributionStatus {
  return {
    key,
    titleKey: `contribute.status.${key}.title`,
    bodyKey: `contribute.status.${key}.body`,
    tone,
    terminal: flags.terminal ?? false,
    privacyPassed: flags.privacyPassed ?? false,
    canStillHelp: flags.canStillHelp ?? false,
  };
}

export function contributionStatus(
  asset: Pick<CaptureAsset, 'state' | 'privacy'>,
): ContributionStatus {
  const privacy = asset.privacy?.state ?? 'pending';
  const passed = privacy === 'passed';

  // Ends first: nothing about privacy changes what a withdrawn or expired
  // capture means to its contributor.
  switch (asset.state) {
    case 'deleted':
      return status('deleted', 'neutral', { terminal: true });
    case 'expired':
      return status('expired', 'neutral', { terminal: true, privacyPassed: passed });
    case 'abandoned':
      return status('abandoned', 'neutral', { terminal: true });
    case 'rejected':
      return status('rejected', 'danger', { terminal: true });
    default:
      break;
  }

  if (privacy === 'blocked') return status('blocked', 'danger', { terminal: true });
  if (privacy === 'failed') return status('privacyFailed', 'danger', { terminal: true });

  switch (asset.state) {
    case 'expected':
      return status('expected', 'neutral');
    case 'integrated':
      return status('integrated', 'success', { privacyPassed: passed });
    case 'reconstruction_candidate':
      return status('reconstructionCandidate', 'progress', {
        privacyPassed: passed,
        canStillHelp: true,
      });
    case 'waiting_for_overlap':
      return status('waitingForOverlap', 'progress', { privacyPassed: passed, canStillHelp: true });
    default:
      break;
  }

  // uploaded / validating / accepted: the privacy gate is the real state.
  if (privacy === 'in_progress')
    return status('privacyProcessing', 'progress', { canStillHelp: true });
  if (privacy === 'pending') {
    return asset.state === 'validating'
      ? status('checking', 'progress', { canStillHelp: true })
      : status('privacyPending', 'progress', { canStillHelp: true });
  }
  return status('accepted', 'success', { privacyPassed: true, canStillHelp: true });
}

/**
 * When the temporary source is expected to go, and whether a rescue extension
 * is holding it longer. `null` for a capture whose source is already gone.
 */
export function sourceExpiry(
  asset: Pick<CaptureAsset, 'state' | 'media'>,
  now: number = Date.now(),
): { expiresAt: string; protectedUntil?: string } | null {
  if (asset.state === 'deleted' || asset.state === 'expired' || asset.state === 'abandoned')
    return null;
  const lifecycle = asset.media?.lifecycle;
  if (!lifecycle || lifecycle.deletedAt) return null;
  const protectedUntil =
    lifecycle.protectedUntil && Date.parse(lifecycle.protectedUntil) > now
      ? lifecycle.protectedUntil
      : undefined;
  return { expiresAt: lifecycle.expiresAt, ...(protectedUntil ? { protectedUntil } : {}) };
}
