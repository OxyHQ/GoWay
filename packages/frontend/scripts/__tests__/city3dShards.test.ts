/** Which visibility-gate checks a CI shard runs (`scripts/city3dShards.ts`). */
import { expect, test } from 'bun:test';

import { CHECK_NAMES, shardChecks } from '../city3dShards';

test('every check runs in exactly one shard, however many there are', () => {
  for (let total = 1; total <= CHECK_NAMES.length + 1; total++) {
    const runs = Array.from({ length: total }, (_, index) => shardChecks(index, total)).flat();
    expect(runs.toSorted()).toEqual(CHECK_NAMES.toSorted());
  }
  expect(() => shardChecks(5, 5)).toThrow();
});
