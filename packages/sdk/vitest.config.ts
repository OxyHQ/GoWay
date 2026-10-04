import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The SDK's unit suite. Node environment, no network: every request goes to a
 * `fetch` double (`test/helpers.ts`). vitest rather than `bun test` because
 * running under Node is the stricter check for a package whose consumers
 * include Node backends — Bun is more forgiving about globals than the runtime
 * this package promises to support.
 *
 * `@goway/contracts` resolves to its SOURCE, as it does for `tsc` and the build
 * (`tsconfig.json` `paths`): a suite that read the contract package's compiled
 * `dist/` would test whatever was last built rather than the contract as it is.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@goway/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
