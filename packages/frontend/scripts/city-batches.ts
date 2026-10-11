/**
 * The planet workflow's job matrix: the selected regions, packed into build
 * jobs (`.github/workflows/build-city-tiles.yml`).
 *
 * ```bash
 * bun packages/frontend/scripts/city-batches.ts --regions=europe/portugal,europe/spain/
 * # → batches=[{"index":1,"regions":"europe/portugal …","bytes":…}, …]
 * ```
 *
 * Prints GitHub Actions output lines. Imports nothing but the catalogue, so
 * it runs before `bun install`.
 */
import { batchRegions, selectRegions } from './citygen/regions';

/** Extract bytes per job: ~15 minutes of download and compile on a hosted runner. */
const TARGET_BATCH_BYTES = 2e9;

/** GitHub's limit on one matrix. */
const MAX_BATCHES = 256;

const selector =
  process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--regions='))
    ?.slice('--regions='.length) ?? '';
const regions = selectRegions(selector);
const batches = batchRegions(regions, TARGET_BATCH_BYTES, MAX_BATCHES).map((batch, i) => ({
  index: i + 1,
  regions: batch.map((region) => region.id).join(' '),
  bytes: batch.reduce((sum, region) => sum + region.pbfBytes, 0),
}));
const total = regions.reduce((sum, region) => sum + region.pbfBytes, 0);
console.log(`batches=${JSON.stringify(batches)}`);
console.log(`count=${regions.length}`);
console.error(
  `${regions.length} regions, ${(total / 1e9).toFixed(1)} GB of extracts, in ${batches.length} jobs`,
);
