/**
 * AGENTS.md: GoWay re-serves only what its licence allows it to re-serve
 * publicly and commercially. Every camera provider must say how that was
 * established — the day, the page, the words — and one GoWay serves pictures
 * for (`relay`) must say it explicitly. An entry without them fails here.
 */
import { describe, expect, it } from 'bun:test';
import { cameraProviderIdSchema, hubLinkSchema } from '@goway/contracts';
import { duplicateIds, licenceProblems } from '../../hub/provider';
import { CAMERA_PROVIDERS } from '../providers';

describe('every camera provider has a verified licence', () => {
  for (const provider of CAMERA_PROVIDERS) {
    it(provider.id, () => {
      expect({ id: provider.id, problems: licenceProblems(provider) }).toEqual({
        id: provider.id,
        problems: [],
      });
      expect(cameraProviderIdSchema.safeParse(provider.id).success).toBe(true);
      expect(hubLinkSchema.safeParse(provider.attribution).success).toBe(true);
      expect(hubLinkSchema.safeParse(provider.licence).success).toBe(true);
      expect(provider.name.length).toBeLessThanOrEqual(80);
      expect(provider.pollIntervalSeconds).toBeGreaterThanOrEqual(60);
      if (provider.coverage) {
        const { west, south, east, north } = provider.coverage;
        expect(west < east && south < north).toBe(true);
      }
    });
  }

  it('a keyless catalogue never carries a key in its URL', () => {
    for (const provider of CAMERA_PROVIDERS) {
      const query = new URL(provider.defaultUrl).searchParams;
      for (const name of ['key', 'apikey', 'api_key', 'api_token', 'appID', 'token'])
        expect({ id: provider.id, [name]: query.get(name) }).toEqual({
          id: provider.id,
          [name]: null,
        });
    }
  });

  it('ids are unique', () => {
    expect(duplicateIds(CAMERA_PROVIDERS)).toEqual([]);
  });
});
