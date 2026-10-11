import { describe, expect, it } from 'vitest';
import {
  GoWayResponseError,
  GoWayValidationError,
  createGoWayClient,
  type PlaceMedia,
  type PlaceReview,
} from '../src/index';
import { PLACE, page } from './fixtures';
import { fakeFetch, queryOf, rejection } from './helpers';

/**
 * A place's gallery, reviews and profile as the SDK carries them: the calls,
 * the inputs it checks before sending, and the responses it parses.
 */

function clientFor(body: unknown, status = 200) {
  const { fetch, calls } = fakeFetch(status, body);
  return { client: createGoWayClient({ fetch, getAccessToken: () => 'token' }), calls };
}

const MEDIA: PlaceMedia = {
  id: 'm1',
  placeId: 'gw_place_01H8',
  fileId: 'oxy-file-1',
  kind: 'photo',
  verification: 'community_reported',
  position: 0,
  width: 1600,
  height: 1200,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const REVIEW: PlaceReview = {
  id: 'v1',
  placeId: 'gw_place_01H8',
  rating: 4,
  body: 'Croissants de primera.',
  locale: 'ca',
  authorOxyUserId: 'oxy-user-1',
  createdAt: '2026-10-01T00:00:00.000Z',
  reply: { body: 'Gràcies!', repliedAt: '2026-10-02T00:00:00.000Z' },
};

describe('the gallery', () => {
  it('lists it with the kinds as one sorted parameter', async () => {
    const { client, calls } = clientFor(page([MEDIA]));
    const listed = await client.places.media.list('gw_place_01H8', { kinds: ['photo', 'menu'] });
    expect(listed.items[0]?.fileId).toBe('oxy-file-1');
    expect(calls[0]?.url.split('?')[0]).toBe(
      'https://api.goway.to/api/v1/places/gw_place_01H8/media',
    );
    expect(new URLSearchParams(queryOf(calls[0]!.url)).get('kinds')).toBe('menu,photo');
  });

  it('adds an Oxy file id, and nothing the caller may not choose', async () => {
    const { client, calls } = clientFor(MEDIA, 201);
    await client.places.media.add('gw_place_01H8', {
      fileId: 'oxy-file-1',
      kind: 'photo',
      caption: '  La plaça  ',
    });
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      fileId: 'oxy-file-1',
      kind: 'photo',
      caption: 'La plaça',
    });
  });

  it('refuses a kind outside the closed set before sending', async () => {
    const { client, calls } = clientFor(MEDIA, 201);
    const error = await rejection(
      client.places.media.add('gw_place_01H8', {
        fileId: 'f',
        kind: 'selfie' as unknown as 'photo',
      }),
    );
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a reorder naming one item twice before sending', async () => {
    const { client, calls } = clientFor(null, 204);
    const error = await rejection(
      client.places.media.reorder('gw_place_01H8', { mediaIds: ['m1', 'm1'] }),
    );
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe('reviews', () => {
  it('lists them in the order asked for, with the reply and never who wrote it', async () => {
    const { client, calls } = clientFor(page([REVIEW]));
    const listed = await client.places.reviews.list('gw_place_01H8', { sort: 'highest' });
    expect(listed.items[0]?.reply?.body).toBe('Gràcies!');
    expect(new URLSearchParams(queryOf(calls[0]!.url)).get('sort')).toBe('highest');
  });

  it('writes your review with PUT on mine, normalizing the locale', async () => {
    const { client, calls } = clientFor({ ...REVIEW, status: 'published' }, 201);
    const written = await client.places.reviews.put('gw_place_01H8', { rating: 4, locale: 'CA' });
    expect(written.status).toBe('published');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/places/gw_place_01H8/reviews/mine');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ rating: 4, locale: 'ca' });
  });

  it('refuses a rating outside 1–5 before sending', async () => {
    const { client, calls } = clientFor(REVIEW);
    for (const rating of [0, 6, 4.5]) {
      expect(
        await rejection(client.places.reviews.put('gw_place_01H8', { rating })),
      ).toBeInstanceOf(GoWayValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it('replies on the review, and refuses a reply with a status it never has', async () => {
    const { client, calls } = clientFor(REVIEW);
    await client.places.reviews.reply('gw_place_01H8', 'v1', { body: 'Gràcies!' });
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/places/gw_place_01H8/reviews/v1/reply');

    const bad = clientFor({ ...REVIEW, rating: 9 });
    expect(
      await rejection(bad.client.places.reviews.reply('gw_place_01H8', 'v1', { body: 'x' })),
    ).toBeInstanceOf(GoWayResponseError);
  });

  it('reports a review with a content reason only', async () => {
    const { client, calls } = clientFor(
      {
        id: 'r1',
        placeId: 'gw_place_01H8',
        reviewId: 'v1',
        reason: 'spam',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      201,
    );
    const report = await client.places.reviews.report('gw_place_01H8', 'v1', { reason: 'spam' });
    expect(report.reviewId).toBe('v1');
    const error = await rejection(
      client.places.reviews.report('gw_place_01H8', 'v1', {
        reason: 'wrong_location' as unknown as 'spam',
      }),
    );
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(1);
  });
});

describe('the place profile', () => {
  it('reads a description, a logo, a cover and a rating', async () => {
    const { client } = clientFor({
      ...PLACE,
      description: 'La casa de sempre.',
      descriptions: [{ language: 'es', description: 'La casa de siempre.', source: 'goway' }],
      localizedDescription: { language: 'es', description: 'La casa de siempre.', source: 'goway' },
      logoFileId: 'oxy-logo',
      coverFileId: 'oxy-cover',
      rating: { average: 4.3, count: 12 },
    });
    const place = await client.places.get('gw_place_01H8');
    expect(place.rating).toEqual({ average: 4.3, count: 12 });
    expect(place.logoFileId).toBe('oxy-logo');
    expect(place.localizedDescription?.description).toBe('La casa de siempre.');
  });

  it('sets a logo by its Oxy file and withdraws a description with null', async () => {
    const { client, calls } = clientFor(PLACE);
    await client.places.update('gw_place_01H8', {
      logoFileId: 'oxy-logo',
      descriptions: [{ language: 'EN', description: null }],
    });
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      logoFileId: 'oxy-logo',
      descriptions: [{ language: 'en', description: null }],
    });
  });
});
