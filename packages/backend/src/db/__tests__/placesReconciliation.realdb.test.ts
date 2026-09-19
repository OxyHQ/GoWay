/**
 * Reconciliation, through the repository that production uses.
 *
 * The acceptance criterion this file answers is negative and therefore easy to
 * pass accidentally: "source reconciliation avoids naive name-only merging".
 * A repository that merged aggressively and one that never merges at all both
 * satisfy a test that only checks a happy path, so what is asserted here is
 * that two places which LOOK identical stay two places, and that the evidence
 * for their being one lands somewhere a human can act on.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { isApiError } from '../../http/apiError';
import {
  createClaim,
  createPlace,
  findClaimedPlaceIds,
  findPlaceById,
  findPlaceIdBySourceRef,
  updatePlace,
  type PlaceActor,
} from '../places/placesRepository';
import { SUITE_SETUP_TIMEOUT_MS, createSuiteDatabase, destroySuiteDatabase, type SuiteDatabase } from './testDatabase';

const ACTOR: PlaceActor = { oxyUserId: 'user-1', assertedVerification: 'community_reported' };

/** Plaça de Catalunya, Barcelona. Two coffee shops ten metres apart live here. */
const CATALUNYA = { latitude: 41.3870, longitude: 2.1700 };

/** Ten metres north — inside the 75 m duplicate-proximity window. */
const CATALUNYA_NEARBY = { latitude: 41.3871, longitude: 2.1700 };

/** Two kilometres away — a second branch of a chain, which must stay separate. */
const GRACIA = { latitude: 41.4050, longitude: 2.1560 };

let suite: SuiteDatabase | null = null;

beforeAll(async () => {
  suite = await createSuiteDatabase();
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await destroySuiteDatabase(suite);
  suite = null;
});

/** The open duplicate candidates naming a place, either side of the pair. */
async function candidatesFor(placeId: string): Promise<{ other: string; reason: string }[]> {
  const rows = await suite!.client<{ place_id: string; candidate_place_id: string; reason: string }[]>`
    SELECT place_id, candidate_place_id, reason FROM places_duplicate_candidates
    WHERE place_id = ${placeId} OR candidate_place_id = ${placeId}
  `;
  return rows.map((row) => ({
    other: row.place_id === placeId ? row.candidate_place_id : row.place_id,
    reason: row.reason,
  }));
}

describe('source linking', () => {
  it('is deterministic: a source id resolves to the one place it is bound to', async () => {
    const place = await createPlace(
      suite!.db,
      { name: 'Bar Pinotxo', location: CATALUNYA, sources: [{ source: 'openstreetmap', sourceId: 'node/1' }] },
      ACTOR,
    );
    expect(await findPlaceIdBySourceRef(suite!.db, { source: 'openstreetmap', sourceId: 'node/1' })).toBe(place.id);
    // Provenance is published, with the freshness that makes it usable.
    expect(place.sources).toHaveLength(1);
    expect(place.sources[0]?.source).toBe('openstreetmap');
    expect(place.sources[0]?.observedAt).toBeString();
  });

  it('refuses to create a SECOND place on a source id another place already holds', async () => {
    // Without this, one OSM node becomes two GoWay places, two deep links and
    // two capability sets — and nothing anywhere reports it.
    const error = await createPlace(
      suite!.db,
      { name: 'Bar Pinotxo (again)', location: CATALUNYA, sources: [{ source: 'openstreetmap', sourceId: 'node/1' }] },
      ACTOR,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isApiError(error) && error.code).toBe('conflict');
  });

  it('records a duplicate CANDIDATE — and merges nothing — when an existing place claims a taken source id', async () => {
    // The "GoWay-created place that later matches an external source" case, in
    // the shape where the match is already spoken for. Both places survive; the
    // collision becomes a review item rather than a silent merge.
    const goWayCreated = await createPlace(
      suite!.db,
      { name: 'Pinotxo', location: CATALUNYA_NEARBY },
      ACTOR,
    );
    const owner = await findPlaceIdBySourceRef(suite!.db, { source: 'openstreetmap', sourceId: 'node/1' });

    const error = await updatePlace(
      suite!.db,
      goWayCreated.id,
      { sources: [{ source: 'openstreetmap', sourceId: 'node/1' }] },
      ACTOR,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isApiError(error) && error.code).toBe('conflict');

    // Both places still exist, unmerged.
    expect(await findPlaceById(suite!.db, goWayCreated.id)).not.toBeNull();
    expect(await findPlaceById(suite!.db, owner!)).not.toBeNull();

    const candidates = await candidatesFor(goWayCreated.id);
    expect(candidates).toContainEqual({ other: owner!, reason: 'shared_source_id' });
  });

  it('moves observed_at FORWARD only, so replaying an old export cannot age a record', async () => {
    const place = await createPlace(
      suite!.db,
      { name: 'Quimet & Quimet', location: GRACIA, sources: [{ source: 'openstreetmap', sourceId: 'node/2' }] },
      ACTOR,
    );
    const fresh = await findPlaceById(suite!.db, place.id);
    const freshObservedAt = fresh!.sources[0]!.observedAt!;

    // Rewind the stored observation, then re-link: `greatest()` must keep the
    // NEWER of the two, which is the one the second link just supplied.
    await suite!.client`
      UPDATE places_sources SET observed_at = now() - interval '2 years' WHERE place_id = ${place.id}
    `;
    await updatePlace(suite!.db, place.id, { sources: [{ source: 'openstreetmap', sourceId: 'node/2' }] }, ACTOR);

    const relinked = await findPlaceById(suite!.db, place.id);
    expect(Date.parse(relinked!.sources[0]!.observedAt!)).toBeGreaterThan(
      Date.parse(freshObservedAt) - 1000,
    );
  });

  it('never unlinks a source an update simply did not mention', async () => {
    // Provenance is not a field a later writer owns. An update carrying one
    // source must not be read as "these are now the only sources".
    const place = await createPlace(
      suite!.db,
      { name: 'Els Quatre Gats', location: GRACIA, sources: [{ source: 'openstreetmap', sourceId: 'node/3' }] },
      ACTOR,
    );
    const updated = await updatePlace(suite!.db, place.id, { name: 'Els 4 Gats' }, ACTOR);
    expect(updated!.name).toBe('Els 4 Gats');
    expect(updated!.sources.map((source) => source.sourceId)).toEqual(['node/3']);
  });
});

describe('duplicate detection', () => {
  it('flags an identical name at ten metres — and does NOT merge it', async () => {
    const first = await createPlace(suite!.db, { name: 'Forn Baluard', location: CATALUNYA }, ACTOR);
    const second = await createPlace(suite!.db, { name: 'Forn Baluard', location: CATALUNYA_NEARBY }, ACTOR);

    expect(second.id).not.toBe(first.id);
    expect(await candidatesFor(second.id)).toContainEqual({ other: first.id, reason: 'proximity_and_name' });

    // Both are still readable, with their own ids. A merge would have made one
    // of these deep links dead.
    expect((await findPlaceById(suite!.db, first.id))?.name).toBe('Forn Baluard');
    expect((await findPlaceById(suite!.db, second.id))?.name).toBe('Forn Baluard');
  });

  it('does NOT flag an identical name two kilometres away — a chain is not a duplicate', async () => {
    // The assertion that makes the previous one mean something. A matcher keyed
    // on the name alone would flag every branch of every chain, and a reviewer
    // facing thousands of false positives stops reviewing.
    const branch = await createPlace(suite!.db, { name: 'Forn Baluard', location: GRACIA }, ACTOR);
    expect(await candidatesFor(branch.id)).toEqual([]);
  });

  it('does NOT flag two different names at the same address', async () => {
    // Proximity alone is not evidence either: a shopping centre is hundreds of
    // distinct places inside 75 m.
    const kiosk = await createPlace(suite!.db, { name: 'Kiosk Rambla', location: CATALUNYA }, ACTOR);
    expect(await candidatesFor(kiosk.id)).toEqual([]);
  });
});

describe('capability provenance', () => {
  it('records a community report and an external-source fact as separate, distinguishable rows', async () => {
    const place = await createPlace(
      suite!.db,
      {
        name: 'Colmado Quílez',
        location: GRACIA,
        sources: [{ source: 'openstreetmap', sourceId: 'node/9' }],
        capabilities: [
          { namespace: 'payments.faircoin', capability: 'accepted', value: true },
          {
            namespace: 'commerce.mercaria',
            capability: 'store',
            value: 'store-42',
            source: { source: 'openstreetmap', sourceId: 'node/9' },
          },
        ],
      },
      ACTOR,
    );

    const byKey = new Map(place.capabilities.map((capability) => [capability.key, capability]));
    // Asserted by the caller, with no evidence: the weakest tier, whoever asked.
    expect(byKey.get('payments.faircoin.accepted')?.verification).toBe('community_reported');
    // Carries a source, so it is attributable — and the source ref comes back
    // with it rather than having to be looked up separately.
    expect(byKey.get('commerce.mercaria.store')?.verification).toBe('external_source');
    expect(byKey.get('commerce.mercaria.store')?.source?.sourceId).toBe('node/9');
    // Freshness is part of the contract: a claim with no date is not a fact.
    expect(byKey.get('payments.faircoin.accepted')?.observedAt).toBeString();
  });

  it('cannot be told to record an oxy_verified capability by a caller', async () => {
    // The SDK strips `verification` from a write body; this is the half that
    // also covers every non-SDK caller. A wallet showing a merchant as verified
    // on the strength of the merchant's own say-so is the failure being
    // prevented.
    const place = await createPlace(
      suite!.db,
      {
        name: 'Bodega Sepúlveda',
        location: GRACIA,
        capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
      },
      // Even a claimant — the strongest an API caller can be — asserts
      // `business_asserted`, never `oxy_verified`.
      { oxyUserId: 'user-owner', assertedVerification: 'business_asserted' },
    );
    expect(place.capabilities[0]?.verification).toBe('business_asserted');

    const rows = await suite!.client<{ verification: string }[]>`
      SELECT verification FROM places_capabilities WHERE place_id = ${place.id}
    `;
    expect(rows.every((row) => row.verification !== 'oxy_verified')).toBe(true);
  });

  it('keeps a historic community report beside a later verified fact', async () => {
    // "A historic community report must be distinguishable from a verified
    // current fact." Both rows survive, each with its own tier and date.
    const place = await createPlace(
      suite!.db,
      {
        name: 'Granja Petitbo',
        location: GRACIA,
        capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
      },
      ACTOR,
    );
    await suite!.client`
      UPDATE places_capabilities SET observed_at = now() - interval '2 years' WHERE place_id = ${place.id}
    `;
    await suite!.client`
      INSERT INTO places_capabilities (id, place_id, namespace, capability, value, verification)
      VALUES (${`${place.id}-verified`}, ${place.id}, 'payments.faircoin', 'accepted', 'true'::jsonb, 'oxy_verified')
    `;

    const read = await findPlaceById(suite!.db, place.id);
    const faircoin = read!.capabilities.filter((capability) => capability.key === 'payments.faircoin.accepted');
    expect(faircoin).toHaveLength(2);
    // Strongest first, so a consumer taking the first row per key gets the
    // verified answer without knowing the ranking.
    expect(faircoin[0]?.verification).toBe('oxy_verified');
    expect(faircoin[1]?.verification).toBe('community_reported');
    expect(Date.parse(faircoin[1]!.observedAt)).toBeLessThan(Date.parse(faircoin[0]!.observedAt));
  });
});

describe('business identity', () => {
  it('holds a chain together through a brand, with a different operator per location', async () => {
    // The shape a single `owner_id` column cannot express. Nothing here is a
    // special case for chains: a claim is a (place, account, role, brand) row,
    // and a franchise is what you get when two of them share a brand and differ
    // in operator.
    const first = await createPlace(suite!.db, { name: 'Cafè Cadena Uno', location: CATALUNYA }, ACTOR);
    const second = await createPlace(suite!.db, { name: 'Cafè Cadena Dos', location: GRACIA }, ACTOR);
    const unrelated = await createPlace(suite!.db, { name: 'Independent', location: GRACIA }, ACTOR);

    await createClaim(suite!.db, {
      placeId: first.id,
      oxyAccountId: 'acct-franchisee-a',
      brandId: 'brand-cadena',
      role: 'operator',
      state: 'approved',
    });
    await createClaim(suite!.db, {
      placeId: second.id,
      oxyAccountId: 'acct-franchisee-b',
      brandId: 'brand-cadena',
      role: 'operator',
      state: 'approved',
    });
    // The brand owner holds a claim on both, in a different role, at once.
    await createClaim(suite!.db, {
      placeId: first.id,
      oxyAccountId: 'acct-brand-owner',
      brandId: 'brand-cadena',
      role: 'brand',
      state: 'approved',
    });

    const byBrand = await findClaimedPlaceIds(suite!.db, { brandId: 'brand-cadena' });
    expect(byBrand.sort()).toEqual([first.id, second.id].sort());
    expect(byBrand).not.toContain(unrelated.id);

    // One operator sees only their own location, which is the authorization
    // question `PATCH /places/:id` asks.
    expect(await findClaimedPlaceIds(suite!.db, { oxyAccountId: 'acct-franchisee-b' })).toEqual([second.id]);
  });

  it('does not count a PENDING claim as a relationship', async () => {
    // A claim is a request to be recognised. A schema that could not say so
    // would grant control at the moment somebody asked for it.
    const place = await createPlace(suite!.db, { name: 'Pending Bar', location: GRACIA }, ACTOR);
    await createClaim(suite!.db, { placeId: place.id, oxyAccountId: 'acct-hopeful', role: 'owner' });
    expect(await findClaimedPlaceIds(suite!.db, { oxyAccountId: 'acct-hopeful' })).toEqual([]);
  });
});
