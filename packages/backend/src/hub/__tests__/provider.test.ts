import { describe, expect, it } from 'bun:test';
import { duplicateIds, type HubProviderDefinition, licenceProblems } from '../provider';

const valid: HubProviderDefinition = {
  id: 'example',
  name: 'Example',
  attribution: { label: 'Example', href: 'https://example.org' },
  licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
  licenceCheck: {
    verifiedOn: '2026-01-01',
    quote: 'free to share and adapt, even commercially',
    source: 'https://example.org/terms',
  },
  defaultUrl: 'https://example.org/feed',
  requiresKey: false,
  pollIntervalSeconds: 30,
  staleAfterSeconds: 60,
  dropAfterSeconds: 120,
};

describe('licenceProblems', () => {
  it('accepts a provider that says how its licence was read', () => {
    expect(licenceProblems(valid)).toEqual([]);
  });

  it('refuses a missing or future check, an http source and a too-short quote', () => {
    const bad = {
      ...valid,
      licenceCheck: { verifiedOn: '2999-01-01', quote: 'ok', source: 'http://example.org' },
    };
    expect(licenceProblems(bad)).toEqual([
      'licenceCheck.verifiedOn is in the future',
      'licenceCheck.quote',
      'licenceCheck.source',
    ]);
    const missing = { ...valid, licenceCheck: undefined } as unknown as HubProviderDefinition;
    expect(licenceProblems(missing)).toContain('licenceCheck.verifiedOn');
  });

  it('requires a keyed provider to say where its key is registered', () => {
    expect(licenceProblems({ ...valid, requiresKey: true })).toEqual(['keyRegistrationUrl']);
    expect(
      licenceProblems({
        ...valid,
        requiresKey: true,
        keyRegistrationUrl: 'https://example.org/key',
      }),
    ).toEqual([]);
  });

  it('refuses data that is dropped before it is stale', () => {
    expect(licenceProblems({ ...valid, staleAfterSeconds: 200 })).toEqual([
      'stale must precede drop',
    ]);
  });
});

describe('duplicateIds', () => {
  it('names each repeated id once', () => {
    expect(duplicateIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'a' }])).toEqual(['a']);
    expect(duplicateIds([{ id: 'a' }, { id: 'b' }])).toEqual([]);
  });
});
