/**
 * The routing configuration parser.
 *
 * Every case hands `parseRoutingConfig` its OWN source object. Nothing here
 * mutates `process.env` — a mutation leaks into every other test in the same
 * worker and the leak is order-dependent, which is the worst shape a flake can
 * take. That is the entire reason the parser takes a source argument.
 *
 * The load-bearing case is the FIRST one: an empty environment must parse, and
 * must parse as "no engine". Routing is the only part of this API that a
 * deployment may legitimately not have, and making it required would mean a
 * backend that serves the map, Places and search refuses to boot because
 * nobody stood up a router.
 */

import '../../__tests__/testEnv';
import { describe, expect, it } from 'bun:test';
import type { EnvironmentSource } from '../index';
import { parseRoutingConfig } from '../routing';

const CONFIGURED: EnvironmentSource = { ROUTING_VALHALLA_URL: 'https://valhalla.example/route' };

describe('parseRoutingConfig', () => {
  it('parses an empty environment as "this deployment has no routing engine"', () => {
    const settings = parseRoutingConfig({});
    expect(settings.enabled).toBe(false);
    expect(settings.valhallaUrl).toBeUndefined();
    expect(settings.provider).toBe('valhalla');
    expect(settings.timeoutMs).toBe(10_000);
    expect(settings.maxAlternatives).toBe(2);
    expect(settings.modes).toEqual(['drive', 'walk', 'bike']);
    expect(settings.userAgent).toContain('GoWay');
  });

  it('ships no default endpoint', () => {
    // AGENTS.md: never hardcode a development endpoint into product code. Issue
    // #6 is sharper still — do not call a public community Valhalla demo from
    // consumer applications. A demo instance is a line in somebody's .env.
    const settings = parseRoutingConfig({});
    expect(settings.valhallaUrl).toBeUndefined();
    // The only URL an unconfigured routing layer knows is GoWay's own canonical
    // origin, in the user agent it identifies itself with.
    const urls = JSON.stringify(settings).match(/https?:\/\/[^"' )]+/g) ?? [];
    expect(urls).toEqual(['https://goway.to']);
  });

  it('takes the FULL route endpoint, so a hosted prefix needs no special case', () => {
    const settings = parseRoutingConfig({
      ROUTING_VALHALLA_URL: 'https://api.example.com/valhalla/route/v1/',
    });
    expect(settings.enabled).toBe(true);
    expect(settings.valhallaUrl).toBe('https://api.example.com/valhalla/route/v1');
  });

  it('refuses an endpoint carrying credentials, a query or a fragment', () => {
    // Any of the three ends up in a connection error's message, which is one
    // `logger.error({ err })` away from an aggregator's index.
    expect(() => parseRoutingConfig({ ROUTING_VALHALLA_URL: 'https://a:b@valhalla.example/route' })).toThrow(
      /valhallaUrl/,
    );
    expect(() =>
      parseRoutingConfig({ ROUTING_VALHALLA_URL: 'https://valhalla.example/route?api_key=leaked' }),
    ).toThrow(/valhallaUrl/);
    expect(() => parseRoutingConfig({ ROUTING_VALHALLA_URL: 'ftp://valhalla.example/route' })).toThrow(
      /valhallaUrl/,
    );
  });

  it('treats an empty string as absent so a default can apply', () => {
    // A shell exports an empty string for a variable set to nothing, which zod
    // sees as a present value.
    const settings = parseRoutingConfig({
      ROUTING_VALHALLA_URL: '',
      ROUTING_TIMEOUT_MS: '',
      ROUTING_MODES: '',
      ROUTING_USER_AGENT: '',
      ROUTING_VALHALLA_API_KEY: '',
    });
    expect(settings.enabled).toBe(false);
    expect(settings.timeoutMs).toBe(10_000);
    expect(settings.modes).toEqual(['drive', 'walk', 'bike']);
    expect(settings.valhallaApiKey).toBeUndefined();
  });

  it('narrows the offered modes, so a deployment can say what it cannot route', () => {
    const settings = parseRoutingConfig({ ...CONFIGURED, ROUTING_MODES: 'drive, walk' });
    expect(settings.modes).toEqual(['drive', 'walk']);
  });

  it('refuses a mode that is not in the contract', () => {
    expect(() => parseRoutingConfig({ ...CONFIGURED, ROUTING_MODES: 'drive,helicopter' })).toThrow(
      /modes/,
    );
  });

  it('reads a list of nothing but separators as absent, so the default applies', () => {
    // The same rule the rest of the configuration follows: a shell spells
    // "unset" as an empty value, and an empty mode list would otherwise mean a
    // deployment that routes nothing at all.
    expect(parseRoutingConfig({ ...CONFIGURED, ROUTING_MODES: ',,' }).modes).toEqual([
      'drive',
      'walk',
      'bike',
    ]);
  });

  it('bounds the timeout rather than accepting any number a shell offers', () => {
    expect(parseRoutingConfig({ ...CONFIGURED, ROUTING_TIMEOUT_MS: '2500' }).timeoutMs).toBe(2500);
    expect(() => parseRoutingConfig({ ...CONFIGURED, ROUTING_TIMEOUT_MS: '0' })).toThrow(/timeoutMs/);
    expect(() => parseRoutingConfig({ ...CONFIGURED, ROUTING_TIMEOUT_MS: '600000' })).toThrow(
      /timeoutMs/,
    );
    expect(() => parseRoutingConfig({ ...CONFIGURED, ROUTING_TIMEOUT_MS: 'soon' })).toThrow(/timeoutMs/);
  });

  it('accepts zero alternatives, which switches the feature off', () => {
    expect(parseRoutingConfig({ ...CONFIGURED, ROUTING_MAX_ALTERNATIVES: '0' }).maxAlternatives).toBe(0);
    expect(() => parseRoutingConfig({ ...CONFIGURED, ROUTING_MAX_ALTERNATIVES: '50' })).toThrow(
      /maxAlternatives/,
    );
  });

  it('refuses an engine it does not know how to drive', () => {
    expect(() => parseRoutingConfig({ ...CONFIGURED, ROUTING_PROVIDER: 'osrm' })).toThrow(/provider/);
  });

  it('names every bad variable at once, not just the first', () => {
    // A deployment with three bad values should take one round trip to fix.
    let message = '';
    try {
      parseRoutingConfig({ ROUTING_VALHALLA_URL: 'nonsense', ROUTING_TIMEOUT_MS: '0', ROUTING_MODES: 'fly' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('valhallaUrl');
    expect(message).toContain('timeoutMs');
    expect(message).toContain('modes');
  });
});
