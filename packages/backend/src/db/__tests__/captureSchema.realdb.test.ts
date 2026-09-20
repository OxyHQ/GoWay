/**
 * The capture schema's guarantees, exercised against a real database.
 *
 * Three of these are not ordinary validation. They are the promises Phase A
 * exists to make, and each is asserted by trying to BREAK it rather than by
 * observing that a well-behaved insert succeeds:
 *
 *  1. **No raw media is permanent by accident.** An object with no retention
 *     class, no reason or no expiry cannot be inserted, and neither can one
 *     whose expiry is past the schema's backstop. A test that only inserted
 *     valid rows would pass just as happily against a table with all three
 *     columns nullable.
 *  2. **Exact duplicates are one object.** A second live row for the same
 *     content hash is refused — and, because the constraint is PARTIAL, the
 *     same bytes CAN be stored again once the first object has been deleted.
 *     Both halves are asserted: a total unique constraint would pass the first
 *     and silently fail the second, forever refusing a legitimate
 *     re-contribution on the strength of a tombstone.
 *  3. **Privacy fails closed.** An asset cannot enter a reconstruction state
 *     with the gate shut, a `passed` verdict must name the pipeline that
 *     produced it, and `reconstruction_eligible` is GENERATED — so the test
 *     also asserts that writing it directly is REFUSED by Postgres, which is
 *     what makes "nothing can forge this flag" true rather than hoped for.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { statementFailure } from './statementFailure';
import { SUITE_SETUP_TIMEOUT_MS, createSuiteDatabase, destroySuiteDatabase, type SuiteDatabase } from './testDatabase';

let suite: SuiteDatabase | null = null;

/** 64 lower-case hex characters, which is the only shape the hash column accepts. */
const hash = (seed: string): string => seed.repeat(64).slice(0, 64);

beforeAll(async () => {
  suite = await createSuiteDatabase();
  await suite.client`
    INSERT INTO capture_sessions (id, oxy_user_id, source, consent_version)
    VALUES ('sess-1', 'user-1', 'camera', '2026-09-01')
  `;
  await suite.client`
    INSERT INTO capture_media_objects
      (id, content_hash, object_key, content_type, byte_size, upload_intent_expires_at,
       retention_class, retention_reason, expires_at)
    VALUES
      ('obj-1', ${hash('a')}, 'captures/2026/09/obj-1', 'image/jpeg', 2048,
       now() + interval '15 minutes', 'raw_photo', 'awaiting_privacy_processing',
       now() + interval '90 days')
  `;
  await suite.client`
    INSERT INTO capture_assets
      (id, session_id, media_object_id, oxy_user_id, media_kind, source,
       anchor_latitude, anchor_longitude, anchor_origin, anchor_witness)
    VALUES
      ('asset-1', 'sess-1', 'obj-1', 'user-1', 'photo', 'camera',
       41.3851, 2.1734, 'device_capture', 'client')
  `;
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('no raw media is permanent by accident', () => {
  it('refuses an object with no expiry', async () => {
    // The whole guarantee, as one insert. If `expires_at` ever becomes
    // nullable, this is the test that fails.
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_media_objects
          (id, content_hash, object_key, content_type, byte_size, upload_intent_expires_at,
           retention_class, retention_reason)
        VALUES
          ('obj-forever', ${hash('b')}, 'captures/forever', 'image/jpeg', 1,
           now() + interval '15 minutes', 'raw_photo', 'awaiting_privacy_processing')
      `,
    );
    expect(message).toMatch(/expires_at/);
  });

  it('refuses an object that does not say what it is or why it is kept', async () => {
    const noClass = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_media_objects
          (id, content_hash, object_key, content_type, byte_size, upload_intent_expires_at,
           retention_reason, expires_at)
        VALUES
          ('obj-noclass', ${hash('c')}, 'captures/noclass', 'image/jpeg', 1,
           now() + interval '15 minutes', 'awaiting_privacy_processing', now() + interval '1 day')
      `,
    );
    expect(noClass).toMatch(/retention_class/);

    const noReason = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_media_objects
          (id, content_hash, object_key, content_type, byte_size, upload_intent_expires_at,
           retention_class, expires_at)
        VALUES
          ('obj-noreason', ${hash('d')}, 'captures/noreason', 'image/jpeg', 1,
           now() + interval '15 minutes', 'raw_photo', now() + interval '1 day')
      `,
    );
    expect(noReason).toMatch(/retention_reason/);
  });

  it('refuses an expiry past the schema backstop, however it got there', async () => {
    // 400 days is the ceiling. A value past it is not a policy decision, it is
    // an arithmetic slip or a "temporary" extension nobody undid — and the
    // CHECK is what turns it into a refused write instead of an object nobody
    // notices for a year. This covers the backfill/script/psql paths that have
    // no zod schema in front of them.
    const message = await statementFailure(
      () => suite!.client`
        UPDATE capture_media_objects SET expires_at = now() + interval '2 years' WHERE id = 'obj-1'
      `,
    );
    expect(message).toContain('capture_objects_expiry_ceiling_check');
  });

  it('refuses an expiry before the object existed', async () => {
    const message = await statementFailure(
      () => suite!.client`
        UPDATE capture_media_objects SET expires_at = created_at - interval '1 day' WHERE id = 'obj-1'
      `,
    );
    expect(message).toContain('capture_objects_expiry_after_creation_check');
  });

  it('refuses protection that would outlive the expiry it protects against', async () => {
    // A `protected_until` past `expires_at` is a second, invisible expiry that
    // wins — the silent indefinite renewal #10 refuses by name.
    const message = await statementFailure(
      () => suite!.client`
        UPDATE capture_media_objects SET protected_until = expires_at + interval '1 day' WHERE id = 'obj-1'
      `,
    );
    expect(message).toContain('capture_objects_protected_until_check');
  });

  it('bounds retention extensions to a countable number', async () => {
    const message = await statementFailure(
      () => suite!.client`UPDATE capture_media_objects SET retention_extension_count = 4 WHERE id = 'obj-1'`,
    );
    expect(message).toContain('capture_objects_extension_count_check');
  });

  it('refuses a published artifact class in the capture object table', async () => {
    // The class set here is the CAPTURE subset. A `published_splat` row would be
    // a published scene inheriting a raw upload's expiry, which is precisely the
    // confusion #10 spends a section warning about.
    const message = await statementFailure(
      () => suite!.client`UPDATE capture_media_objects SET retention_class = 'published_splat' WHERE id = 'obj-1'`,
    );
    expect(message).toContain('capture_objects_retention_class_check');
  });

  it('refuses a tombstone that does not say why', async () => {
    const message = await statementFailure(
      () => suite!.client`
        UPDATE capture_media_objects SET storage_state = 'deleted', deleted_at = now() WHERE id = 'obj-1'
      `,
    );
    expect(message).toContain('capture_objects_tombstone_check');
  });
});

describe('deduplication', () => {
  it('refuses a SECOND live object for the same content hash', async () => {
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_media_objects
          (id, content_hash, object_key, content_type, byte_size, upload_intent_expires_at,
           retention_class, retention_reason, expires_at)
        VALUES
          ('obj-dup', ${hash('a')}, 'captures/dup', 'image/jpeg', 2048,
           now() + interval '15 minutes', 'raw_photo', 'awaiting_privacy_processing',
           now() + interval '90 days')
      `,
    );
    expect(message).toContain('capture_objects_live_content_hash_key');
  });

  it('lets the SAME bytes be contributed again once the first object is deleted', async () => {
    // The other half, and the reason the index is partial. A total unique
    // constraint would pass the test above and refuse this forever — a
    // contributor unable to submit a photo because somebody else submitted it
    // and it expired two months ago.
    await suite!.client`
      INSERT INTO capture_media_objects
        (id, content_hash, object_key, content_type, byte_size, upload_intent_expires_at,
         retention_class, retention_reason, expires_at, storage_state, stored_at,
         deleted_at, deletion_reason)
      VALUES
        ('obj-gone', ${hash('e')}, 'captures/gone', 'image/jpeg', 512,
         now() - interval '90 days', 'raw_photo', 'awaiting_privacy_processing',
         now() + interval '1 day', 'deleted', now() - interval '90 days',
         now() - interval '1 day', 'expired')
    `;
    await suite!.client`
      INSERT INTO capture_media_objects
        (id, content_hash, object_key, content_type, byte_size, upload_intent_expires_at,
         retention_class, retention_reason, expires_at)
      VALUES
        ('obj-again', ${hash('e')}, 'captures/again', 'image/jpeg', 512,
         now() + interval '15 minutes', 'raw_photo', 'awaiting_privacy_processing',
         now() + interval '90 days')
    `;
    const rows = await suite!.client<{ id: string }[]>`
      SELECT id FROM capture_media_objects WHERE content_hash = ${hash('e')} ORDER BY id
    `;
    expect(rows.map((row) => row.id)).toEqual(['obj-again', 'obj-gone']);
  });

  it('refuses two rows claiming the same object path', async () => {
    // Two rows for one stored object would each believe they own its deletion.
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_media_objects
          (id, content_hash, object_key, content_type, byte_size, upload_intent_expires_at,
           retention_class, retention_reason, expires_at)
        VALUES
          ('obj-samepath', ${hash('f')}, 'captures/2026/09/obj-1', 'image/jpeg', 1,
           now() + interval '15 minutes', 'raw_photo', 'awaiting_privacy_processing',
           now() + interval '1 day')
      `,
    );
    expect(message).toContain('capture_objects_object_key_key');
  });

  it('keeps an asset alive when its object becomes a tombstone', async () => {
    // `restrict`, not `cascade`: a published scene's provenance, a contributor's
    // history and a rebuild's blocklist all outlive the pixels.
    const message = await statementFailure(
      () => suite!.client`DELETE FROM capture_media_objects WHERE id = 'obj-1'`,
    );
    expect(message).toMatch(/violates foreign key constraint/);
  });
});

describe('the privacy gate fails closed', () => {
  it('starts shut: a fresh capture is not a reconstruction input', async () => {
    const [row] = await suite!.client<{ privacy_state: string; reconstruction_eligible: boolean }[]>`
      SELECT privacy_state, reconstruction_eligible FROM capture_assets WHERE id = 'asset-1'
    `;
    expect(row?.privacy_state).toBe('pending');
    expect(row?.reconstruction_eligible).toBe(false);
  });

  it('refuses to let an asset ENTER a reconstruction state while the gate is shut', async () => {
    const message = await statementFailure(
      () => suite!.client`UPDATE capture_assets SET state = 'reconstruction_candidate' WHERE id = 'asset-1'`,
    );
    expect(message).toContain('capture_assets_privacy_gate_check');
  });

  it('refuses a pass that does not name the pipeline that produced it', async () => {
    // A clearance nobody can audit or re-run is not a clearance: #13 keeps the
    // version precisely so old scenes can be rebuilt when detection improves.
    const message = await statementFailure(
      () => suite!.client`
        UPDATE capture_assets SET privacy_state = 'passed', privacy_completed_at = now() WHERE id = 'asset-1'
      `,
    );
    expect(message).toContain('capture_assets_privacy_version_check');
  });

  it('refuses to let anything WRITE the eligibility flag', async () => {
    // The flag is GENERATED. This is what makes "no migration, no backfill and
    // no repair script can mark unreviewed pixels usable" a property of the
    // database rather than a rule people follow.
    const message = await statementFailure(
      () => suite!.client`UPDATE capture_assets SET reconstruction_eligible = true WHERE id = 'asset-1'`,
    );
    expect(message).toMatch(/can only be updated to DEFAULT|generated column/i);
  });

  it('opens only when a versioned pass and an accepted state coincide', async () => {
    await suite!.client`
      UPDATE capture_assets
      SET privacy_state = 'passed', privacy_pipeline_version = 'faces-plates-2026.09', privacy_completed_at = now()
      WHERE id = 'asset-1'
    `;
    const [passedButNotAccepted] = await suite!.client<{ reconstruction_eligible: boolean }[]>`
      SELECT reconstruction_eligible FROM capture_assets WHERE id = 'asset-1'
    `;
    // Still shut: the pixels are cleared, but the contribution has not been
    // accepted. Both halves are required.
    expect(passedButNotAccepted?.reconstruction_eligible).toBe(false);

    await suite!.client`UPDATE capture_assets SET state = 'accepted' WHERE id = 'asset-1'`;
    const [open] = await suite!.client<{ reconstruction_eligible: boolean }[]>`
      SELECT reconstruction_eligible FROM capture_assets WHERE id = 'asset-1'
    `;
    expect(open?.reconstruction_eligible).toBe(true);
  });

  it('shuts again the moment a verdict is withdrawn', async () => {
    // A moderation block on an already-cleared capture must take it out of
    // reconstruction immediately, without anything remembering to clear a flag.
    await suite!.client`
      UPDATE capture_assets SET privacy_state = 'blocked', privacy_pipeline_version = NULL WHERE id = 'asset-1'
    `;
    const [row] = await suite!.client<{ reconstruction_eligible: boolean }[]>`
      SELECT reconstruction_eligible FROM capture_assets WHERE id = 'asset-1'
    `;
    expect(row?.reconstruction_eligible).toBe(false);
    await suite!.client`
      UPDATE capture_assets
      SET privacy_state = 'passed', privacy_pipeline_version = 'faces-plates-2026.09'
      WHERE id = 'asset-1'
    `;
  });
});

describe('the anchor and its provenance', () => {
  it('generates the PostGIS point and the bucketing key from the ordinates', async () => {
    // Barcelona, and the point must not be in the Gulf of Guinea or the wrong
    // hemisphere: `ST_MakePoint` takes (lng, lat), the opposite of every
    // `lat, lng` the HTTP layer receives.
    const [row] = await suite!.client<{ point: string; geo_cell: string }[]>`
      SELECT ST_AsText(anchor_geo::geometry) AS point, geo_cell FROM capture_assets WHERE id = 'asset-1'
    `;
    expect(row?.point).toBe('POINT(2.1734 41.3851)');
    // The key is a geohash of the same point. Its PREFIX is what a coarser
    // budget matches on, which is the property that makes one cell column serve
    // every granularity.
    expect(row?.geo_cell).toStartWith('sp3e');
  });

  it('refuses a latitude off the planet even when the HTTP layer is bypassed', async () => {
    // Refused TWICE over, and the message names whichever guard fired first.
    // `ST_GeoHash` in the generated cell expression raises on an out-of-range
    // ordinate before the CHECK is evaluated, so the message here is PostGIS's
    // rather than the constraint's — the row is still refused, which is the
    // guarantee. The CHECK is what protects a future schema that drops the
    // geohash, so it is asserted directly below against a column PostGIS does
    // not read.
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_assets
          (id, session_id, media_object_id, oxy_user_id, media_kind, source,
           anchor_latitude, anchor_longitude, anchor_origin, anchor_witness)
        VALUES
          ('asset-bad', 'sess-1', 'obj-1', 'user-1', 'photo', 'camera',
           120, 0, 'device_capture', 'client')
      `,
    );
    expect(message).toMatch(/capture_assets_latitude_range_check|decimal degrees/);

    // The evidence table carries no generated geography, so the ordinate CHECK
    // is the only thing standing between a backfill and a point PostGIS would
    // happily normalize into somewhere else on Earth.
    const evidence = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_location_evidence (id, asset_id, origin, witness, latitude, longitude)
        VALUES ('ev-bad', 'asset-1', 'device_capture', 'client', 120, 0)
      `,
    );
    expect(evidence).toContain('capture_evidence_latitude_range_check');
  });

  it('refuses GoWay claiming to have witnessed a map tap', async () => {
    // `user_placed` is a human decision made in the app. A row claiming
    // `goway_ingest` produced one is laundering a client's coordinate into a
    // measurement GoWay never made.
    const message = await statementFailure(
      () => suite!.client`
        UPDATE capture_assets SET anchor_origin = 'user_placed', anchor_witness = 'goway_ingest' WHERE id = 'asset-1'
      `,
    );
    expect(message).toContain('capture_assets_user_placed_witness_check');
  });

  it('keeps a client claim and GoWay’s own measurement side by side', async () => {
    // The uniqueness key includes the WITNESS, exactly as `places_capabilities`
    // includes the verification tier: whichever arrives second must not erase
    // the other, because the disagreement is the interesting part.
    await suite!.client`
      INSERT INTO capture_location_evidence (id, asset_id, origin, witness, latitude, longitude)
      VALUES ('ev-client', 'asset-1', 'media_metadata', 'client', 41.3851, 2.1734)
    `;
    await suite!.client`
      INSERT INTO capture_location_evidence (id, asset_id, origin, witness, latitude, longitude)
      VALUES ('ev-ingest', 'asset-1', 'media_metadata', 'goway_ingest', 41.3902, 2.1601)
    `;
    const rows = await suite!.client<{ witness: string }[]>`
      SELECT witness FROM capture_location_evidence
      WHERE asset_id = 'asset-1' AND origin = 'media_metadata' ORDER BY witness
    `;
    expect(rows.map((row) => row.witness)).toEqual(['client', 'goway_ingest']);
  });

  it('refuses a SECOND claim from the same witness about the same origin', async () => {
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_location_evidence (id, asset_id, origin, witness, latitude, longitude)
        VALUES ('ev-dup', 'asset-1', 'media_metadata', 'client', 0, 0)
      `,
    );
    expect(message).toContain('capture_evidence_assertion_key');
  });
});

describe('what the schema refuses to be confused about', () => {
  it('refuses a photo that claims a duration', async () => {
    const message = await statementFailure(
      () => suite!.client`UPDATE capture_assets SET duration_seconds = 12 WHERE id = 'asset-1'`,
    );
    expect(message).toContain('capture_assets_video_fields_check');
  });

  it('refuses a consent version that is blank', async () => {
    // A contribution whose consent is unknown is one GoWay cannot honestly keep.
    const message = await statementFailure(
      () => suite!.client`
        INSERT INTO capture_sessions (id, oxy_user_id, source, consent_version)
        VALUES ('sess-blank', 'user-1', 'camera', '   ')
      `,
    );
    expect(message).toContain('capture_sessions_consent_version_check');
  });

  it('stores a contributor id with NO foreign key — Oxy owns identity', async () => {
    await suite!.client`
      INSERT INTO capture_sessions (id, oxy_user_id, source, consent_version)
      VALUES ('sess-stranger', 'account-never-seen-here', 'library', '2026-09-01')
    `;
    const [row] = await suite!.client<{ oxy_user_id: string }[]>`
      SELECT oxy_user_id FROM capture_sessions WHERE id = 'sess-stranger'
    `;
    expect(row?.oxy_user_id).toBe('account-never-seen-here');
  });

  it('has no table that could hold a user location history', async () => {
    // The privacy boundary, as a structural assertion rather than a comment.
    // Every coordinate in this schema hangs off a submitted asset; nothing is
    // keyed by (user, time, position). If a future table breaks that, this is
    // the test that notices.
    const columns = await suite!.client<{ table_name: string; column_name: string }[]>`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name LIKE 'capture_%'
        AND c.column_name IN ('latitude', 'longitude', 'anchor_latitude', 'anchor_longitude')
      ORDER BY c.table_name, c.column_name
    `;
    const tablesWithPositions = [...new Set(columns.map((column) => column.table_name))];
    expect(tablesWithPositions).toEqual(['capture_assets', 'capture_location_evidence']);

    // And neither of those carries a contributor column beside its position —
    // `capture_assets.oxy_user_id` is authorship, and it is the ONE such column.
    const contributorColumns = await suite!.client<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name LIKE 'capture_%' AND column_name = 'oxy_user_id'
      ORDER BY table_name
    `;
    expect(contributorColumns.map((row) => row.table_name)).toEqual(['capture_assets', 'capture_sessions']);
  });
});
