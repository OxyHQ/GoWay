/**
 * The geography column and the spatial predicates, MEASURED rather than
 * inspected.
 *
 * Four things about GoWay's geography fail SILENTLY if they are wrong, and not
 * one of them raises an error:
 *
 *  - **Ordinate order.** GeoJSON stores `[lng, lat]`, `ST_MakePoint` takes
 *    `(lng, lat)`, and every HTTP parameter arrives as `lat, lng`. Swap them
 *    and every position is still a valid point, every query still returns rows,
 *    and every place is in the wrong hemisphere. Only a REAL distance against
 *    landmarks whose separation is public knowledge catches it — which is why
 *    this file uses Barcelona, Madrid and Lisbon rather than synthetic points a
 *    swapped implementation would satisfy just as well.
 *  - **Index usage.** `ST_DWithin` in a WHERE clause is index-backed;
 *    `ST_Distance(...) < r` is not, and degrades to a scan of every place on
 *    Earth. Both return identical rows, so only the plan tells them apart.
 *  - **Ordering.** A query that returns the right rows in the wrong order still
 *    returns rows. With a `LIMIT`, wrong order means the wrong places are on
 *    the map.
 *  - **The antimeridian.** `west > east` is how a Pacific box is spelled.
 *    Without the `::geography` cast the same query returns the exact COMPLEMENT
 *    of what was asked for — the whole planet except the strip.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { statementFailure } from './statementFailure';
import { SUITE_SETUP_TIMEOUT_MS, createSuiteDatabase, destroySuiteDatabase, type SuiteDatabase } from './testDatabase';

/** Real places, so a real distance can be asserted. `[lat, lng]` — named below. */
const BARCELONA = { latitude: 41.4036, longitude: 2.1744 };
const MADRID = { latitude: 40.4168, longitude: -3.7038 };
const LISBON = { latitude: 38.7223, longitude: -9.1393 };

/**
 * Measured against `postgis/postgis:17-3.5`, and independently checkable: these
 * are the published great-circle distances between the three city centres.
 *
 * The TRANSPOSED pair — latitude and longitude swapped — puts Madrid and
 * Barcelona 659 km apart instead of 507 km. A 15 km tolerance cannot absorb
 * that, which is the entire point of choosing a tolerance this tight.
 */
const MADRID_BARCELONA_M = 507_000;
const MADRID_LISBON_M = 503_000;
const TOLERANCE_M = 15_000;

let suite: SuiteDatabase | null = null;

async function seedPlace(id: string, name: string, at: { latitude: number; longitude: number }): Promise<void> {
  await suite!.client`
    INSERT INTO places (id, name, latitude, longitude)
    VALUES (${id}, ${name}, ${at.latitude}, ${at.longitude})
  `;
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  // Seeded in an order that is NEITHER the distance order nor its reverse, so a
  // query that ignores ordering entirely cannot pass by accident of insertion.
  await seedPlace('place-barcelona', 'Sagrada Família', BARCELONA);
  await seedPlace('place-madrid', 'Puerta del Sol', MADRID);
  await seedPlace('place-lisbon', 'Praça do Comércio', LISBON);
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('the generated geography point', () => {
  it('stores (longitude, latitude) in the order PostGIS reads it, proven by a real distance', async () => {
    const [row] = await suite!.client<{ meters: number }[]>`
      SELECT ST_Distance(
        (SELECT geo FROM places WHERE id = 'place-madrid'),
        (SELECT geo FROM places WHERE id = 'place-barcelona')
      ) AS meters
    `;
    expect(row?.meters).toBeGreaterThan(MADRID_BARCELONA_M - TOLERANCE_M);
    expect(row?.meters).toBeLessThan(MADRID_BARCELONA_M + TOLERANCE_M);
  });

  it('reads back as a Point at SRID 4326 — the typmod drizzle-kit cannot emit', async () => {
    // `geography()` is declared BARE because drizzle-kit 0.31.10's `parseType`
    // quotes any type name outside a hardcoded list and `geography` is not on
    // it, so a `(Point,4326)` typmod never reaches the DDL. The typmod would
    // only constrain writes and this column is GENERATED — nothing writes it —
    // so the claim it would have made is asserted HERE, against a real row.
    const [row] = await suite!.client<{ type: string; srid: number }[]>`
      SELECT ST_GeometryType(geo::geometry) AS type, ST_SRID(geo) AS srid
      FROM places WHERE id = 'place-madrid'
    `;
    expect(row?.type).toBe('ST_Point');
    expect(row?.srid).toBe(4326);
  });

  it('refuses to be written directly', async () => {
    // The column is the single source of truth for a position precisely
    // because it cannot be set independently of its two ordinates. A schema
    // where both are writable has two representations of one fact that can
    // disagree, and the disagreement is invisible.
    const message = await statementFailure(
      () => suite!.client`UPDATE places SET geo = NULL WHERE id = 'place-madrid'`,
    );
    expect(message).toMatch(/can only be updated to DEFAULT/);
  });

  it('follows its ordinates rather than keeping a stale copy', async () => {
    await suite!.client`
      INSERT INTO places (id, name, latitude, longitude) VALUES ('place-moved', 'Moved', 40.4168, -3.7038)
    `;
    await suite!.client`
      UPDATE places SET latitude = ${BARCELONA.latitude}, longitude = ${BARCELONA.longitude}
      WHERE id = 'place-moved'
    `;
    const [row] = await suite!.client<{ meters: number }[]>`
      SELECT ST_Distance(
        (SELECT geo FROM places WHERE id = 'place-moved'),
        (SELECT geo FROM places WHERE id = 'place-barcelona')
      ) AS meters
    `;
    expect(row?.meters).toBeLessThan(1);
    await suite!.client`DELETE FROM places WHERE id = 'place-moved'`;
  });
});

describe('the radius predicate', () => {
  it('orders nearest-first, finely enough to separate two cities 3 km apart in distance', async () => {
    const rows = await suite!.client<{ id: string; meters: number }[]>`
      SELECT id,
             ST_Distance(geo, ST_SetSRID(ST_MakePoint(${MADRID.longitude}, ${MADRID.latitude}), 4326)::geography) AS meters
      FROM places
      WHERE ST_DWithin(geo, ST_SetSRID(ST_MakePoint(${MADRID.longitude}, ${MADRID.latitude}), 4326)::geography, 600000)
      ORDER BY ST_Distance(geo, ST_SetSRID(ST_MakePoint(${MADRID.longitude}, ${MADRID.latitude}), 4326)::geography)
    `;

    expect(rows.map((row) => row.id)).toEqual(['place-madrid', 'place-lisbon', 'place-barcelona']);

    // Lisbon before Barcelona is a 3.7 km difference over ~505 km. Asserted
    // explicitly because it is what makes the ordering claim real: anything
    // coarser — name order, insertion order, a rounded distance — would satisfy
    // a two-city test and fail this one.
    expect(rows[1]?.meters).toBeLessThan(rows[2]?.meters ?? 0);
    expect(rows[1]?.meters).toBeGreaterThan(MADRID_LISBON_M - TOLERANCE_M);
  });

  it('EXCLUDES places outside the radius rather than merely ranking them last', async () => {
    const rows = await suite!.client<{ id: string }[]>`
      SELECT id FROM places
      WHERE ST_DWithin(geo, ST_SetSRID(ST_MakePoint(${MADRID.longitude}, ${MADRID.latitude}), 4326)::geography, 100000)
    `;
    expect(rows.map((row) => row.id)).toEqual(['place-madrid']);
  });

  it('is answered by the GiST index, and the ST_Distance form is NOT', async () => {
    // The measurement that justifies the rule the repository is written to.
    // `enable_seqscan = off` asks the planner whether the index CAN serve the
    // predicate at all — on a three-row table it would otherwise always prefer
    // a scan, and the test would prove nothing either way.
    const plan = async (predicate: string): Promise<string> => {
      const rows = await suite!.client.unsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN (COSTS OFF) SELECT id FROM places WHERE ${predicate}`,
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    };
    const point = `ST_SetSRID(ST_MakePoint(${MADRID.longitude}, ${MADRID.latitude}), 4326)::geography`;

    await suite!.client.unsafe('SET enable_seqscan = off');
    try {
      expect(await plan(`ST_DWithin(geo, ${point}, 1000)`)).toContain('places_geo_gist');
      // The whole reason `ST_Distance` never appears in a WHERE clause in this
      // codebase: identical rows, a sequential scan over every place on Earth.
      expect(await plan(`ST_Distance(geo, ${point}) < 1000`)).toContain('Seq Scan');
    } finally {
      await suite!.client.unsafe('RESET enable_seqscan');
    }
  });
});

describe('the bounding-box predicate', () => {
  it('reads ST_MakeEnvelope as (west, south, east, north) — longitude FIRST', async () => {
    // A box over Catalonia. With the arguments transposed this is a valid
    // envelope somewhere in the Indian Ocean and returns nothing, which is why
    // the negative control below matters as much as the positive one.
    const inside = await suite!.client<{ id: string }[]>`
      SELECT id FROM places
      WHERE ST_Intersects(geo, ST_MakeEnvelope(1.0, 41.0, 3.0, 42.0, 4326)::geography)
    `;
    expect(inside.map((row) => row.id)).toEqual(['place-barcelona']);

    const transposed = await suite!.client<{ id: string }[]>`
      SELECT id FROM places
      WHERE ST_Intersects(geo, ST_MakeEnvelope(41.0, 1.0, 42.0, 3.0, 4326)::geography)
    `;
    expect(transposed.map((row) => row.id)).toEqual([]);
  });

  it('reads west > east as an ANTIMERIDIAN WRAP, not as its complement', async () => {
    // `170 → -170` is the 20° Pacific strip. Without the `::geography` cast
    // this same query returns everything EXCEPT that strip — silently, and with
    // Madrid, Barcelona and Lisbon in the answer.
    await suite!.client`
      INSERT INTO places (id, name, latitude, longitude) VALUES ('place-fiji', 'Suva', -18.1416, 178.4419)
    `;
    const wrapped = await suite!.client<{ id: string }[]>`
      SELECT id FROM places
      WHERE ST_Intersects(geo, ST_MakeEnvelope(170.0, -25.0, -170.0, -10.0, 4326)::geography)
    `;
    expect(wrapped.map((row) => row.id)).toEqual(['place-fiji']);
  });
});
