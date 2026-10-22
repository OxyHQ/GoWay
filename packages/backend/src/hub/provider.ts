/**
 * What every GoWay Data Hub provider is, whatever it carries (aircraft,
 * transit, cameras).
 *
 * A provider is DATA: who runs the feed, under what licence, how often it may
 * be asked, when its data goes stale. A channel (`live/`, `cameras/`) extends
 * {@link HubProviderDefinition} with what is particular to its kind and adds
 * the adapter that speaks the upstream's format. Nothing here knows a format.
 *
 * ## Licence first
 *
 * GoWay re-serves only what its licence allows it to re-serve publicly and
 * commercially (AGENTS.md). `licenceCheck` records HOW that was established —
 * the day, the page, the words — and {@link licenceProblems} refuses a
 * provider that cannot say. A channel's own `licence.test.ts` runs it over
 * every provider it lists.
 */

/** A credit or licence the client shows and links. */
export interface HubLink {
  label: string;
  href: string;
}

/** The licence as READ, not assumed. */
export interface HubLicenceCheck {
  /** `YYYY-MM-DD`, the day it was read. */
  verifiedOn: string;
  /** The words that allow public, commercial redistribution. */
  quote: string;
  /** The https page they are on. */
  source: string;
}

export interface HubProviderDefinition {
  /** Stable, unique within its channel. */
  id: string;
  name: string;
  /** The credit the licence asks for; shown whenever this provider's data is drawn. */
  attribution: HubLink;
  licence: HubLink;
  licenceCheck: HubLicenceCheck;
  /** The public endpoint; configuration may override it per deployment. */
  defaultUrl: string;
  /** Needs a key from configuration; off without one. */
  requiresKey: boolean;
  /** Where the owner registers for that key (required when `requiresKey`). */
  keyRegistrationUrl?: string;
  /** Never asked more often than this. */
  pollIntervalSeconds: number;
  /** Older than this the data is shown as stale. */
  staleAfterSeconds: number;
  /** Older than this the data is dropped. */
  dropAfterSeconds: number;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isHttps = (value: string | undefined): boolean => /^https:\/\/\S+$/.test(value ?? '');

/** Why a provider may not be served; empty when it may. */
export function licenceProblems(
  provider: HubProviderDefinition,
  now: number = Date.now(),
): string[] {
  const problems: string[] = [];
  const check = provider.licenceCheck as HubLicenceCheck | undefined;
  if (!check || !ISO_DAY.test(check.verifiedOn)) problems.push('licenceCheck.verifiedOn');
  else if (Date.parse(check.verifiedOn) > now)
    problems.push('licenceCheck.verifiedOn is in the future');
  if (!check || check.quote.trim().length < 10) problems.push('licenceCheck.quote');
  if (!check || !isHttps(check.source)) problems.push('licenceCheck.source');
  if (!isHttps(provider.licence.href)) problems.push('licence.href');
  if (provider.licence.label.trim().length === 0) problems.push('licence.label');
  if (provider.attribution.label.trim().length === 0) problems.push('attribution.label');
  if (provider.requiresKey && !isHttps(provider.keyRegistrationUrl))
    problems.push('keyRegistrationUrl');
  if (provider.staleAfterSeconds >= provider.dropAfterSeconds)
    problems.push('stale must precede drop');
  return problems;
}

/** Ids that appear more than once, for a channel's own uniqueness test. */
export function duplicateIds(providers: readonly { id: string }[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { id } of providers) (seen.has(id) ? repeated : seen).add(id);
  return [...repeated];
}
