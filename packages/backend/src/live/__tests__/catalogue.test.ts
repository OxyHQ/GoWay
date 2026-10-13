import { describe, expect, it } from 'bun:test';
import { liveSourceSchema } from '@goway/contracts';
import { LIVE_SOURCES } from '../catalogue';

/**
 * What every catalogue entry owes a reader, whoever added it: a unique id, a
 * credit and a licence a client can link, a coverage box that makes sense, and
 * freshness bounds in order. A source listed without these is a feed drawn with
 * nobody credited.
 */
describe('the live catalogue', () => {
  it('lists every source once', () => {
    const ids = LIVE_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const source of LIVE_SOURCES) {
    it(`${source.id}: credit, licence, coverage and freshness are coherent`, () => {
      expect(source.attribution.href).toStartWith('https://');
      expect(source.licence.href).toStartWith('https://');
      expect(source.attribution.label.length).toBeGreaterThan(3);
      // aisa-bus is served over plain http by its operator (docs/MAP_LIVE.md).
      expect(source.defaultUrl).toMatch(/^https?:\/\//);
      expect(source.pollIntervalSeconds).toBeGreaterThanOrEqual(5);
      expect(source.staleAfterSeconds).toBeGreaterThan(source.pollIntervalSeconds);
      expect(source.dropAfterSeconds).toBeGreaterThanOrEqual(source.staleAfterSeconds);
      if (source.coverage) {
        const { west, south, east, north } = source.coverage;
        expect(south).toBeLessThan(north);
        expect(west).toBeLessThan(east);
      }
      // What a client receives for the source must satisfy the public contract.
      expect(
        liveSourceSchema.safeParse({
          id: source.id,
          kind: source.kind,
          name: source.name,
          attribution: source.attribution,
          licence: source.licence,
          coverage: source.coverage,
          completeness: source.completeness,
          status: 'idle',
          pollIntervalSeconds: source.pollIntervalSeconds,
          staleAfterSeconds: source.staleAfterSeconds,
          lastUpdatedAt: null,
          dropAfterSeconds: source.dropAfterSeconds,
          entityCount: 0,
        }).success,
      ).toBe(true);
    });
  }
});
