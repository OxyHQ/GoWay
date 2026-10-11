/**
 * Readiness and deploy phases.
 *
 * The deploy runs pre phase → rollout → post phase, and the load balancer
 * gates the rollout on `GET /ready`. If readiness refused pending `post`
 * migrations, no release shipping one could ever roll out: the post phase waits
 * for the very rollout the probe blocks. That is exactly how the
 * places-platform release first failed in production.
 */

import '../../__tests__/testEnv';
import { describe, expect, it } from 'bun:test';
import { onlyPostPhasePending } from '../postgres';

const PHASES = new Map([
  ['0010_goway_claim_retier', 'pre'],
  ['0011_goway_place_data_conversion', 'post'],
  ['0012_goway_drop_claim_brand', 'post'],
] as const);

describe('onlyPostPhasePending', () => {
  it('is ready while only post migrations wait for the post phase', () => {
    expect(
      onlyPostPhasePending(
        [{ tag: '0011_goway_place_data_conversion' }, { tag: '0012_goway_drop_claim_brand' }],
        PHASES,
      ),
    ).toBe(true);
  });

  it('is not ready while a pre migration is pending', () => {
    expect(
      onlyPostPhasePending(
        [{ tag: '0010_goway_claim_retier' }, { tag: '0011_goway_place_data_conversion' }],
        PHASES,
      ),
    ).toBe(false);
  });

  it('is not ready for a migration with no readable phase', () => {
    expect(onlyPostPhasePending([{ tag: '9999_unknown' }], PHASES)).toBe(false);
  });

  it('reads the phases of the migrations this build actually ships', () => {
    // Production's state right after the places-platform pre phase.
    expect(
      onlyPostPhasePending([
        { tag: '0011_goway_place_data_conversion' },
        { tag: '0012_goway_drop_claim_brand' },
        { tag: '0013_goway_category_taxonomy' },
      ]),
    ).toBe(true);
  });

  it('holds a rollout back until the category-tables pre phase has run', () => {
    // From production's 0013 ledger: capture projection and the category tables,
    // seed and CHECK drop are all pre, so none of them may be pending at rollout.
    const release = [
      { tag: '0014_goway_capture_projection' },
      { tag: '0015_goway_category_tables' },
      { tag: '0016_goway_category_seed' },
      { tag: '0017_goway_drop_category_check' },
    ];
    expect(onlyPostPhasePending(release)).toBe(false);
    for (const entry of release) expect(onlyPostPhasePending([entry])).toBe(false);
  });
});
