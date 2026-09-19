/**
 * How an ecosystem capability is PRESENTED, including how much it is worth
 * believing.
 *
 * `PlaceCapability` deliberately carries `verification` and `observedAt`
 * alongside the claim itself, and `@goway.to/sdk` refuses to parse one without
 * them, precisely so this file can exist: issue #7 requires that a capability's
 * verification and freshness be *distinguishable*, not that a badge appear.
 * "Accepts FairCoin, Oxy-verified last week" and "somebody said so in 2023" are
 * different facts and must not render as the same pill.
 *
 * Two rules this module encodes, both from issue #7 → Accessibility:
 *
 *  - **Colour is never the only indicator.** Every capability renders an icon,
 *    a text label AND a provenance sentence. The tone is redundant emphasis.
 *  - **Nothing is invented.** A capability GoWay has not heard of is shown with
 *    its own key rather than dropped, and a stale claim is labelled stale
 *    rather than quietly upgraded.
 */
import type { CapabilityVerification, PlaceCapability } from '@goway.to/sdk';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiShoppingBasketLine } from '@oxy.so/bloom/icons/RiShoppingBasketLine';
import { RiBikeLine } from '@oxy.so/bloom/icons/RiBikeLine';

/** How the UI should weight a claim. Ordered weakest to strongest. */
export type CapabilityTone = 'neutral' | 'info' | 'verified';

export interface CapabilityPresentation {
  /** The capability's own key, so an unknown one is still identifiable. */
  key: string;
  label: string;
  icon: BloomIconComponent;
  /** "Oxy verified", "Reported by the business"… — always rendered as TEXT. */
  provenance: string;
  /** How old the claim is, in words. Absent when `observedAt` is unusable. */
  freshness: string | null;
  /** `true` when the claim is old enough that it must not read as current. */
  stale: boolean;
  tone: CapabilityTone;
}

/** Label + glyph for the capabilities this build knows by name. */
const KNOWN: Readonly<Record<string, { label: string; icon: BloomIconComponent }>> = {
  'payments.faircoin.accepted': { label: 'Accepts FairCoin', icon: RiCoinsLine },
  'commerce.mercaria.store': { label: 'Mercaria store', icon: RiShoppingBasketLine },
  'mobility.moovo.pickup': { label: 'Moovo pickup point', icon: RiBikeLine },
  'housing.homiio.listings': { label: 'Homiio listings', icon: RiHome5Line },
  'social.mention.location': { label: 'Mention location', icon: RiMapPin2Line },
};

/**
 * How the claim came to be believed, in the user's words.
 *
 * The strings are deliberately concrete about WHO said it. "Verified" alone is
 * the word that lets a community report pass for an audited fact.
 */
const PROVENANCE: Readonly<Record<CapabilityVerification, { text: string; tone: CapabilityTone }>> = {
  community_reported: { text: 'Reported by the community', tone: 'neutral' },
  external_source: { text: 'From an external source', tone: 'neutral' },
  business_asserted: { text: 'Stated by the business', tone: 'info' },
  oxy_verified: { text: 'Verified by Oxy', tone: 'verified' },
};

/** Past this age a claim is presented as historic rather than current. */
const STALE_AFTER_DAYS = 365;
const DAY_MS = 86_400_000;

/**
 * Turn `observedAt` into a phrase, or `null` when the instant is unusable.
 *
 * Deliberately coarse. A capability observed "3 days ago" and one observed
 * "4 days ago" are the same fact to someone deciding whether to walk there, and
 * a precise timestamp invites a precision the source does not have.
 */
function describeAge(observedAt: string, now: number): { text: string; stale: boolean } | null {
  const at = Date.parse(observedAt);
  if (Number.isNaN(at)) return null;
  const days = Math.floor((now - at) / DAY_MS);
  if (days < 0) return null;
  if (days === 0) return { text: 'Checked today', stale: false };
  if (days === 1) return { text: 'Checked yesterday', stale: false };
  if (days < 30) return { text: `Checked ${days} days ago`, stale: false };
  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30));
    return { text: `Checked ${months} month${months === 1 ? '' : 's'} ago`, stale: days > STALE_AFTER_DAYS };
  }
  const years = Math.max(1, Math.floor(days / 365));
  return { text: `Last checked over ${years} year${years === 1 ? '' : 's'} ago`, stale: true };
}

/**
 * Presentation for one capability.
 *
 * A stale claim is DEMOTED to `neutral` however it was verified: an Oxy
 * verification from two years ago is evidence about the past, and painting it
 * as a current guarantee is the single failure this whole provenance contract
 * exists to prevent.
 */
export function presentCapability(capability: PlaceCapability, now: number = Date.now()): CapabilityPresentation {
  const known = KNOWN[capability.key];
  const provenance = PROVENANCE[capability.verification];
  const age = describeAge(capability.observedAt, now);
  const stale = age?.stale ?? false;

  return {
    key: capability.key,
    label: known?.label ?? capability.key,
    icon: known?.icon ?? RiMapPin2Line,
    provenance: provenance.text,
    freshness: age?.text ?? null,
    stale,
    tone: stale ? 'neutral' : provenance.tone,
  };
}

/**
 * The capabilities worth showing on a place, strongest and freshest first.
 *
 * A capability whose value is explicitly `false` is REMOVED rather than shown
 * as a negative badge: "does not accept FairCoin" is not a feature, and a row
 * of crossed-out pills is noise on every place that has never been asked.
 */
export function visibleCapabilities(capabilities: readonly PlaceCapability[]): PlaceCapability[] {
  const order: Record<CapabilityVerification, number> = {
    oxy_verified: 0,
    business_asserted: 1,
    external_source: 2,
    community_reported: 3,
  };
  return capabilities
    .filter((capability) => capability.value !== false)
    .slice()
    .sort((a, b) => {
      const byVerification = order[a.verification] - order[b.verification];
      if (byVerification !== 0) return byVerification;
      return Date.parse(b.observedAt) - Date.parse(a.observedAt);
    });
}

/**
 * A single line naming a place's ecosystem capabilities, for a marker's or a
 * row's accessible name.
 *
 * A screen reader gets the capability in words before it gets to the badge, so
 * the badge never has to be the thing carrying the information.
 */
export function capabilitySummary(capabilities: readonly PlaceCapability[]): string | null {
  const visible = visibleCapabilities(capabilities);
  if (visible.length === 0) return null;
  return visible.map((capability) => presentCapability(capability).label).join(', ');
}
