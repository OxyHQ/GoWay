/**
 * The row-to-contract mapper, without a database.
 *
 * These are the cases that are awkward to reach over HTTP and expensive to get
 * wrong, because each one is a distinction the SDK relies on and that a
 * "helpful" simplification would erase:
 *
 *  - an ABSENT optional field versus an empty one,
 *  - `claims` absent (not entitled) versus `claims: []` (none exist),
 *  - the capability ordering a consumer reads the strongest answer off the top
 *    of.
 */

import '../../../__tests__/testEnv';
import { describe, expect, it } from 'bun:test';
import { toPlace, type CapabilityRow, type ClaimRow, type PlaceRow, type SourceRow } from '../placeMapper';

const CREATED = new Date('2026-01-02T03:04:05.000Z');

function row(overrides: Partial<PlaceRow> = {}): PlaceRow {
  return {
    id: 'place-1',
    name: 'Bar Pinotxo',
    latitude: 41.387,
    longitude: 2.17,
    geometry: null,
    categories: [],
    addressHouseNumber: null,
    addressStreet: null,
    addressLocality: null,
    addressCity: null,
    addressRegion: null,
    addressPostalCode: null,
    addressCountryCode: null,
    addressCountry: null,
    addressFormatted: null,
    contactPhone: null,
    contactEmail: null,
    contactWebsite: null,
    openingHours: null,
    status: 'active',
    verificationState: 'unverified',
    verifiedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function capability(overrides: Partial<CapabilityRow> = {}): CapabilityRow {
  return {
    id: 'cap-1',
    placeId: 'place-1',
    namespace: 'payments.faircoin',
    capability: 'accepted',
    key: 'payments.faircoin.accepted',
    value: true,
    verification: 'community_reported',
    observedAt: CREATED,
    placeSourceId: null,
    ...overrides,
  };
}

const SOURCE: SourceRow = {
  id: 'src-1',
  placeId: 'place-1',
  source: 'openstreetmap',
  sourceId: 'node/1',
  observedAt: CREATED,
};

const CLAIM: ClaimRow = {
  id: 'claim-1',
  placeId: 'place-1',
  oxyAccountId: 'acct-1',
  brandId: null,
  role: 'owner',
  state: 'approved',
  claimedAt: CREATED,
};

describe('absent is not empty', () => {
  it('omits address and contact entirely when every part is null', () => {
    // `{}` would make every place in the database look like it has an address
    // object worth rendering, and a client checking `place.address` would draw
    // an empty card.
    const place = toPlace(row(), { sources: [], capabilities: [] });
    expect(place).not.toHaveProperty('address');
    expect(place).not.toHaveProperty('contact');
    expect(place).not.toHaveProperty('geometry');
    expect(place).not.toHaveProperty('openingHours');
    expect(place.verification).toEqual({ state: 'unverified' });
  });

  it('includes only the address parts the source actually had', () => {
    // An inferred postal code is indistinguishable from a real one downstream,
    // so a missing part stays missing rather than becoming an empty string.
    const place = toPlace(row({ addressCity: 'Barcelona', addressCountryCode: 'ES' }), {
      sources: [],
      capabilities: [],
    });
    expect(place.address).toEqual({ city: 'Barcelona', countryCode: 'ES' });
  });

  it('distinguishes "no claims" from "you may not see them"', () => {
    const hidden = toPlace(row(), { sources: [], capabilities: [] });
    expect(hidden).not.toHaveProperty('claims');

    const none = toPlace(row(), { sources: [], capabilities: [], claims: [] });
    expect(none.claims).toEqual([]);

    const visible = toPlace(row(), { sources: [], capabilities: [], claims: [CLAIM] });
    expect(visible.claims?.[0]).toEqual({
      id: 'claim-1',
      role: 'owner',
      state: 'approved',
      oxyAccountId: 'acct-1',
      claimedAt: CREATED.toISOString(),
    });
    // `brandId` was null, so it is absent rather than `undefined` or `null`.
    expect(visible.claims?.[0]).not.toHaveProperty('brandId');
  });
});

describe('capabilities', () => {
  it('orders strongest verification first, then freshest, within a key', () => {
    const older = new Date('2024-01-01T00:00:00.000Z');
    const place = toPlace(row(), {
      sources: [],
      capabilities: [
        capability({ id: 'a', verification: 'community_reported', observedAt: older }),
        capability({ id: 'b', verification: 'oxy_verified' }),
        capability({ id: 'c', verification: 'business_asserted' }),
      ],
    });
    expect(place.capabilities.map((entry) => entry.verification)).toEqual([
      'oxy_verified',
      'business_asserted',
      'community_reported',
    ]);
    // Both survive with their own dates: a two-year-old community report is
    // still readable beside the verified fact, and is not presented as current.
    expect(place.capabilities[2]?.observedAt).toBe(older.toISOString());
  });

  it('orders by key first, so a consumer can group without re-sorting', () => {
    const place = toPlace(row(), {
      sources: [],
      capabilities: [
        capability({ id: 'a', namespace: 'payments.faircoin', capability: 'accepted', key: 'payments.faircoin.accepted' }),
        capability({ id: 'b', namespace: 'commerce.mercaria', capability: 'store', key: 'commerce.mercaria.store', value: 's-1' }),
      ],
    });
    expect(place.capabilities.map((entry) => entry.key)).toEqual([
      'commerce.mercaria.store',
      'payments.faircoin.accepted',
    ]);
  });

  it('attaches the source ref only when the capability names one', () => {
    const place = toPlace(row(), {
      sources: [SOURCE],
      capabilities: [
        capability({ id: 'a' }),
        capability({ id: 'b', capability: 'rate', key: 'payments.faircoin.rate', value: 1.02, verification: 'external_source', placeSourceId: 'src-1' }),
      ],
    });
    const [accepted, rate] = place.capabilities;
    expect(accepted).not.toHaveProperty('source');
    expect(rate?.source).toEqual({
      source: 'openstreetmap',
      sourceId: 'node/1',
      observedAt: CREATED.toISOString(),
    });
    // A valued capability keeps its type: `1.02` must not become `"1.02"`.
    expect(rate?.value).toBe(1.02);
  });
});

describe('sources', () => {
  it('publishes the freshest observation first', () => {
    const stale = { ...SOURCE, id: 'src-2', source: 'wikidata', sourceId: 'Q1', observedAt: new Date('2020-01-01T00:00:00.000Z') };
    const place = toPlace(row(), { sources: [stale, SOURCE], capabilities: [] });
    expect(place.sources.map((source) => source.source)).toEqual(['openstreetmap', 'wikidata']);
  });
});
