/**
 * The name-resolution chain, which is the only thing in this codebase that
 * decides what a place is CALLED on screen.
 *
 * It is unit-tested rather than exercised through HTTP because the interesting
 * cases are all "which of several equally valid answers wins", and the cost of
 * getting one wrong is not an error: it is a map that quietly shows the wrong
 * language, or shows GoWay's correction on the sheet and OpenStreetMap's
 * spelling on the pin beside it.
 */

import '../../__tests__/testEnv';
import { describe, expect, it } from 'bun:test';
import { normalizeLanguageTag, baseLanguageTag } from '@goway/shared-types';
import { comparePublishedNames, resolveLocalizedName, type ResolvableName } from '../placeNames';

const OLD = new Date('2024-01-01T00:00:00.000Z');
const NEW = new Date('2026-01-01T00:00:00.000Z');

function name(
  language: string,
  value: string,
  source = 'openstreetmap',
  observedAt = OLD,
): ResolvableName {
  return { language, name: value, source, observedAt };
}

describe('resolveLocalizedName', () => {
  it('prefers the exact tag over the bare language', () => {
    const names = [name('es', 'Museo Picasso'), name('es-MX', 'Museo Picasso MX')];
    expect(resolveLocalizedName(names, 'es-MX')?.name).toBe('Museo Picasso MX');
  });

  it('falls back to the bare language when the exact tag is missing', () => {
    expect(resolveLocalizedName([name('es', 'Museo Picasso')], 'es-MX')?.name).toBe('Museo Picasso');
  });

  it('falls back to another variety of the same language before giving up', () => {
    // `es-AR` is not what was asked for, and it is a far better answer than the
    // place's Catalan default for somebody reading Mexican Spanish.
    expect(resolveLocalizedName([name('es-AR', 'Museo Picasso AR')], 'es-MX')?.name).toBe(
      'Museo Picasso AR',
    );
  });

  it('answers nothing rather than an arbitrary other language', () => {
    // The rung the issue sketched as "→ anything" and this implementation
    // refuses. An absent answer publishes the default name, which is the name
    // on the shopfront — the one the sign, the tile and a passer-by all agree
    // on. A random exonym is worse than that, not better.
    expect(resolveLocalizedName([name('ja', '東京都庁'), name('ko', '도쿄도청')], 'es')).toBeUndefined();
  });

  it('answers nothing when no locale was asked for', () => {
    expect(resolveLocalizedName([name('es', 'Museo Picasso')], undefined)).toBeUndefined();
    expect(resolveLocalizedName([name('es', 'Museo Picasso')], '')).toBeUndefined();
  });

  it('answers nothing for a tag that is not a language tag', () => {
    // `left` is a real OpenStreetMap `name:*` key and is well-formed under the
    // wider BCP 47 rule. It must never resolve to anything.
    expect(resolveLocalizedName([name('es', 'Museo Picasso')], 'left')).toBeUndefined();
  });

  it('resolves a non-canonical tag exactly as its canonical form', () => {
    const names = [name('es-MX', 'Museo Picasso MX')];
    expect(resolveLocalizedName(names, 'ES-mx')?.name).toBe('Museo Picasso MX');
    expect(resolveLocalizedName(names, ' es_MX ')?.name).toBe('Museo Picasso MX');
  });

  it("prefers GoWay's correction over the source's spelling, at every rung", () => {
    // The read half of the guarantee the unique key makes at write time: the
    // importer cannot overwrite the `goway` row, and a read never prefers the
    // row it could have overwritten.
    const names = [
      name('es', 'Museo Picaso', 'openstreetmap', NEW),
      name('es', 'Museo Picasso', 'goway', OLD),
    ];
    expect(resolveLocalizedName(names, 'es')?.source).toBe('goway');
  });

  it('prefers the freshest observation between two external sources', () => {
    const names = [
      name('es', 'Stale', 'openstreetmap', OLD),
      name('es', 'Fresh', 'wikidata', NEW),
    ];
    expect(resolveLocalizedName(names, 'es')?.name).toBe('Fresh');
  });

  it('is deterministic when a rung ties on source and freshness', () => {
    const names = [name('es-VE', 'VE'), name('es-AR', 'AR')];
    expect(resolveLocalizedName(names, 'es-MX')?.language).toBe('es-AR');
    expect(resolveLocalizedName([...names].reverse(), 'es-MX')?.language).toBe('es-AR');
  });
});

describe('comparePublishedNames', () => {
  it('groups by language, strongest provenance first, then freshest', () => {
    const names = [
      name('fr', 'Musée Picasso'),
      name('es', 'Museo Picaso', 'openstreetmap', NEW),
      name('es', 'Museo Picasso', 'goway', OLD),
      name('ca', 'Museu Picasso'),
    ];
    expect([...names].sort(comparePublishedNames).map((entry) => `${entry.language}:${entry.source}`)).toEqual([
      'ca:openstreetmap',
      'es:goway',
      'es:openstreetmap',
      'fr:openstreetmap',
    ]);
  });
});

describe('normalizeLanguageTag', () => {
  it('canonicalizes case and separators', () => {
    expect(normalizeLanguageTag('ES')).toBe('es');
    expect(normalizeLanguageTag('es-mx')).toBe('es-MX');
    expect(normalizeLanguageTag('ZH-hant-hk')).toBe('zh-Hant-HK');
    expect(normalizeLanguageTag('zh_pinyin')).toBe('zh-pinyin');
    expect(normalizeLanguageTag('CA-Valencia')).toBe('ca-valencia');
    expect(normalizeLanguageTag('es-419')).toBe('es-419');
    expect(normalizeLanguageTag('  ca  ')).toBe('ca');
  });

  it('refuses the OpenStreetMap keys that are not languages', () => {
    // Every one of these is a real `name:*` suffix and every one is well-formed
    // under BCP 47's four-letter reserved and five-to-eight-letter registered
    // primary subtags. Admitting them would put a street's left-hand-side label
    // into the map's vocabulary as a language.
    for (const key of ['left', 'right', 'signed', 'prefix', 'botanical', 'etymology']) {
      expect(normalizeLanguageTag(key)).toBeUndefined();
    }
  });

  it('refuses what is not a tag at all', () => {
    for (const value of ['', '   ', 'e', '1', 'es-', 'es--MX', 'x'.repeat(40), null, undefined]) {
      expect(normalizeLanguageTag(value)).toBeUndefined();
    }
  });
});

describe('baseLanguageTag', () => {
  it('reduces a variety to its language and passes a bare tag through', () => {
    expect(baseLanguageTag('es-419')).toBe('es');
    expect(baseLanguageTag('zh-Hant-HK')).toBe('zh');
    expect(baseLanguageTag('ca')).toBe('ca');
  });

  it('answers nothing for something that is not a tag', () => {
    expect(baseLanguageTag('etymology')).toBeUndefined();
  });
});
