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
import { parseRoutingConfig } from '../routing';

describe('parseRoutingConfig', () => {
  it('parses an empty environment as "this deployment has no routing engine"', () => {
    const settings = parseRoutingConfig({});
    expect(settings.enabled).toBe(false);
    expect(settings.valhallaUrl).toBeUndefined();
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
    expect(() =>
      parseRoutingConfig({ ROUTING_VALHALLA_URL: 'https://a:b@valhalla.example/route' }),
    ).toThrow(/valhallaUrl/);
    expect(() =>
      parseRoutingConfig({ ROUTING_VALHALLA_URL: 'https://valhalla.example/route?api_key=leaked' }),
    ).toThrow(/valhallaUrl/);
    expect(() =>
      parseRoutingConfig({ ROUTING_VALHALLA_URL: 'ftp://valhalla.example/route' }),
    ).toThrow(/valhallaUrl/);
  });

  it('treats an empty string as absent', () => {
    // A shell exports an empty string for a variable set to nothing, which zod
    // sees as a present value.
    const settings = parseRoutingConfig({ ROUTING_VALHALLA_URL: '', ROUTING_VALHALLA_API_KEY: '' });
    expect(settings.enabled).toBe(false);
    expect(settings.valhallaApiKey).toBeUndefined();
  });

  it('ignores the retired tuning variables a task definition may still carry', () => {
    const configured = { ROUTING_VALHALLA_URL: 'https://valhalla.example/route' };
    expect(
      parseRoutingConfig({
        ...configured,
        ROUTING_PROVIDER: 'osrm',
        ROUTING_TIMEOUT_MS: '0',
        ROUTING_MODES: 'drive',
        ROUTING_MAX_ALTERNATIVES: '50',
        ROUTING_USER_AGENT: 'someone else',
      }),
    ).toEqual(parseRoutingConfig(configured));
  });
});
