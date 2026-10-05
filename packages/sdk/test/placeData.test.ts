import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  CATEGORY_KEYS,
  GoWayValidationError,
  capabilityLabel,
  capabilityValueLabel,
  categoryDescendants,
  categoryLabel,
  createGoWayClient,
  openingStatusAt,
  placeHasCapability,
  placeMatchesCapabilityFilter,
  type CategoryKey,
  type OpeningHours,
  type Place,
  type PlaceCapability,
  type PlaceHoursException,
} from '../src/index';
import { PLACE, page } from './fixtures';
import { fakeFetch, rejection } from './helpers';

/**
 * The richer place data as the SDK carries it: the taxonomy and the capability
 * registry it bundles, typed capability writes it checks before sending, the
 * hours-exception and category calls, and the one "open now" evaluation.
 */

function clientFor(body: unknown, status = 200) {
  const { fetch, calls } = fakeFetch(status, body);
  return { client: createGoWayClient({ fetch, getAccessToken: () => 'token' }), calls };
}

const EXCEPTION: PlaceHoursException = {
  id: 'e1',
  placeId: 'gw_place_01H8',
  startsOn: '2026-10-05',
  endsOn: '2026-10-05',
  closed: true,
  intervals: [],
  source: 'goway',
  verification: 'business_asserted',
  observedAt: '2026-10-01T00:00:00.000Z',
};

describe('the category taxonomy', () => {
  it('labels a key in the languages the bundled taxonomy has, and falls back to English', () => {
    expect(categoryLabel('food.cafe')).toBe('Café');
    expect(categoryLabel('food.cafe', 'es-MX')).toBe('Cafetería');
    expect(categoryLabel('food.cafe', 'ja')).toBe('Café');
    // A key this build does not know is still identifiable.
    expect(categoryLabel('food.space_diner', 'es')).toBe('food.space_diner');
  });

  it('expands a parent to its descendants, and only a known key', () => {
    expect(categoryDescendants('lodging')).toEqual([
      'lodging',
      'lodging.hotel',
      'lodging.hostel',
      'lodging.guest_house',
      'lodging.apartment',
      'lodging.camping',
      'lodging.hut',
    ]);
    expect(categoryDescendants('food_drink')).toEqual([]);
  });

  it('is one tree: every parent exists and every key is unique', () => {
    expect(new Set(CATEGORY_KEYS).size).toBe(CATEGORY_KEYS.length);
    for (const category of CATEGORIES) {
      if (category.parent !== null) expect(CATEGORY_KEYS).toContain(category.parent);
    }
  });

  it('lists the taxonomy from the API and refuses a category it does not know before sending', async () => {
    const { client, calls } = clientFor(page([...CATEGORIES]));
    const listed = await client.categories.list();
    expect(listed.items).toHaveLength(CATEGORIES.length);
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/categories');

    const error = await rejection(
      client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10, categories: ['cafe' as CategoryKey] }),
    );
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(1);
  });
});

describe('typed capabilities', () => {
  it('labels keys and enum values', () => {
    expect(capabilityLabel('accessibility.wheelchair', 'es')).toBe('Acceso en silla de ruedas');
    expect(capabilityValueLabel('food.cuisine', 'italian', 'es')).toBe('Italiana');
  });

  it("refuses a value of the wrong kind for the key, and normalizes one of the right kind, before sending", async () => {
    const { client, calls } = clientFor(PLACE);
    const wrong = await rejection(client.places.capabilities.put('p1', 'amenities.wifi', { value: 'yes' }));
    expect(wrong).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);

    await client.places.capabilities.put('p1', 'social.x', { value: '@goway' });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ value: 'https://x.com/goway' });
  });

  it('holds an Oxy verification to the same registry entry before sending', async () => {
    const { client, calls } = clientFor(PLACE);
    const wrong = await rejection(client.moderation.verifyCapability('p1', 'accessibility.wheelchair', { value: 'sometimes' }));
    expect(wrong).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);

    await client.moderation.verifyCapability('p1', 'food.cuisine', { value: ['pizza', 'italian'] });
    expect(calls[0]?.url).toContain('/moderation/places/p1/capabilities/food.cuisine');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ value: ['italian', 'pizza'] });
  });

  it('filters by a value only where the key has values to filter by', async () => {
    const { client, calls } = clientFor(page([]));
    await client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10, capabilities: ['food.cuisine:italian'] });
    expect(calls[0]?.url).toContain('capabilities=food.cuisine%3Aitalian');

    for (const filter of ['food.cuisine:martian', 'amenities.wifi:yes', 'payments.faircoin.rate']) {
      const error = await rejection(client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10, capabilities: [filter] }));
      expect(error).toBeInstanceOf(GoWayValidationError);
    }
  });

  it('decides "has it" by the strongest assertion, enum absences included', () => {
    const assertion = (value: PlaceCapability['value'], verification: PlaceCapability['verification']): PlaceCapability => ({
      namespace: 'accessibility',
      capability: 'wheelchair',
      key: 'accessibility.wheelchair',
      value,
      verification,
      observedAt: '2026-01-01T00:00:00.000Z',
    });
    const place = { capabilities: [assertion('yes', 'community_reported'), assertion('no', 'business_asserted')] };
    expect(placeHasCapability(place, 'accessibility.wheelchair')).toBe(false);
    expect(placeMatchesCapabilityFilter(place, 'accessibility.wheelchair:no')).toBe(true);
    expect(placeMatchesCapabilityFilter(place, 'accessibility.wheelchair:yes')).toBe(false);
  });
});

describe('hours exceptions', () => {
  it('creates, rewrites, lists and withdraws through the contract', async () => {
    const { client, calls } = clientFor(EXCEPTION, 201);
    const created = await client.places.hoursExceptions.create('gw_place_01H8', { startsOn: '2026-10-05', closed: true });
    expect(created).toEqual(EXCEPTION);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/places/gw_place_01H8/hours-exceptions');

    const refused = await rejection(
      client.places.hoursExceptions.replace('gw_place_01H8', 'e1', {
        startsOn: '2026-10-05',
        closed: true,
        intervals: [{ opens: '10:00', closes: '12:00' }],
      }),
    );
    expect(refused).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(1);
  });
});

describe('openingStatusAt', () => {
  const WEEKDAYS: OpeningHours = {
    intervals: ([1, 2, 3, 4, 5] as const).map((day) => ({ day, opens: '09:00', closes: '20:00' })),
  };
  // Monday 5 October 2026, 12:30 in Madrid (UTC+2).
  const MONDAY_NOON = new Date('2026-10-05T10:30:00Z');

  it('is open, and says when it closes in the place’s own clock', () => {
    expect(openingStatusAt({ openingHours: WEEKDAYS, timezone: 'Europe/Madrid' }, MONDAY_NOON)).toEqual({
      state: 'open',
      localDate: '2026-10-05',
      nextChange: { at: '2026-10-05T18:00:00.000Z', localDate: '2026-10-05', localTime: '20:00' },
    });
  });

  it('is closed after hours, and says when it opens next', () => {
    const status = openingStatusAt({ openingHours: WEEKDAYS, timezone: 'Europe/Madrid' }, new Date('2026-10-09T19:00:00Z'));
    expect(status).toMatchObject({ state: 'closed', nextChange: { localDate: '2026-10-12', localTime: '09:00' } });
  });

  it('reads a night that crosses midnight, and 24/7 as open with no change', () => {
    const bar: OpeningHours = { intervals: [{ day: 5, opens: '22:00', closes: '02:30' }] };
    // Saturday 01:00 in Madrid is still Friday night.
    expect(openingStatusAt({ openingHours: bar, timezone: 'Europe/Madrid' }, new Date('2026-10-09T23:00:00Z'))).toMatchObject({
      state: 'open',
      nextChange: { localTime: '02:30' },
    });
    const always: OpeningHours = { intervals: ([0, 1, 2, 3, 4, 5, 6] as const).map((day) => ({ day, opens: '00:00', closes: '00:00' })) };
    expect(openingStatusAt({ openingHours: always, timezone: 'Europe/Madrid' }, MONDAY_NOON)).toEqual({
      state: 'open',
      localDate: '2026-10-05',
    });
  });

  it('lets an exception decide the day, the strongest tier first', () => {
    const community: PlaceHoursException = {
      ...EXCEPTION,
      id: 'e2',
      closed: false,
      intervals: [{ opens: '10:00', closes: '14:00' }],
      verification: 'community_reported',
      observedAt: '2026-10-04T00:00:00.000Z',
    };
    const status = openingStatusAt(
      { openingHours: WEEKDAYS, timezone: 'Europe/Madrid', hoursExceptions: [community, EXCEPTION] },
      MONDAY_NOON,
    );
    expect(status).toMatchObject({ state: 'closed', exception: { id: 'e1' }, nextChange: { localDate: '2026-10-06' } });
  });

  it('answers unknown without a zone, without a schedule, or for a zone this runtime cannot read', () => {
    expect(openingStatusAt({ openingHours: WEEKDAYS }, MONDAY_NOON)).toEqual({ state: 'unknown' });
    expect(openingStatusAt({ timezone: 'Europe/Madrid' }, MONDAY_NOON)).toEqual({ state: 'unknown' });
    expect(openingStatusAt({ openingHours: WEEKDAYS, timezone: 'Mars/Olympus' }, MONDAY_NOON)).toEqual({ state: 'unknown' });
  });

  it('reads a published place as it comes', async () => {
    const place = { ...(PLACE as unknown as Place), openingHours: WEEKDAYS };
    expect(openingStatusAt(place, MONDAY_NOON).state).toBe('open');
  });
});
