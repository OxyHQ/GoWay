/**
 * The constraints, exercised against a real database.
 *
 * Every CHECK in this schema exists because the value it refuses would
 * otherwise be indistinguishable from a real one downstream: a capability whose
 * `key` disagrees with its parts is a filter that silently matches nothing, an
 * `external_source` claim with no source is provenance that cannot be
 * traced, a lower-case country code is a place that no country query finds.
 * A constraint that is declared and not enforced is worse than none, because
 * the schema reads as if it were safe — so each one is asserted by trying to
 * violate it.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { statementFailure } from './statementFailure';
import { SUITE_SETUP_TIMEOUT_MS, createSuiteDatabase, destroySuiteDatabase, type SuiteDatabase } from './testDatabase';

let suite: SuiteDatabase | null = null;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  await suite.client`
    INSERT INTO places (id, name, latitude, longitude) VALUES ('p-1', 'Cafè Central', 41.3851, 2.1734)
  `;
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('places', () => {
  it('refuses a status outside the published tuple', async () => {
    // The tuple lives in `@goway/shared-types` and types the column, builds the
    // CHECK and types the SDK. This is the assertion that the third of those is
    // really enforced rather than merely declared.
    const message = await statementFailure(
      () => suite!.client`UPDATE places SET status = 'demolished' WHERE id = 'p-1'`,
    );
    expect(message).toContain('places_status_check');
  });

  it('refuses a verification state outside the published tuple', async () => {
    const message = await statementFailure(
      () => suite!.client`UPDATE places SET verification_state = 'trust_me' WHERE id = 'p-1'`,
    );
    expect(message).toContain('places_verification_state_check');
  });

  it('refuses a latitude off the planet even when the HTTP layer is bypassed', async () => {
    // The route validates this too. The CHECK is what protects a backfill, an
    // importer or a psql session — the paths that have no zod schema in front
    // of them and that produce a point PostGIS will happily normalize into
    // somewhere else on Earth.
    const message = await statementFailure(
      () => suite!.client`INSERT INTO places (id, name, latitude, longitude) VALUES ('p-bad', 'X', 120, 0)`,
    );
    expect(message).toContain('places_latitude_range_check');
  });

  it('refuses a blank name', async () => {
    const message = await statementFailure(
      () => suite!.client`INSERT INTO places (id, name, latitude, longitude) VALUES ('p-blank', '   ', 0, 0)`,
    );
    expect(message).toContain('places_name_not_blank_check');
  });

  it('refuses a country code that is not ISO 3166-1 alpha-2 uppercase', async () => {
    const message = await statementFailure(
      () => suite!.client`UPDATE places SET address_country_code = 'es' WHERE id = 'p-1'`,
    );
    expect(message).toContain('places_country_code_check');
  });

  it('normalizes nothing it was not asked to: the name is stored verbatim', async () => {
    // `name_normalized` is a SEPARATE generated column precisely so the name a
    // contributor typed survives. A schema that lower-cased in place would make
    // "CAFÈ CENTRAL" unrecoverable.
    const [row] = await suite!.client<{ name: string; name_normalized: string }[]>`
      SELECT name, name_normalized FROM places WHERE id = 'p-1'
    `;
    expect(row?.name).toBe('Cafè Central');
    expect(row?.name_normalized).toBe('cafè central');
  });
});

describe('places_capabilities', () => {
  it('generates key as <namespace>.<capability>, which is what the SDK refuses a mismatch on', async () => {
    await suite!.client`
      INSERT INTO places_capabilities (id, place_id, namespace, capability, value, verification)
      VALUES ('c-1', 'p-1', 'payments.faircoin', 'accepted', 'true'::jsonb, 'community_reported')
    `;
    const [row] = await suite!.client<{ key: string }[]>`
      SELECT key FROM places_capabilities WHERE id = 'c-1'
    `;
    expect(row?.key).toBe('payments.faircoin.accepted');
  });

  it('refuses a capability name containing a dot, which would make the key ambiguous', async () => {
    // `a.b` + `c` and `a` + `b.c` would generate the same key. The namespace may
    // hold dots; the capability may not, and that asymmetry is what keeps the
    // generated key a function of exactly one pair.
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO places_capabilities (id, place_id, namespace, capability, value, verification)
        VALUES ('c-dotted', 'p-1', 'payments', 'faircoin.accepted', 'true'::jsonb, 'community_reported')
      `,
    );
    expect(message).toContain('places_capabilities_capability_shape_check');
  });

  it('refuses a value that is not a boolean, a string or a number', async () => {
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO places_capabilities (id, place_id, namespace, capability, value, verification)
        VALUES ('c-obj', 'p-1', 'payments.faircoin', 'rate', '{"a":1}'::jsonb, 'community_reported')
      `,
    );
    expect(message).toContain('places_capabilities_value_type_check');
  });

  it('refuses an external_source assertion that names no source', async () => {
    // The weakest-looking tier must not also be the one that can be written
    // with no evidence attached.
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO places_capabilities (id, place_id, namespace, capability, value, verification)
        VALUES ('c-ext', 'p-1', 'payments.faircoin', 'accepted', 'true'::jsonb, 'external_source')
      `,
    );
    expect(message).toContain('places_capabilities_external_source_check');
  });

  it('lets a verified fact and a community report about the SAME capability coexist', async () => {
    // The uniqueness key includes `verification` for exactly this: an
    // Oxy-verified acceptance must not be erased by the next community report,
    // and a client has to be able to tell the two apart.
    await suite!.client`
      INSERT INTO places_capabilities (id, place_id, namespace, capability, value, verification)
      VALUES ('c-2', 'p-1', 'payments.faircoin', 'accepted', 'true'::jsonb, 'oxy_verified')
    `;
    const rows = await suite!.client<{ verification: string }[]>`
      SELECT verification FROM places_capabilities
      WHERE place_id = 'p-1' AND key = 'payments.faircoin.accepted' ORDER BY verification
    `;
    expect(rows.map((row) => row.verification)).toEqual(['community_reported', 'oxy_verified']);
  });

  it('refuses a SECOND assertion at the same tier, so a tier holds one current answer', async () => {
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO places_capabilities (id, place_id, namespace, capability, value, verification)
        VALUES ('c-dup', 'p-1', 'payments.faircoin', 'accepted', 'false'::jsonb, 'community_reported')
      `,
    );
    expect(message).toContain('places_capabilities_assertion_key');
  });
});

describe('places_sources', () => {
  it('binds one external record to at most one GoWay place', async () => {
    // The whole of deterministic source linking, as a constraint: a second
    // place claiming an identifier another already holds cannot be written, so
    // reconciliation cannot silently produce two copies of one real record.
    await suite!.client`
      INSERT INTO places (id, name, latitude, longitude) VALUES ('p-2', 'Cafè Central', 41.3852, 2.1735)
    `;
    await suite!.client`
      INSERT INTO places_sources (id, place_id, source, source_id)
      VALUES ('s-1', 'p-1', 'openstreetmap', 'node/123')
    `;
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO places_sources (id, place_id, source, source_id)
        VALUES ('s-2', 'p-2', 'openstreetmap', 'node/123')
      `,
    );
    expect(message).toContain('places_sources_source_record_key');
  });
});

describe('places_claims', () => {
  it('stores an Oxy account id with NO foreign key — Oxy owns identity', async () => {
    // There is no `users` table and there never will be: every account id here
    // is a foreign service's primary key reached over HTTP. A claim referencing
    // an account this database has never heard of is the normal case.
    await suite!.client`
      INSERT INTO places_claims (id, place_id, oxy_account_id, role)
      VALUES ('cl-1', 'p-1', 'acct-never-seen-here', 'owner')
    `;
    const [row] = await suite!.client<{ state: string }[]>`
      SELECT state FROM places_claims WHERE id = 'cl-1'
    `;
    // Pending by default: a claim is a request to be recognised, not recognition.
    expect(row?.state).toBe('pending');
  });

  it('refuses a decided claim with no decision time, and a pending one with one', async () => {
    const decidedWithoutTime = await statementFailure(
      () => suite!.client`UPDATE places_claims SET state = 'approved' WHERE id = 'cl-1'`,
    );
    expect(decidedWithoutTime).toContain('places_claims_decided_at_check');

    const pendingWithTime = await statementFailure(
      () => suite!.client`UPDATE places_claims SET decided_at = now() WHERE id = 'cl-1'`,
    );
    expect(pendingWithTime).toContain('places_claims_decided_at_check');
  });

  it('lets one place carry claims from several accounts in different roles', async () => {
    // The shape a single `owner_id` column makes unrepresentable: a franchise
    // operated by one account under another's brand.
    await suite!.client`
      INSERT INTO places_claims (id, place_id, oxy_account_id, role, brand_id, state, decided_at)
      VALUES ('cl-2', 'p-1', 'acct-operator', 'operator', 'brand-chain', 'approved', now())
    `;
    await suite!.client`
      INSERT INTO places_claims (id, place_id, oxy_account_id, role, brand_id, state, decided_at)
      VALUES ('cl-3', 'p-1', 'acct-brand', 'brand', 'brand-chain', 'approved', now())
    `;
    const rows = await suite!.client<{ role: string }[]>`
      SELECT role FROM places_claims WHERE place_id = 'p-1' AND state = 'approved' ORDER BY role
    `;
    expect(rows.map((row) => row.role)).toEqual(['brand', 'operator']);
  });
});

describe('places_duplicate_candidates', () => {
  it('refuses a pair stored out of canonical order, so A/B and B/A cannot both exist', async () => {
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO places_duplicate_candidates (id, place_id, candidate_place_id, reason)
        VALUES ('d-bad', 'p-2', 'p-1', 'proximity_and_name')
      `,
    );
    expect(message).toContain('places_duplicates_pair_order_check');
  });

  it('records a pair once', async () => {
    await suite!.client`
      INSERT INTO places_duplicate_candidates (id, place_id, candidate_place_id, reason)
      VALUES ('d-1', 'p-1', 'p-2', 'proximity_and_name')
    `;
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO places_duplicate_candidates (id, place_id, candidate_place_id, reason)
        VALUES ('d-2', 'p-1', 'p-2', 'shared_source_id')
      `,
    );
    expect(message).toContain('places_duplicates_pair_key');
  });
});

describe('places_names', () => {
  it('holds one row per (place, language, SOURCE), so a correction survives a re-import', async () => {
    // The whole point of the third column. OpenStreetMap's Spanish name and
    // GoWay's correction of it coexist; an importer refreshing the first has
    // no way to address the second.
    await suite!.client`
      INSERT INTO places_names (id, place_id, language, name, source)
      VALUES ('n-1', 'p-1', 'es', 'Cafe Central', 'openstreetmap'),
             ('n-2', 'p-1', 'es', 'Café Central', 'goway')
    `;
    const [row] = await suite!.client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM places_names WHERE place_id = 'p-1' AND language = 'es'
    `;
    expect(row?.count).toBe('2');
  });

  it('refuses a second row for the same place, language and source', async () => {
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO places_names (id, place_id, language, name, source)
        VALUES ('n-dup', 'p-1', 'es', 'Otra cosa', 'openstreetmap')
      `,
    );
    expect(message).toContain('places_names_language_source_key');
  });

  it('generates name_normalized without touching the name a contributor typed', async () => {
    const [row] = await suite!.client<{ name: string; name_normalized: string }[]>`
      SELECT name, name_normalized FROM places_names WHERE id = 'n-2'
    `;
    expect(row?.name).toBe('Café Central');
    expect(row?.name_normalized).toBe('café central');
  });

  it('refuses a language tag that is not canonical BCP 47', async () => {
    // `ES` and `es` would be two rows under the unique key above, so the
    // canonical form is enforced HERE and not only at the HTTP edge — an
    // importer, a backfill and a psql session all reach this table with no zod
    // schema in front of them.
    for (const tag of ['ES', 'es_MX', 'es-mx', ' es']) {
      const message = await statementFailure(
        () => suite!.client`
          INSERT INTO places_names (id, place_id, language, name, source)
          VALUES (${`n-bad-${tag}`}, 'p-1', ${tag}, 'X', 'openstreetmap')
        `,
      );
      expect(message).toContain('places_names_language_tag_check');
    }
  });

  it('refuses the OpenStreetMap name:* keys that are not languages', async () => {
    // `left`, `right`, `signed` and `prefix` are all real `name:*` suffixes and
    // all well-formed under the wider BCP 47 rule. A street's left-hand-side
    // label is not a translation and must not enter the map's vocabulary as
    // one.
    for (const key of ['left', 'right', 'signed', 'etymology']) {
      const message = await statementFailure(
        () => suite!.client`
          INSERT INTO places_names (id, place_id, language, name, source)
          VALUES (${`n-key-${key}`}, 'p-1', ${key}, 'X', 'openstreetmap')
        `,
      );
      expect(message).toContain('places_names_language_tag_check');
    }
  });

  it('accepts the shapes OpenStreetMap really carries', async () => {
    await suite!.client`
      INSERT INTO places_names (id, place_id, language, name, source)
      VALUES ('n-ok-1', 'p-1', 'zh-Hant', 'X', 'openstreetmap'),
             ('n-ok-2', 'p-1', 'en-GB', 'X', 'openstreetmap'),
             ('n-ok-3', 'p-1', 'es-419', 'X', 'openstreetmap'),
             ('n-ok-4', 'p-1', 'ca-valencia', 'X', 'openstreetmap'),
             ('n-ok-5', 'p-1', 'zh-Hant-HK', 'X', 'openstreetmap')
    `;
    const [row] = await suite!.client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM places_names WHERE id LIKE 'n-ok-%'
    `;
    expect(row?.count).toBe('5');
  });

  it('refuses a blank name and a blank source', async () => {
    const blankName = await statementFailure(
      () => suite!.client`
        INSERT INTO places_names (id, place_id, language, name, source)
        VALUES ('n-blank', 'p-1', 'fr', '   ', 'openstreetmap')
      `,
    );
    expect(blankName).toContain('places_names_name_not_blank_check');

    const blankSource = await statementFailure(
      () => suite!.client`
        INSERT INTO places_names (id, place_id, language, name, source)
        VALUES ('n-nosource', 'p-1', 'fr', 'Café', '  ')
      `,
    );
    expect(blankSource).toContain('places_names_source_not_blank_check');
  });
});

describe('deleting a place', () => {
  it('takes its sources, capabilities, claims and duplicate candidates with it', async () => {
    // Every child declares an explicit `onDelete`, and for these five it is
    // `cascade`: none of them means anything without the place. A dangling
    // capability row would keep answering a `?capabilities=` filter for a place
    // that no longer exists, and a dangling name row would keep the place's
    // Spanish label alive after the place itself is gone.
    await suite!.client`DELETE FROM places WHERE id = 'p-1'`;
    const [counts] = await suite!.client<{ sources: string; capabilities: string; claims: string; duplicates: string; names: string }[]>`
      SELECT
        (SELECT count(*) FROM places_sources WHERE place_id = 'p-1')::text AS sources,
        (SELECT count(*) FROM places_capabilities WHERE place_id = 'p-1')::text AS capabilities,
        (SELECT count(*) FROM places_claims WHERE place_id = 'p-1')::text AS claims,
        (SELECT count(*) FROM places_names WHERE place_id = 'p-1')::text AS names,
        (SELECT count(*) FROM places_duplicate_candidates WHERE place_id = 'p-1' OR candidate_place_id = 'p-1')::text AS duplicates
    `;
    expect(counts).toEqual({ sources: '0', capabilities: '0', claims: '0', names: '0', duplicates: '0' });
  });
});
