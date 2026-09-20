/**
 * Turning a contribution into a retention decision.
 *
 * Every stored object needs three answers before it exists: what KIND of thing
 * it is, what is USING it, and when it DIES. The schema will not accept a row
 * without all three, so this module is where they are decided — in one place,
 * from configuration, rather than at each insert site where the third would
 * eventually be forgotten.
 *
 * ## Expiry is a ceiling, not a plan
 *
 * `expiresAt` is the latest the bytes may survive. Most objects die long before
 * it: a raw video is retired once its keyframes are safe, a duplicate is
 * collapsed, a contributor asks for removal, moderation intervenes. That is why
 * `deletionEligibleAt` exists beside it and why the sweeper's question is "is
 * this still being used for the reason it was kept?" rather than "has it aged
 * out?". An expiry-only model keeps every byte for its full window by default,
 * which is the expensive answer to a cost issue.
 */

import { captureConfig } from '../config/capture';
import type {
  CaptureMediaKind,
  CaptureRetentionClass,
  RetentionReason,
} from '@goway/shared-types';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** `base` plus `days`, as an absolute instant. */
export function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * MILLISECONDS_PER_DAY);
}

/**
 * What a newly stored object's lifecycle columns will be.
 *
 * All four fields together, never a partial object: the whole point of the
 * schema's NOT NULLs is that "we will set the expiry in a moment" is not a
 * reachable state, and a planner that could return half a decision would
 * reintroduce it above the database.
 */
export interface RetentionPlan {
  retentionClass: CaptureRetentionClass;
  retentionReason: RetentionReason;
  expiresAt: Date;
  /** Earliest the sweeper may delete, when that is before expiry. */
  deletionEligibleAt?: Date;
}

/**
 * The retention plan for a freshly contributed original.
 *
 * A photo is kept because the privacy gate has not run on it yet — that is
 * genuinely why the bytes are on disk the moment they land, and naming the
 * reason honestly is what lets a sweeper notice when it stops being true.
 *
 * A video is a `derivation_source` and says so. Its useful content is its
 * keyframes; the original exists to produce them and to be diagnosable if that
 * fails. So it gets a much shorter window AND a `deletionEligibleAt` well
 * inside it, which is what makes "raw video can be removed early after safe
 * keyframe extraction" a property of the row rather than a rule in a script.
 */
export function planOriginalRetention(mediaKind: CaptureMediaKind, now: Date): RetentionPlan {
  if (mediaKind === 'video') {
    return {
      retentionClass: 'raw_video',
      retentionReason: 'derivation_source',
      expiresAt: addDays(now, captureConfig.retentionDays.raw_video),
      deletionEligibleAt: addDays(now, captureConfig.videoDeletionEligibleDays),
    };
  }
  return {
    retentionClass: 'raw_photo',
    retentionReason: 'awaiting_privacy_processing',
    expiresAt: addDays(now, captureConfig.retentionDays.raw_photo),
  };
}

/**
 * The expiry a SECOND contribution of already-stored bytes is entitled to.
 *
 * Deduplication means one object serving two contributions, so the later
 * contributor must not inherit however much of the first one's window happens
 * to be left — a photo contributed on day 89 of somebody else's 90-day window
 * would otherwise die tomorrow, and the contributor would have been told a
 * retention policy that was not applied to them.
 *
 * So the object takes the LATER of the two expiries. This is deliberately NOT
 * counted as a retention extension: `retention_extension_count` exists to bound
 * #10's rescue extensions, where GoWay keeps something longer than policy for
 * its own reasons. A second contributor receiving their own full, unextended
 * policy window is not that, and spending a rescue budget on it would make a
 * popular photo un-rescuable later. The database's absolute ceiling still caps
 * the result either way.
 */
export function extendedExpiry(currentExpiry: Date, freshPlan: RetentionPlan): Date {
  return freshPlan.expiresAt > currentExpiry ? freshPlan.expiresAt : currentExpiry;
}

/** When an upload target issued now stops being accepted by the store. */
export function uploadIntentExpiry(now: Date): Date {
  return new Date(now.getTime() + captureConfig.uploadIntentTtlSeconds * 1000);
}
