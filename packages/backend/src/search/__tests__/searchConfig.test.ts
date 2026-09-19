/**
 * The search configuration parser.
 *
 * Every case hands `parseSearchConfig` its OWN source object. Nothing here
 * mutates `process.env` — a mutation leaks into every other test in the same
 * worker, order-dependently, which is the worst shape a flake can take.
 */

import { describe, expect, it } from 'bun:test';
import { parseSearchConfig, type EnvironmentSource } from '../../config/search';

const EMPTY: EnvironmentSource = {};

describe('parseSearchConfig', () => {
  it('defaults to Photon alone', () => {
    const config = parseSearchConfig(EMPTY);
    // Nominatim is absent deliberately: its public instance forbids
    // autocomplete, so an operator enables it for explicit lookups knowingly.
    expect(config.providers).toEqual(['photon']);
    expect(config.photon.baseUrl).toBe('https://photon.komoot.io');
    expect(config.nominatim.baseUrl).toBe('https://nominatim.openstreetmap.org');
    expect(config.nominatim.userAgent).toContain('GoWay');
    expect(config.nominatim.email).toBeUndefined();
    expect(config.timeoutMs).toBe(4_000);
    // No retry by default: a retry inside a keystroke doubles the wait.
    expect(config.attempts).toBe(1);
    expect(config.defaultLimit).toBe(10);
    expect(config.maxLimit).toBe(25);
  });

  it('reads an ordered, de-duplicated provider list', () => {
    expect(parseSearchConfig({ SEARCH_PROVIDERS: 'nominatim, photon ,nominatim' }).providers).toEqual([
      'nominatim',
      'photon',
    ]);
  });

  it('refuses a provider it has no adapter for', () => {
    expect(() => parseSearchConfig({ SEARCH_PROVIDERS: 'google' })).toThrow(/providers/);
  });

  it('treats an empty value as unset so the default applies', () => {
    const config = parseSearchConfig({ SEARCH_PROVIDERS: '', SEARCH_TIMEOUT_MS: '', SEARCH_PHOTON_BASE_URL: '' });
    expect(config.providers).toEqual(['photon']);
    expect(config.timeoutMs).toBe(4_000);
    expect(config.photon.baseUrl).toBe('https://photon.komoot.io');
  });

  it('accepts a self-hosted instance behind a path and trims the trailing slash', () => {
    const config = parseSearchConfig({ SEARCH_PHOTON_BASE_URL: 'https://maps.example.com/photon/' });
    expect(config.photon.baseUrl).toBe('https://maps.example.com/photon');
  });

  it('refuses a base URL carrying credentials, a query or a fragment', () => {
    expect(() => parseSearchConfig({ SEARCH_PHOTON_BASE_URL: 'https://user:pass@maps.example.com' })).toThrow();
    expect(() => parseSearchConfig({ SEARCH_PHOTON_BASE_URL: 'https://maps.example.com?key=abc' })).toThrow();
    expect(() => parseSearchConfig({ SEARCH_PHOTON_BASE_URL: 'ftp://maps.example.com' })).toThrow();
  });

  it('bounds the retry count so no configuration can express an infinite retry', () => {
    expect(parseSearchConfig({ SEARCH_UPSTREAM_ATTEMPTS: '3' }).attempts).toBe(3);
    expect(() => parseSearchConfig({ SEARCH_UPSTREAM_ATTEMPTS: '99' })).toThrow(/attempts/);
  });

  it('refuses a default limit above the maximum', () => {
    expect(() => parseSearchConfig({ SEARCH_DEFAULT_LIMIT: '40', SEARCH_MAX_LIMIT: '20' })).toThrow(
      /defaultLimit/,
    );
  });

  it('reads the Photon language whitelist', () => {
    expect(parseSearchConfig({ SEARCH_PHOTON_LANGUAGES: 'en,es' }).photon.languages).toEqual(['en', 'es']);
    expect(() => parseSearchConfig({ SEARCH_PHOTON_LANGUAGES: 'english' })).toThrow(/photonLanguages/);
  });

  it('carries the Nominatim contact address the usage policy asks for', () => {
    const config = parseSearchConfig({
      SEARCH_NOMINATIM_USER_AGENT: 'GoWay/1.0 (+https://goway.to)',
      SEARCH_NOMINATIM_EMAIL: 'ops@goway.to',
    });
    expect(config.nominatim.userAgent).toBe('GoWay/1.0 (+https://goway.to)');
    expect(config.nominatim.email).toBe('ops@goway.to');
  });

  it('allows the cache to be switched off', () => {
    const config = parseSearchConfig({ SEARCH_CACHE_TTL_SECONDS: '0', SEARCH_CACHE_MAX_ENTRIES: '0' });
    expect(config.cacheTtlSeconds).toBe(0);
    expect(config.cacheMaxEntries).toBe(0);
  });
});
