/**
 * Stub every Bloom icon `categories.ts` draws with, so the REAL module loads
 * under Bun.
 *
 * Bloom's Remix icons reach `react-native` and `react-native-svg` — Flow-typed
 * sources Bun cannot parse. Each icon module is replaced by a component that
 * renders nothing and carries its own name, read from `categories.ts`'s own
 * import list so a new icon cannot slip past the stub. Stubbing the icons,
 * rather than `categories.ts` itself, matters: `mock.module` lasts for the
 * whole run, and a stubbed `categories` would be what every later test file
 * imported too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'bun:test';

export function stubCategoryIcons(): void {
  const source = readFileSync(join(import.meta.dir, '..', 'categories.ts'), 'utf8');
  for (const [, name] of source.matchAll(/from '@oxy\.so\/bloom\/icons\/(\w+)'/g)) {
    const icon = Object.assign(() => null, { displayName: name });
    mock.module(`@oxy.so/bloom/icons/${name}`, () => ({ [name as string]: icon }));
  }
}
