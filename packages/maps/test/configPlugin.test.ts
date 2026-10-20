/**
 * The Expo config plugin loads and hands an app's config to MapLibre Native's
 * own plugin. A plugin that cannot load fails `expo start` and every build
 * before anything renders, so it is exercised here rather than trusted.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('@goway.to/maps/app.plugin.js', () => {
  test('is a config plugin that returns the config it was given, extended', () => {
    const plugin = require('../app.plugin.js') as (
      config: Record<string, unknown>,
      props?: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(typeof plugin).toBe('function');
    const config = plugin({ name: 'probe', slug: 'probe' });
    expect(config.name).toBe('probe');
    expect(config.slug).toBe('probe');
  });
});
