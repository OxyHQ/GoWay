import { defineConfig } from 'vitest/config';

/**
 * The SDK's unit suite. Node environment, no network: every request goes to a
 * `fetch` double (`test/helpers.ts`). vitest rather than `bun test` because
 * running under Node is the stricter check for a package whose consumers
 * include Node backends — Bun is more forgiving about globals than the runtime
 * this package promises to support.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
