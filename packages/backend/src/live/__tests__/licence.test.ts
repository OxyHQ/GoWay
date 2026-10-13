/**
 * AGENTS.md: GoWay Live re-serves only feeds whose licence allows public,
 * commercial redistribution. Every catalogue entry must say how that was
 * established — the day, the page, the words — and a keyed one where the
 * owner registers. An entry without them fails here.
 */
import { describe, expect, it } from 'bun:test';
import { liveLinkSchema, liveSourceIdSchema } from '@goway/contracts';
import { LIVE_SOURCES } from '../catalogue';
import { LIVE_PROVIDERS } from '../providers';

const https = (value: string) => /^https:\/\/[^\s]+$/.test(value);

describe('every live source has a verified licence', () => {
  for (const source of LIVE_SOURCES) {
    it(source.id, () => {
      const check = source.licenceCheck;
      expect({ id: source.id, date: /^\d{4}-\d{2}-\d{2}$/.test(check?.verifiedOn ?? '') }).toEqual({
        id: source.id,
        date: true,
      });
      expect(Date.parse(check.verifiedOn)).toBeLessThanOrEqual(Date.now());
      expect(check.quote.trim().length).toBeGreaterThanOrEqual(10);
      expect(https(check.source)).toBe(true);
      expect(https(source.licence.href)).toBe(true);
      expect(source.licence.label.trim().length).toBeGreaterThan(0);
      expect(source.attribution.label.trim().length).toBeGreaterThan(0);
      if (source.requiresKey) expect(https(source.keyRegistrationUrl ?? '')).toBe(true);
    });
  }

  it('every credit, licence, name and id is one the public contract accepts', () => {
    for (const source of LIVE_SOURCES) {
      const problems = [
        liveSourceIdSchema.safeParse(source.id).success ? null : 'id',
        liveLinkSchema.safeParse(source.attribution).success ? null : 'attribution',
        liveLinkSchema.safeParse(source.licence).success ? null : 'licence',
        source.name.length <= 80 ? null : 'name',
      ].filter(Boolean);
      expect({ id: source.id, problems }).toEqual({ id: source.id, problems: [] });
    }
  });

  it('a provider is keyless or names where its key is registered — and never carries one', () => {
    for (const provider of LIVE_PROVIDERS) {
      if (provider.auth.kind !== 'none') expect(https(provider.auth.registrationUrl)).toBe(true);
      // A key goes in LIVE_SOURCE_<ID>_KEY, never in the catalogue (Bordeaux's
      // public, published-for-everyone key is the one exception, named here).
      const query = new URL(provider.url).searchParams;
      for (const name of ['key', 'apikey', 'api_key', 'api_token', 'appID', 'token'])
        expect({ id: provider.id, [name]: query.get(name) }).toEqual({
          id: provider.id,
          [name]: null,
        });
    }
  });

  it('ids are unique', () => {
    const ids = LIVE_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a feed estimated from trip updates names the static GTFS it estimates along', () => {
    for (const provider of LIVE_PROVIDERS) {
      if (provider.format === 'gtfs-rt-tu')
        expect({ id: provider.id, static: Boolean(provider.staticGtfs) }).toEqual({
          id: provider.id,
          static: true,
        });
    }
  });

  it('every provider polls no faster than every 10 s, and covers a real box', () => {
    for (const provider of LIVE_PROVIDERS) {
      expect(provider.pollIntervalSeconds).toBeGreaterThanOrEqual(10);
      const { west, south, east, north } = provider.coverage;
      expect(west < east && south < north).toBe(true);
    }
  });
});
