/**
 * How reviews and gallery items read on screen.
 */
import { describe, expect, test } from 'bun:test';
import type { PlaceMedia, PlaceReview } from '@goway.to/sdk';
import type { User } from '@oxy.so/core';

import {
  mediaCredit,
  ratingSummary,
  reviewAge,
  reviewerName,
  spokenReview,
  stripItems,
} from '@/lib/goway/reviews';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const DAY = 86_400_000;

function media(overrides: Partial<PlaceMedia>): PlaceMedia {
  return {
    id: 'm',
    placeId: 'p',
    fileId: 'f',
    kind: 'photo',
    verification: 'community_reported',
    position: 0,
    createdAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

describe('reviewerName', () => {
  test('is the Oxy display name, else the handle, else somebody', () => {
    expect(
      reviewerName({ username: 'ana', name: { displayName: ' Ana Puig ' } } as unknown as User),
    ).toBe('Ana Puig');
    expect(reviewerName({ username: 'ana', name: {} } as unknown as User)).toBe('@ana');
    expect(reviewerName(undefined)).toBe('A GoWay user');
  });
});

describe('reviewAge', () => {
  test('is coarse on purpose', () => {
    expect(reviewAge(new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toBe('Today');
    expect(reviewAge(new Date(NOW - DAY).toISOString(), NOW)).toBe('Yesterday');
    expect(reviewAge(new Date(NOW - 12 * DAY).toISOString(), NOW)).toBe('12 days ago');
    expect(reviewAge(new Date(NOW - 40 * DAY).toISOString(), NOW)).toBe('1 month ago');
    expect(reviewAge(new Date(NOW - 800 * DAY).toISOString(), NOW)).toBe('2 years ago');
  });
});

describe('the summary', () => {
  test('reads the rating GoWay derived, never one computed here', () => {
    expect(ratingSummary({ average: 4, count: 1 })).toBe('4.0 · 1 review');
    expect(ratingSummary({ average: 4.3, count: 12 })).toBe('4.3 · 12 reviews');
  });

  test('speaks a review as one sentence', () => {
    const review = { rating: 5, title: 'Unmissable', body: 'Go early.' } as PlaceReview;
    expect(spokenReview(review, 'Ana')).toBe('Ana rated it 5 out of 5. Unmissable. Go early.');
  });
});

describe('the strip', () => {
  test('leaves the logo to the header', () => {
    expect(
      stripItems([media({ id: 'a', kind: 'logo' }), media({ id: 'b' })]).map((item) => item.id),
    ).toEqual(['b']);
  });

  test("credits an imported image, and not a contributor's own", () => {
    expect(
      mediaCredit(media({ attribution: 'Wikimedia Commons contributor', license: 'CC BY-SA 4.0' })),
    ).toBe('Wikimedia Commons contributor · CC BY-SA 4.0');
    expect(mediaCredit(media({}))).toBeNull();
  });
});
