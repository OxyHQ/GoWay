/**
 * `PATCH /places/{placeId}` is a merge patch: an absent field — or address or
 * contact part — is left alone, `null` clears a field that may be empty, and
 * a field that may not be empty refuses `null`. Over a real socket and a real
 * PostGIS, with the revision each write records.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { ModerationPlaceRevision, Place } from '@goway/contracts';
import { createPlace, type PlaceActor } from '../../db/places/placesRepository';
import { listPlaceRevisions } from '../../db/places/revisions';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { fakeOptionalAuth, fakeRequireAuth, serve, session, type ErrorBody, type TestApi } from '../../__tests__/httpHarness';
import { apiAuthor, NO_MEMBERSHIPS, NO_RATE_LIMIT } from '../../__tests__/placesFixtures';
import { createPlacesRouter } from '../places';

const CONTRIBUTOR: PlaceActor = { author: apiAuthor('person-contributor'), assertedVerification: 'community_reported' };
const EDITOR = session('person-editor');

let suite: SuiteDatabase | null = null;
let api: TestApi;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  api = await serve(
    createPlacesRouter({ optionalAuth: fakeOptionalAuth, requireAuth: fakeRequireAuth, accountRoles: NO_MEMBERSHIPS, reportRateLimit: NO_RATE_LIMIT }),
  );
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api.close();
  await destroySuiteDatabase(suite);
  suite = null;
});

/** A place with every clearable field filled. */
async function fullPlace(name: string): Promise<Place> {
  return createPlace(
    suite!.db,
    {
      name,
      location: { latitude: 41.3917, longitude: 2.1649 },
      geometry: { type: 'Point', coordinates: [2.1649, 41.3917] },
      address: { street: 'Carrer de Mallorca', houseNumber: '401', city: 'Barcelona', countryCode: 'ES' },
      contact: { phone: '+34 930 000 000', email: 'hola@example.org', website: 'https://example.org' },
      openingHours: { intervals: [{ day: 1, opens: '09:00', closes: '14:00' }] },
      description: 'Una botiga.',
    },
    CONTRIBUTOR,
  );
}

async function patch(placeId: string, body: unknown) {
  return api.call<Place & ErrorBody>('PATCH', `/places/${placeId}`, EDITOR, body);
}

async function latestRevision(placeId: string): Promise<ModerationPlaceRevision> {
  const [latest] = await listPlaceRevisions(suite!.db, placeId, 'moderation', { limit: 1 });
  return latest!.item;
}

describe('PATCH /places/{placeId} as a merge patch', () => {
  it('leaves the contact parts it does not name, and clears the one it names null', async () => {
    const place = await fullPlace('Botiga del Contacte');
    const { status, body } = await patch(place.id, { contact: { phone: null, website: 'https://example.org/nou' } });
    expect(status).toBe(200);
    expect(body.contact).toEqual({ email: 'hola@example.org', website: 'https://example.org/nou' });

    const revision = await latestRevision(place.id);
    expect(revision.action).toBe('place_updated');
    expect(revision.changes).toEqual([
      { field: 'contact.phone', before: '+34 930 000 000' },
      { field: 'contact.website', before: 'https://example.org', after: 'https://example.org/nou' },
    ]);
  });

  it('clears one address part, or the whole address with null', async () => {
    const place = await fullPlace("Botiga de l'Adreça");
    const part = await patch(place.id, { address: { houseNumber: null } });
    expect(part.body.address).toEqual({ street: 'Carrer de Mallorca', city: 'Barcelona', countryCode: 'ES' });

    const whole = await patch(place.id, { address: null });
    expect(whole.status).toBe(200);
    expect(whole.body.address).toBeUndefined();
    expect((await latestRevision(place.id)).changes.map((change) => change.field).sort()).toEqual([
      'address.city',
      'address.countryCode',
      'address.street',
    ]);
  });

  it('clears the description, the weekly hours, the geometry and the contact with null', async () => {
    const place = await fullPlace('Botiga Buidada');
    const { status, body } = await patch(place.id, {
      description: null,
      openingHours: null,
      geometry: null,
      contact: null,
    });
    expect(status).toBe(200);
    expect(body.description).toBeUndefined();
    expect(body.openingHours).toBeUndefined();
    expect(body.geometry).toBeUndefined();
    expect(body.contact).toBeUndefined();
    // Untouched: never mentioned.
    expect(body.address?.street).toBe('Carrer de Mallorca');
    // The zone follows the position, which did not move.
    expect(body.timezone).toBe('Europe/Madrid');

    const cleared = (await latestRevision(place.id)).changes;
    expect(cleared.every((change) => change.before !== undefined && change.after === undefined)).toBe(true);
    expect(cleared.map((change) => change.field).sort()).toEqual([
      'contact.email',
      'contact.phone',
      'contact.website',
      'description',
      'geometry',
      'openingHours',
    ]);
  });

  it('refuses null for a field a place cannot be without, and changes nothing', async () => {
    const place = await fullPlace('Botiga Sencera');
    // A wrong type is malformed (400); `status` is a closed set, and null is
    // simply not one of its values (422).
    for (const [field, expected] of [['name', 400], ['location', 400], ['categories', 400], ['status', 422]] as const) {
      const { status, body } = await patch(place.id, { [field]: null });
      expect(status).toBe(expected);
      expect(body.error.details?.field).toBe(field);
    }
    const timezone = await patch(place.id, { timezone: null });
    // Not writable at all: an unknown key in a body is dropped, and a body that
    // names nothing writable is refused.
    expect(timezone.status).toBe(422);

    const { body } = await api.call<Place>('GET', `/places/${place.id}`);
    expect(body.name).toBe('Botiga Sencera');
    expect(body.contact?.phone).toBe('+34 930 000 000');
  });
});
