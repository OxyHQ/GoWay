/**
 * How a place's reviews and gallery read on screen — pure, so the wording is
 * tested without a renderer.
 *
 * Nothing here computes a rating: `Place.rating` is derived by GoWay from the
 * published reviews, and a client that averaged the page it holds would show a
 * different number from the one every other client shows.
 */
import type { PlaceMedia, PlaceRating, PlaceReview, ReviewSort } from '@goway.to/sdk';
import type { User } from '@oxy.so/core';

const DAY_MS = 86_400_000;

/** The orders the review list offers, with their words. */
export const REVIEW_SORT_LABELS: Readonly<Record<ReviewSort, string>> = {
  newest: 'Newest',
  highest: 'Highest',
  lowest: 'Lowest',
};

/**
 * The name a reviewer is shown under: their Oxy display name, else their
 * handle. A review whose author Oxy did not resolve — deleted, or a fixture —
 * is still a review, by somebody.
 */
export function reviewerName(user: User | undefined): string {
  const display = user?.name?.displayName?.trim();
  if (display) return display;
  if (user?.username) return `@${user.username}`;
  return 'A GoWay user';
}

/** When a review was written, coarsely: a review's exact minute is nobody's business. */
export function reviewAge(writtenAt: string, now: number = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(writtenAt)) / DAY_MS));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** "4.3 · 12 reviews" — the summary's words, for the reader and for a screen reader. */
export function ratingSummary(rating: PlaceRating): string {
  return `${rating.average.toFixed(1)} · ${rating.count} review${rating.count === 1 ? '' : 's'}`;
}

/** What a review says, as one spoken sentence. */
export function spokenReview(review: PlaceReview, author: string): string {
  return [`${author} rated it ${review.rating} out of 5`, review.title, review.body]
    .filter(Boolean)
    .join('. ');
}

/**
 * The gallery items a photo strip shows: everything but the logo, which the
 * place's header draws on its own.
 */
export function stripItems(items: readonly PlaceMedia[]): PlaceMedia[] {
  return items.filter((item) => item.kind !== 'logo');
}

/**
 * The credit an imported image must carry beside it, or `null` for a
 * contributed one. A licence that requires attribution is honoured where the
 * image is shown, not in a page nobody opens.
 */
export function mediaCredit(item: PlaceMedia): string | null {
  const parts = [item.attribution, item.license].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : null;
}
