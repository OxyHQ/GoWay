import { describe, expect, it } from 'vitest';
import {
  GoWayValidationError,
  capabilityLabel,
  capabilityValueLabel,
  categoryTaxonomy,
  createGoWayClient,
  openingStatusAt,
  placeHasCapability,
  placeMatchesCapabilityFilter,
  type Category,
  type ModerationCategory,
  type OpeningHours,
  type Place,
  type PlaceCapability,
  type PlaceHoursException,
} from '../src/index';
import { PLACE, page } from './fixtures';
import { fakeFetch, rejection } from './helpers';

/**
 * The richer place data as the SDK carries it: the category taxonomy it READS
 * from the API (it bundles none — GoWay's moderators edit it without a
 * release), the capability registry it bundles, typed capability writes it
 * checks before sending, the hours-exception and category calls, and the one
 * "open now" evaluation.
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

/**
 * A few categories as `GET /categories` publishes them — a fixture, not the
 * taxonomy, which lives in GoWay's database. Depth-first, siblings in order.
 */
const CATEGORY_LIST: Category[] = [
  {
    key: 'food',
    parent: null,
    icon: 'restaurant',
    status: 'active',
    label: 'Food & drink',
    labels: { en: 'Food & drink', es: 'Comida y bebida' },
  },
  {
    key: 'food.cafe',
    parent: 'food',
    icon: 'cafe',
    status: 'active',
    label: 'Café',
    labels: { en: 'Café', es: 'Cafetería', 'pt-BR': 'Cafeteria' },
  },
  {
    key: 'food.bakery',
    parent: 'food',
    icon: 'bakery',
    status: 'deprecated',
    label: 'Bakery',
    labels: { en: 'Bakery', es: 'Panadería' },
  },
  {
    key: 'lodging',
    parent: null,
    icon: 'hotel',
    status: 'active',
    label: 'Stay',
    labels: { en: 'Stay' },
  },
];

const MODERATION_CATEGORY: ModerationCategory = {
  ...CATEGORY_LIST[1]!,
  position: 10,
  osmTags: ['amenity=cafe', 'shop=coffee'],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('the category taxonomy', () => {
  const taxonomy = categoryTaxonomy(CATEGORY_LIST);

  it('labels a key in any language the list holds, and falls back to English', () => {
    expect(taxonomy.label('food.cafe')).toBe('Café');
    expect(taxonomy.label('food.cafe', 'es-MX')).toBe('Cafetería');
    expect(taxonomy.label('food.cafe', 'ja')).toBe('Café');
    // `pt` is not held, only `pt-BR`: the bare language falls back to English.
    expect(taxonomy.label('lodging', 'pt')).toBe('Stay');
    // A key the list does not hold is still identifiable.
    expect(taxonomy.label('food.space_diner', 'es')).toBe('food.space_diner');
  });

  it('looks a key up, and expands a parent to its descendants in list order', () => {
    expect(taxonomy.of('food.bakery')?.status).toBe('deprecated');
    expect(taxonomy.of('food_drink')).toBeUndefined();
    expect(taxonomy.descendants('food')).toEqual(['food', 'food.cafe', 'food.bakery']);
    expect(taxonomy.descendants('lodging')).toEqual(['lodging']);
    expect(taxonomy.descendants('food_drink')).toEqual([]);
  });

  it('lists the taxonomy from the API, labelled for a normalized locale', async () => {
    const { client, calls } = clientFor(page(CATEGORY_LIST));
    const listed = await client.categories.list({ locale: 'ES' });
    expect(listed.items).toHaveLength(CATEGORY_LIST.length);
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/categories?locale=es');
  });

  it('reads a category GoWay added after this build — a new key, a new glyph — rather than failing', async () => {
    const added: Category = {
      key: 'food.space_diner',
      parent: 'food',
      icon: 'rocket',
      status: 'active',
      label: 'Space diner',
      labels: { en: 'Space diner', 'zh-Hans': '太空餐厅' },
    };
    const { client } = clientFor(page([...CATEGORY_LIST, added]));
    const listed = await client.categories.list();
    expect(listed.items.at(-1)).toEqual(added);
  });

  it('refuses a malformed category key before sending, and leaves membership to the server', async () => {
    const { client, calls } = clientFor(page([]));
    const error = await rejection(
      client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10, categories: ['Food Cafe'] }),
    );
    expect(error).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);

    // Well-formed but unknown to this build: only the server knows the taxonomy.
    await client.places.nearby({ latitude: 0, longitude: 0, radiusMeters: 10, categories: ['food.space_diner'] });
    expect(calls).toHaveLength(1);
  });
});

describe('category moderation', () => {
  it('lists every category with its mapping', async () => {
    const { client, calls } = clientFor(page([MODERATION_CATEGORY]));
    const listed = await client.moderation.categories({ locale: 'es' });
    expect(listed.items[0]?.osmTags).toEqual(['amenity=cafe', 'shop=coffee']);
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/moderation/categories?locale=es');
  });

  it('creates a category with normalized label tags, and requires English', async () => {
    const { client, calls } = clientFor(MODERATION_CATEGORY, 201);
    await client.moderation.createCategory({
      key: 'food.cafe',
      icon: 'cafe',
      osmTags: ['amenity=cafe', 'amenity=cafe'],
      labels: { en: 'Café', ES: 'Cafetería', pt_br: 'Cafeteria' },
    });
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      key: 'food.cafe',
      icon: 'cafe',
      osmTags: ['amenity=cafe'],
      labels: { en: 'Café', es: 'Cafetería', 'pt-BR': 'Cafeteria' },
    });

    const noEnglish = await rejection(
      client.moderation.createCategory({
        key: 'food.tea',
        icon: 'cafe',
        labels: { es: 'Té' } as unknown as { en: string },
      }),
    );
    expect(noEnglish).toBeInstanceOf(GoWayValidationError);

    const twice = await rejection(
      client.moderation.createCategory({ key: 'food.tea', icon: 'cafe', labels: { en: 'Tea', es: 'Té', ES: 'Té' } }),
    );
    expect(twice).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(1);
  });

  it('refuses an empty patch before sending, and sends a deprecation', async () => {
    const { client, calls } = clientFor(MODERATION_CATEGORY);
    const empty = await rejection(client.moderation.updateCategory('food.cafe', {}));
    expect(empty).toBeInstanceOf(GoWayValidationError);
    expect(calls).toHaveLength(0);

    await client.moderation.updateCategory('food.cafe', { status: 'deprecated' });
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/moderation/categories/food.cafe');
  });

  it('addresses a label by its canonical language tag', async () => {
    const { client, calls } = clientFor(MODERATION_CATEGORY);
    await client.moderation.setCategoryLabel('food.cafe', 'pt_br', { label: 'Cafeteria' });
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://api.goway.to/api/v1/moderation/categories/food.cafe/labels/pt-BR');

    const removed = clientFor('', 204);
    await removed.client.moderation.removeCategoryLabel('food.cafe', 'pt_br');
    expect(removed.calls[0]?.init.method).toBe('DELETE');
    expect(removed.calls[0]?.url).toBe('https://api.goway.to/api/v1/moderation/categories/food.cafe/labels/pt-BR');
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
