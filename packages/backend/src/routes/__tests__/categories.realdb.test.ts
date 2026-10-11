/**
 * The taxonomy as data, end to end: a moderator edits it over HTTP and every
 * reader — `GET /categories`, the place filters, place writes and the
 * OpenStreetMap import — sees the edit through the process's catalog.
 *
 * What each part proves:
 *
 *  - moderation: who may write, what a write refuses, and that every write
 *    leaves one `place_category_events` row;
 *  - the catalog: a write here is read back at once; a change made by ANOTHER
 *    process is not, until the catalog expires — and the database still
 *    refuses what a stale catalog lets through, as the same 422;
 *  - filters expand a parent through the database's tree, new children
 *    included, and a deprecated key still finds the places carrying it;
 *  - the import files elements through the database's mapping, never a
 *    deprecated category's.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type {
  CategoryPage,
  ModerationCategory,
  ModerationCategoryPage,
  Place,
  PlaceWithDistancePage,
} from '@goway/contracts';
import {
  catalogOf,
  categoryCatalog,
  categoryCatalogs,
  createCategoryCatalogCache,
} from '../../categories/catalog';
import { loadCategories } from '../../db/categories/categoryRepository';
import { placeCategories, placeCategoryEvents, placeCategoryLabels } from '../../db/schema';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { osmCategories } from '../../import/osm/poiTags';
import { toImportedPlace } from '../../import/osm/placeRecord';
import { emptyWriteStats, writePlaceBatch } from '../../import/osm/writePlaces';
import { createRequireOperator } from '../../middleware/operator';
import {
  fakeOptionalAuth,
  fakeRequireAuth,
  serve,
  session,
  type ErrorBody,
  type TestApi,
} from '../../__tests__/httpHarness';
import { NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createCategoriesRouter } from '../categories';
import { createModerationRouter } from '../moderation';
import { createPlacesRouter } from '../places';

const OPERATOR = session('person-mod');
const CONTRIBUTOR = session('person-contributor');
const LAVAPIES = { latitude: 40.4086, longitude: -3.7016 };
const NEAR_LAVAPIES = `latitude=${LAVAPIES.latitude}&longitude=${LAVAPIES.longitude}&radiusMeters=2000`;

let suite: SuiteDatabase | null = null;
let api: TestApi;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(
    createCategoriesRouter(),
    createPlacesRouter({
      optionalAuth: fakeOptionalAuth,
      requireAuth: fakeRequireAuth,
      accountRoles: NO_MEMBERSHIPS,
      reportRateLimit: NO_RATE_LIMIT,
    }),
    createModerationRouter({
      requireAuth: fakeRequireAuth,
      requireOperator: createRequireOperator(['person-mod']),
    }),
  );
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

async function publicCategory(key: string, locale?: string) {
  const { body } = await api.call<CategoryPage>(
    'GET',
    `/categories${locale ? `?locale=${locale}` : ''}`,
  );
  return body.items.find((category) => category.key === key);
}

async function events(key: string) {
  return suite!.db
    .select({
      action: placeCategoryEvents.action,
      changes: placeCategoryEvents.changes,
      by: placeCategoryEvents.operatedByOxyUserId,
    })
    .from(placeCategoryEvents)
    .where(eq(placeCategoryEvents.categoryKey, key))
    .orderBy(placeCategoryEvents.createdAt, placeCategoryEvents.id);
}

async function createPlace(
  categories: string[],
  name = 'Sitio de prueba',
): Promise<{ status: number; body: Place & ErrorBody }> {
  return api.call('POST', '/places', CONTRIBUTOR, { name, location: LAVAPIES, categories });
}

describe('moderation', () => {
  it('lists every category with its position and mapping, for an operator only', async () => {
    expect((await api.call<ErrorBody>('GET', '/moderation/categories', CONTRIBUTOR)).status).toBe(
      403,
    );
    const { status, body } = await api.call<ModerationCategoryPage>(
      'GET',
      '/moderation/categories?locale=es',
      OPERATOR,
    );
    expect(status).toBe(200);
    expect(body.items.find((category) => category.key === 'food.cafe')).toMatchObject({
      label: 'Cafetería',
      position: 20,
      osmTags: ['amenity=cafe', 'shop=coffee', 'shop=tea'],
    });
  });

  it('refuses a write from anybody off the operator list', async () => {
    const input = { key: 'shop.kites', icon: 'shop', labels: { en: 'Kites' } };
    expect((await api.call<ErrorBody>('POST', '/moderation/categories', {}, input)).status).toBe(
      401,
    );
    expect(
      (await api.call<ErrorBody>('POST', '/moderation/categories', CONTRIBUTOR, input)).status,
    ).toBe(403);
    expect(
      (
        await api.call<ErrorBody>('PATCH', '/moderation/categories/food.cafe', CONTRIBUTOR, {
          icon: 'bar',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.call<ErrorBody>(
          'PUT',
          '/moderation/categories/food.cafe/labels/it',
          CONTRIBUTOR,
          { label: 'Caffè' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api.call<ErrorBody>(
          'DELETE',
          '/moderation/categories/food.cafe/labels/es',
          CONTRIBUTOR,
        )
      ).status,
    ).toBe(403);
  });

  it('creates a category after its last sibling, records it, and serves it at once', async () => {
    const { status, body } = await api.call<ModerationCategory>(
      'POST',
      '/moderation/categories',
      OPERATOR,
      {
        key: 'food.churreria',
        icon: 'cafe',
        osmTags: ['shop=churros', 'shop=churros'],
        labels: { en: 'Churros', ES: 'Churrería', pt_br: 'Churraria' },
      },
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({
      key: 'food.churreria',
      parent: 'food',
      status: 'active',
      position: 90,
      osmTags: ['shop=churros'],
      labels: { en: 'Churros', es: 'Churrería', 'pt-BR': 'Churraria' },
    });
    // The catalog this process holds was dropped by the write.
    expect(await publicCategory('food.churreria', 'pt-PT')).toMatchObject({ label: 'Churraria' });
    const [created] = await events('food.churreria');
    expect(created).toMatchObject({ action: 'created', by: 'person-mod' });
    expect(created?.changes).toContainEqual({ field: 'labels.es', after: 'Churrería' });
  });

  it('refuses a taken key, a missing or deprecated parent, a taken tag and a tag the import never reads', async () => {
    const create = (input: Record<string, unknown>) =>
      api.call<ErrorBody>('POST', '/moderation/categories', OPERATOR, {
        icon: 'shop',
        labels: { en: 'X' },
        ...input,
      });
    expect((await create({ key: 'food.cafe' })).body.error.code).toBe('conflict');
    const orphan = await create({ key: 'kites.box' });
    expect([orphan.status, orphan.body.error.details?.field]).toEqual([422, 'key']);
    const tag = await create({ key: 'shop.coffee', osmTags: ['shop=coffee'] });
    expect([tag.body.error.code, tag.body.error.details?.category]).toEqual([
      'conflict',
      'food.cafe',
    ]);
    const unread = await create({ key: 'shop.pizza', osmTags: ['cuisine=pizza'] });
    expect([unread.status, unread.body.error.details?.field]).toEqual([422, 'osmTags.0']);
    expect((await create({ key: 'shop.nolabel', labels: { es: 'Sin inglés' } })).status).toBe(400);
  });

  it('changes a glyph and a mapping, sets and removes labels, and never removes English', async () => {
    const patched = await api.call<ModerationCategory>(
      'PATCH',
      '/moderation/categories/food.churreria',
      OPERATOR,
      {
        icon: 'bakery',
        osmTags: ['shop=churros', 'shop=porras'],
      },
    );
    expect(patched.body).toMatchObject({
      icon: 'bakery',
      osmTags: ['shop=churros', 'shop=porras'],
    });

    const labelled = await api.call<ModerationCategory>(
      'PUT',
      '/moderation/categories/food.churreria/labels/ca',
      OPERATOR,
      {
        label: ' Xurreria ',
      },
    );
    expect(labelled.body.labels.ca).toBe('Xurreria');
    expect(await publicCategory('food.churreria', 'ca-ES')).toMatchObject({ label: 'Xurreria' });

    expect(
      (await api.call('DELETE', '/moderation/categories/food.churreria/labels/ca', OPERATOR))
        .status,
    ).toBe(204);
    expect(
      (
        await api.call<ErrorBody>(
          'DELETE',
          '/moderation/categories/food.churreria/labels/ca',
          OPERATOR,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api.call<ErrorBody>(
          'DELETE',
          '/moderation/categories/food.churreria/labels/en',
          OPERATOR,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api.call<ErrorBody>('PATCH', '/moderation/categories/food.unknown', OPERATOR, {
          icon: 'bar',
        })
      ).status,
    ).toBe(404);

    expect((await events('food.churreria')).map((event) => event.action)).toEqual([
      'created',
      'updated',
      'label_set',
      'label_removed',
    ]);
  });

  it('deprecates a category only once nothing active is below it, and reactivates one only under an active parent', async () => {
    await api.call('POST', '/moderation/categories', OPERATOR, {
      key: 'food.churreria.madrid',
      icon: 'cafe',
      labels: { en: 'Madrid churros' },
    });
    expect(
      (
        await api.call<ErrorBody>('PATCH', '/moderation/categories/food.churreria', OPERATOR, {
          status: 'deprecated',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api.call('PATCH', '/moderation/categories/food.churreria.madrid', OPERATOR, {
          status: 'deprecated',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.call('PATCH', '/moderation/categories/food.churreria', OPERATOR, {
          status: 'deprecated',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.call<ErrorBody>(
          'PATCH',
          '/moderation/categories/food.churreria.madrid',
          OPERATOR,
          { status: 'active' },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api.call<ErrorBody>('POST', '/moderation/categories', OPERATOR, {
          key: 'food.churreria.sevilla',
          icon: 'cafe',
          labels: { en: 'S' },
        })
      ).status,
    ).toBe(409);
    // Back to active for the suites below.
    expect(
      (
        await api.call('PATCH', '/moderation/categories/food.churreria', OPERATOR, {
          status: 'active',
        })
      ).status,
    ).toBe(200);
  });
});

describe('places and categories', () => {
  it('expands a filter through the database tree, new categories included', async () => {
    const made = await createPlace(['food.churreria'], 'Chocolatería San Ginés');
    expect(made.status).toBe(201);
    const { body } = await api.call<PlaceWithDistancePage>(
      'GET',
      `/places/nearby?${NEAR_LAVAPIES}&categories=food`,
    );
    expect(body.items.map((place) => place.id)).toContain(made.body.id);
    const unknown = await api.call<ErrorBody>(
      'GET',
      `/places/nearby?${NEAR_LAVAPIES}&categories=food,food.space_diner`,
    );
    expect([unknown.status, unknown.body.error.details?.field]).toEqual([422, 'categories.1']);
  });

  it('refuses a deprecated key on a new place, keeps it on a place that carries it, and still filters by it', async () => {
    const carrier = await createPlace(['food.churreria'], 'Churrería Vieja');
    await api.call('PATCH', '/moderation/categories/food.churreria', OPERATOR, {
      status: 'deprecated',
    });

    const refused = await createPlace(['food.churreria']);
    expect([
      refused.status,
      refused.body.error.details?.field,
      refused.body.error.details?.issue,
    ]).toEqual([422, 'categories.0', 'deprecated_category']);
    const kept = await api.call<Place>('PATCH', `/places/${carrier.body.id}`, CONTRIBUTOR, {
      categories: ['food.churreria', 'food.cafe'],
    });
    expect([kept.status, kept.body.categories]).toEqual([200, ['food.churreria', 'food.cafe']]);

    const { body } = await api.call<PlaceWithDistancePage>(
      'GET',
      `/places/nearby?${NEAR_LAVAPIES}&categories=food.churreria`,
    );
    expect(body.items.map((place) => place.id)).toContain(carrier.body.id);
    await api.call('PATCH', '/moderation/categories/food.churreria', OPERATOR, {
      status: 'active',
    });
  });

  it('answers a write a stale catalog let through with the database’s refusal, as the same 422', async () => {
    // Prime this process's catalog, then deprecate the way ANOTHER process
    // would: in the database, without touching this one's catalog.
    await categoryCatalog(suite!.db);
    await suite!.db
      .update(placeCategories)
      .set({ status: 'deprecated' })
      .where(eq(placeCategories.key, 'food.ice_cream'));

    const stale = await createPlace(['food.ice_cream']);
    expect([stale.status, stale.body.error.code, stale.body.error.details?.issue]).toEqual([
      422,
      'validation_failed',
      'inactive_category',
    ]);
    categoryCatalogs.invalidate(suite!.db);
    expect((await createPlace(['food.ice_cream'])).body.error.details?.issue).toBe(
      'deprecated_category',
    );
    await suite!.db
      .update(placeCategories)
      .set({ status: 'active' })
      .where(eq(placeCategories.key, 'food.ice_cream'));
    categoryCatalogs.invalidate(suite!.db);
  });
});

describe('the catalog', () => {
  it('serves its copy until it expires, then reads the database again', async () => {
    let now = 0;
    const cache = createCategoryCatalogCache({ ttlMs: 1_000, now: () => now });
    const label = async () => (await cache.get(suite!.db)).taxonomy.label('finance.atm');

    expect(await label()).toBe('Cash machine');
    // Another process's moderator, as far as this cache can tell.
    await suite!.db
      .update(placeCategoryLabels)
      .set({ label: 'ATM' })
      .where(
        and(
          eq(placeCategoryLabels.categoryKey, 'finance.atm'),
          eq(placeCategoryLabels.language, 'en'),
        ),
      );
    now = 999;
    expect(await label()).toBe('Cash machine');
    now = 1_000;
    expect(await label()).toBe('ATM');
    cache.invalidate(suite!.db);
    expect(await label()).toBe('ATM');
  });

  it('is a depth-first walk with siblings by position', async () => {
    const keys = (await loadCategories(suite!.db)).map((category) => category.key);
    expect(keys.indexOf('food.churreria')).toBeGreaterThan(keys.indexOf('food.confectionery'));
    expect(keys.indexOf('food.churreria.madrid')).toBe(keys.indexOf('food.churreria') + 1);
    expect(keys.indexOf('shop')).toBe(keys.indexOf('food.churreria.madrid') + 1);
  });
});

describe('the OpenStreetMap import', () => {
  it('files elements through the database mapping, and never under a deprecated category', async () => {
    const tags = (entries: Record<string, string>) => new Map(Object.entries(entries));
    const mapping = await categoryCatalog(suite!.db);
    expect(osmCategories(tags({ shop: 'churros' }), mapping)).toEqual(['food.churreria']);

    // Deprecated: the `shop=*` fallback files it instead.
    await api.call('PATCH', '/moderation/categories/food.churreria', OPERATOR, {
      status: 'deprecated',
    });
    const deprecated = await categoryCatalog(suite!.db);
    expect(osmCategories(tags({ shop: 'churros' }), deprecated)).toEqual(['shop']);
    await api.call('PATCH', '/moderation/categories/food.churreria', OPERATOR, {
      status: 'active',
    });

    // And the write lands through the trigger.
    const fresh = await categoryCatalog(suite!.db);
    const element = toImportedPlace(
      'node',
      991_001,
      40.4087,
      -3.7015,
      tags({ shop: 'churros', name: 'Churros Pepe' }),
      fresh,
    );
    expect(element?.columns.categories).toEqual(['food.churreria']);
    const stats = emptyWriteStats();
    await writePlaceBatch(suite!.db, [element!], new Date(), stats);
    expect(stats.placesInserted).toBe(1);
  });

  it('indexes an empty taxonomy as filing nothing', () => {
    expect(osmCategories(new Map([['amenity', 'cafe']]), catalogOf([]))).toEqual([]);
  });
});
