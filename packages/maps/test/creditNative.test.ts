import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

it('reports native layout to both the map and its optional shared subscriber', () => {
  // The probe replaces React Native modules, so isolate its mocks from every
  // other maps test in this Bun process.
  expect(() =>
    execFileSync(process.execPath, [
      'run',
      join(import.meta.dir, 'fixtures/credit-native-probe.ts'),
    ]),
  ).not.toThrow();
});
