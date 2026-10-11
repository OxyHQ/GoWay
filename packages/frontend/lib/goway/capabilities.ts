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
 *
 * What a key IS — its label, its value's kind, its enum labels, its group — is
 * the SDK's capability registry. What is this app's is how it looks: a glyph
 * per key, how a value reads on screen, and which few keys are Oxy-ecosystem
 * facts worth a badge on a map pin.
 */
import {
  CAPABILITY_GROUPS,
  capabilityGroupLabel,
  capabilityGroupOf,
  capabilityHolds,
  capabilityLabel,
  capabilityValueKind,
  capabilityValueLabel,
  localizedLabel,
  strongestCapability,
  type CapabilityGroup,
  type CapabilityKey,
  type CapabilityVerification,
  type Labels,
  type PlaceCapability,
} from '@goway.to/sdk';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiBankCardLine } from '@oxy.so/bloom/icons/RiBankCardLine';
import { RiBikeLine } from '@oxy.so/bloom/icons/RiBikeLine';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';
import { RiCarLine } from '@oxy.so/bloom/icons/RiCarLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiCoinsLine } from '@oxy.so/bloom/icons/RiCoinsLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiHome5Line } from '@oxy.so/bloom/icons/RiHome5Line';
import { RiInstagramFill } from '@oxy.so/bloom/icons/RiInstagramFill';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiMenLine } from '@oxy.so/bloom/icons/RiMenLine';
import { RiMetaFill } from '@oxy.so/bloom/icons/RiMetaFill';
import { RiMoneyEuroBoxLine } from '@oxy.so/bloom/icons/RiMoneyEuroBoxLine';
import { RiPriceTag3Line } from '@oxy.so/bloom/icons/RiPriceTag3Line';
import { RiRestaurantLine } from '@oxy.so/bloom/icons/RiRestaurantLine';
import { RiShoppingBag3Line } from '@oxy.so/bloom/icons/RiShoppingBag3Line';
import { RiShoppingBasketLine } from '@oxy.so/bloom/icons/RiShoppingBasketLine';
import { RiSnowflakeLine } from '@oxy.so/bloom/icons/RiSnowflakeLine';
import { RiStore2Line } from '@oxy.so/bloom/icons/RiStore2Line';
import { RiSunLine } from '@oxy.so/bloom/icons/RiSunLine';
import { RiTwitterXFill } from '@oxy.so/bloom/icons/RiTwitterXFill';
import { RiWheelchairLine } from '@oxy.so/bloom/icons/RiWheelchairLine';
import { RiWifiLine } from '@oxy.so/bloom/icons/RiWifiLine';

import { deviceLocale } from '@/lib/i18n';

/** How the UI should weight a claim. Ordered weakest to strongest. */
export type CapabilityTone = 'neutral' | 'info' | 'verified';

export interface CapabilityPresentation {
  /** The capability's own key, so an unknown one is still identifiable. */
  key: string;
  /** What the place has — "Accepts FairCoin", "Partly wheelchair accessible". */
  label: string;
  /** The value, when it says more than the label: "Italian, Pizza", "●●○○". */
  value: string | null;
  /** A link the value opens, for a URL-valued capability. */
  href: string | null;
  icon: BloomIconComponent;
  /** "Oxy verified", "Reported by the business"… — always rendered as TEXT. */
  provenance: string;
  /** How old the claim is, in words. Absent when `observedAt` is unusable. */
  freshness: string | null;
  /** `true` when the claim is old enough that it must not read as current. */
  stale: boolean;
  tone: CapabilityTone;
}

/** One group of capabilities, in the registry's group order. */
export interface CapabilityGroupPresentation {
  group: CapabilityGroup | 'other';
  label: string;
  items: CapabilityPresentation[];
}

/** A glyph per key; a key not listed takes its group's. */
const ICON_BY_KEY: Partial<Readonly<Record<CapabilityKey, BloomIconComponent>>> = {
  'payments.faircoin.accepted': RiCoinsLine,
  'payments.cash': RiMoneyEuroBoxLine,
  'amenities.wifi': RiWifiLine,
  'amenities.outdoor_seating': RiSunLine,
  'amenities.takeaway': RiShoppingBag3Line,
  'amenities.delivery': RiBikeLine,
  'amenities.reservations': RiCalendarLine,
  'amenities.drive_through': RiCarLine,
  'amenities.toilets': RiMenLine,
  'amenities.air_conditioning': RiSnowflakeLine,
  'social.instagram': RiInstagramFill,
  'social.facebook': RiMetaFill,
  'social.x': RiTwitterXFill,
  'social.whatsapp': RiChat3Line,
  'commerce.mercaria.store': RiShoppingBasketLine,
  'mobility.moovo.pickup': RiBikeLine,
  'housing.homiio.listings': RiHome5Line,
  'social.mention.location': RiMapPin2Line,
};

const ICON_BY_GROUP: Readonly<Record<CapabilityGroup, BloomIconComponent>> = {
  accessibility: RiWheelchairLine,
  payment: RiBankCardLine,
  amenities: RiStore2Line,
  food: RiRestaurantLine,
  price: RiPriceTag3Line,
  social: RiGlobalLine,
  brand: RiStore2Line,
  ecosystem: RiMapPin2Line,
};

/**
 * The capabilities that are Oxy-ecosystem facts — the ones a map pin and a
 * result row badge. An accessible toilet is worth reading on the place card;
 * it is not worth a badge on every restaurant on the map.
 */
const ECOSYSTEM_KEYS: ReadonlySet<string> = new Set<CapabilityKey>([
  'payments.faircoin.accepted',
  'commerce.mercaria.store',
  'mobility.moovo.pickup',
  'housing.homiio.listings',
  'social.mention.location',
]);

/**
 * How the claim came to be believed, in the user's words.
 *
 * The strings are deliberately concrete about WHO said it. "Verified" alone is
 * the word that lets a community report pass for an audited fact.
 */
const PROVENANCE: Readonly<Record<CapabilityVerification, { text: string; tone: CapabilityTone }>> =
  {
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
    return {
      text: `Checked ${months} month${months === 1 ? '' : 's'} ago`,
      stale: days > STALE_AFTER_DAYS,
    };
  }
  const years = Math.max(1, Math.floor(days / 365));
  return { text: `Last checked over ${years} year${years === 1 ? '' : 's'} ago`, stale: true };
}

/** A URL without its scheme and trailing slash — what a person reads. */
function readableLink(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
}

/**
 * The label and the value text, by the kind of value the key declares.
 *
 * An enum's own value label IS the statement ("Partly wheelchair accessible"),
 * so it replaces the key's label rather than following it.
 */
function describeValue(
  capability: PlaceCapability,
  locale: string,
): { label: string; value: string | null; href: string | null } {
  const label = capabilityLabel(capability.key, locale);
  const { value } = capability;
  switch (capabilityValueKind(capability.key)) {
    case 'enum':
      return {
        label:
          typeof value === 'string' ? capabilityValueLabel(capability.key, value, locale) : label,
        value: null,
        href: null,
      };
    case 'enum_set':
      return {
        label,
        value: Array.isArray(value)
          ? value.map((member) => capabilityValueLabel(capability.key, member, locale)).join(', ')
          : null,
        href: null,
      };
    case 'integer':
      return { label, value: typeof value === 'number' ? String(value) : null, href: null };
    case 'price_level':
      return {
        label,
        value:
          typeof value === 'number'
            ? `${'●'.repeat(value)}${'○'.repeat(Math.max(0, 4 - value))}`
            : null,
        href: null,
      };
    case 'url':
      return typeof value === 'string'
        ? { label, value: readableLink(value), href: value }
        : { label, value: null, href: null };
    case 'text':
      // An opaque reference (a Mercaria location id) is not something to read.
      return {
        label,
        value:
          capabilityGroupOf(capability.key) === 'brand' && typeof value === 'string' ? value : null,
        href: null,
      };
    default:
      return { label, value: null, href: null };
  }
}

/**
 * Presentation for one capability.
 *
 * A stale claim is DEMOTED to `neutral` however it was verified: an Oxy
 * verification from two years ago is evidence about the past, and painting it
 * as a current guarantee is the single failure this whole provenance contract
 * exists to prevent.
 */
export function presentCapability(
  capability: PlaceCapability,
  now: number = Date.now(),
  locale: string = deviceLocale(),
): CapabilityPresentation {
  const provenance = PROVENANCE[capability.verification];
  const age = describeAge(capability.observedAt, now);
  const stale = age?.stale ?? false;
  const group = capabilityGroupOf(capability.key);

  return {
    key: capability.key,
    ...describeValue(capability, locale),
    icon:
      ICON_BY_KEY[capability.key as CapabilityKey] ??
      (group ? ICON_BY_GROUP[group] : RiMapPin2Line),
    provenance: provenance.text,
    freshness: age?.text ?? null,
    stale,
    tone: stale ? 'neutral' : provenance.tone,
  };
}

const TIER_ORDER: Readonly<Record<CapabilityVerification, number>> = {
  oxy_verified: 0,
  business_asserted: 1,
  external_source: 2,
  community_reported: 3,
};

/**
 * The capabilities worth showing on a place: for each key, its STRONGEST
 * assertion, when that assertion holds — strongest and freshest first.
 *
 * One row per key, because the strongest assertion is the answer
 * (`strongestCapability`); the weaker ones are evidence the API still
 * publishes, not facts to render beside it. And a key whose strongest
 * assertion does not hold — `false`, or `wheelchair: no` — is not shown as a
 * negative badge: "does not accept FairCoin" is not a feature, and a row of
 * crossed-out pills is noise on every place that has never been asked.
 */
export function visibleCapabilities(capabilities: readonly PlaceCapability[]): PlaceCapability[] {
  const keys = [...new Set(capabilities.map((capability) => capability.key))];
  return keys
    .map((key) => strongestCapability({ capabilities }, key))
    .filter(
      (capability): capability is PlaceCapability =>
        capability !== undefined && capabilityHolds(capability.key, capability.value),
    )
    .sort((a, b) => {
      const byVerification = TIER_ORDER[a.verification] - TIER_ORDER[b.verification];
      if (byVerification !== 0) return byVerification;
      return Date.parse(b.observedAt) - Date.parse(a.observedAt);
    });
}

/** The visible capabilities that are Oxy-ecosystem facts — what a pin or a row badges. */
export function ecosystemCapabilities(capabilities: readonly PlaceCapability[]): PlaceCapability[] {
  return visibleCapabilities(capabilities).filter((capability) =>
    ECOSYSTEM_KEYS.has(capability.key),
  );
}

/** The heading for keys this build does not know, in every label language. */
const OTHER_GROUP_LABELS: Labels = {
  en: 'Other',
  ar: 'أخرى',
  bn: 'অন্যান্য',
  ca: 'Altres',
  de: 'Sonstiges',
  es: 'Otros',
  fr: 'Autres',
  hi: 'अन्य',
  ja: 'その他',
  'pt-BR': 'Outros',
  ru: 'Другое',
  'zh-Hans': '其他',
};

/**
 * The visible capabilities, grouped as the registry groups them and in its
 * order, each presented. A key this build does not know lands in `other`,
 * labelled by its own key, rather than being dropped.
 */
export function groupedCapabilities(
  capabilities: readonly PlaceCapability[],
  now: number = Date.now(),
  locale: string = deviceLocale(),
): CapabilityGroupPresentation[] {
  const byGroup = new Map<CapabilityGroup | 'other', CapabilityPresentation[]>();
  for (const capability of visibleCapabilities(capabilities)) {
    const group = capabilityGroupOf(capability.key) ?? 'other';
    const items = byGroup.get(group) ?? [];
    items.push(presentCapability(capability, now, locale));
    byGroup.set(group, items);
  }
  return [...CAPABILITY_GROUPS, 'other' as const]
    .filter((group) => byGroup.has(group))
    .map((group) => ({
      group,
      label:
        group === 'other'
          ? localizedLabel(OTHER_GROUP_LABELS, locale)
          : capabilityGroupLabel(group, locale),
      items: byGroup.get(group) ?? [],
    }));
}

/**
 * A single line naming a place's ecosystem capabilities, for a marker's or a
 * row's accessible name.
 *
 * A screen reader gets the capability in words before it gets to the badge, so
 * the badge never has to be the thing carrying the information.
 */
export function capabilitySummary(capabilities: readonly PlaceCapability[]): string | null {
  const visible = ecosystemCapabilities(capabilities);
  if (visible.length === 0) return null;
  return visible.map((capability) => presentCapability(capability).label).join(', ');
}
