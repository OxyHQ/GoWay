/**
 * Rendering helpers for place data — address lines, distances, marker labels.
 *
 * Every function here returns `null` for "there is nothing to say", so a caller
 * can `{line ? <Text/> : null}` instead of rendering an empty row. That is the
 * mechanical form of issue #7's "avoid showing fields that are absent merely to
 * imitate Google Maps density".
 */
import { placeDisplayName } from '@goway.to/sdk';
import type { Place, StructuredAddress } from '@goway.to/sdk';

import { resolveCategory } from './categories';

/**
 * The address as one line.
 *
 * `formatted` is the SOURCE's own rendering and wins whenever it exists —
 * re-assembling parts we were handed pre-assembled is how an address ends up
 * in the wrong order for its country.
 */
export function formatAddress(address: StructuredAddress | undefined): string | null {
  if (!address) return null;
  if (address.formatted?.trim()) return address.formatted.trim();

  const street = [address.street, address.houseNumber].filter(Boolean).join(' ').trim();
  const parts = [street || null, address.locality ?? null, address.city ?? null, address.postalCode ?? null]
    .filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The short, secondary line under a place name: category, then locality. */
export function formatPlaceSubtitle(place: Place): string | null {
  const category = resolveCategory(place.categories).label;
  const where = place.address?.locality ?? place.address?.city ?? null;
  const parts = [category, where].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A ground distance in the coarsest unit that is still honest. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

/** A duration, for an ETA. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** The longest label a marker pill may carry before it stops being a marker. */
const MARKER_LABEL_MAX = 18;

/**
 * The text drawn inside a place's marker.
 *
 * Bloom's `MapPriceMarker` "never truncates" — the app is responsible for
 * handing it something short — so the elision happens here rather than as a
 * pill stretched across half the city.
 */
export function markerLabel(place: Place): string {
  // The RESOLVED name, not `place.name`. This pill and the sheet it opens must
  // read the same, and the sheet uses the same helper.
  const name = placeDisplayName(place).trim();
  if (name.length <= MARKER_LABEL_MAX) return name;
  return `${name.slice(0, MARKER_LABEL_MAX - 1).trimEnd()}…`;
}

/** A website's host, which is what a user recognises; the scheme is noise. */
export function formatWebsite(website: string | undefined): string | null {
  if (!website) return null;
  const trimmed = website.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = withoutScheme.split('/')[0] ?? withoutScheme;
  return host.replace(/^www\./i, '') || null;
}

/** An absolute URL for a website a source may have stored scheme-less. */
export function websiteUrl(website: string | undefined): string | null {
  if (!website) return null;
  const trimmed = website.trim();
  if (!trimmed) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
