/**
 * The search configuration parser.
 *
 * Every case hands `parseSearchConfig` its OWN source object. Nothing here
 * mutates `process.env` — a mutation leaks into every other test in the same
 * worker, order-dependently, which is the worst shape a flake can take.
 */

import { describe, expect, it } from 'bun:test';
import { parseSearchConfig, type EnvironmentSource } from '../../config/search';
import { createProviders } from '../providers';

const EMPTY: EnvironmentSource = {};

describe('parseSearchConfig', () => {
  it('defaults to Photon alone, on the policy in code', () => {
    const config = parseSearchConfig(EMPTY);
    expect(config.photon.baseUrl).toBe('https://photon.komoot.io');
    // Nominatim is absent deliberately: its public instance forbids
    // autocomplete, so an operator enables it for explicit lookups knowingly.
    expect(config.nominatim).toBeNull();
    expect(createProviders({ config }).map((provider) => provider.id)).toEqual(['photon']);
    expect(config.timeoutMs).toBe(4_000);
    // No retry: a retry inside a keystroke doubles the wait.
    expect(config.attempts).toBe(1);
    expect(config.defaultLimit).toBe(10);
    expect(config.maxLimit).toBe(25);
  });

  it('turns Nominatim on when an instance is named, after Photon', () => {
    const config = parseSearchConfig({
      SEARCH_NOMINATIM_BASE_URL: 'https://nominatim.example.com/',
      SEARCH_NOMINATIM_EMAIL: 'ops@goway.to',
    });
    expect(config.nominatim).toEqual({
      baseUrl: 'https://nominatim.example.com',
      userAgent: expect.stringContaining('GoWay'),
      email: 'ops@goway.to',
    });
    expect(createProviders({ config }).map((provider) => provider.id)).toEqual([
      'photon',
      'nominatim',
    ]);
  });

  it('treats an empty value as unset so the default applies', () => {
    const config = parseSearchConfig({
      SEARCH_PHOTON_BASE_URL: '',
      SEARCH_NOMINATIM_BASE_URL: '',
      SEARCH_PHOTON_LANGUAGES: ' ',
    });
    expect(config.photon.baseUrl).toBe('https://photon.komoot.io');
    expect(config.photon.languages).toEqual(['de', 'en', 'fr', 'it']);
    expect(config.nominatim).toBeNull();
  });

  it('accepts a self-hosted instance behind a path and trims the trailing slash', () => {
    const config = parseSearchConfig({
      SEARCH_PHOTON_BASE_URL: 'https://maps.example.com/photon/',
    });
    expect(config.photon.baseUrl).toBe('https://maps.example.com/photon');
  });

  it('refuses a base URL carrying credentials, a query or a fragment', () => {
    expect(() =>
      parseSearchConfig({ SEARCH_PHOTON_BASE_URL: 'https://user:pass@maps.example.com' }),
    ).toThrow();
    expect(() =>
      parseSearchConfig({ SEARCH_PHOTON_BASE_URL: 'https://maps.example.com?key=abc' }),
    ).toThrow();
    expect(() => parseSearchConfig({ SEARCH_PHOTON_BASE_URL: 'ftp://maps.example.com' })).toThrow();
    expect(() =>
      parseSearchConfig({ SEARCH_NOMINATIM_BASE_URL: 'https://nominatim.example.com#x' }),
    ).toThrow(/nominatimBaseUrl/);
  });

  it('reads the Photon language whitelist', () => {
    expect(parseSearchConfig({ SEARCH_PHOTON_LANGUAGES: 'en,es' }).photon.languages).toEqual([
      'en',
      'es',
    ]);
    expect(() => parseSearchConfig({ SEARCH_PHOTON_LANGUAGES: 'english' })).toThrow(
      /photonLanguages/,
    );
  });

  it('ignores the retired provider list and tuning variables a deployment may still carry', () => {
    const retired = parseSearchConfig({
      SEARCH_PROVIDERS: 'nominatim',
      SEARCH_TIMEOUT_MS: '0',
      SEARCH_UPSTREAM_ATTEMPTS: '99',
      SEARCH_DEFAULT_LIMIT: '40',
      SEARCH_MAX_LIMIT: '20',
      SEARCH_CACHE_TTL_SECONDS: '0',
      SEARCH_NOMINATIM_USER_AGENT: 'somebody else',
    });
    expect(retired).toEqual(parseSearchConfig(EMPTY));
  });
});
