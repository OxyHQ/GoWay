import { describe, expect, it } from 'vitest';
import { matchLanguageTag } from '../src/index';

/**
 * The locale matcher every label read goes through: the BCP 47 best match
 * over the languages an entry is written in.
 */

/** Mercaria's locales, as canonical tags. */
const LANGUAGES = ['en', 'ar', 'bn', 'ca', 'de', 'es', 'fr', 'hi', 'ja', 'pt-BR', 'ru', 'zh-Hans'];

describe('matchLanguageTag', () => {
  it('takes the exact canonical tag first, however the request spells it', () => {
    expect(matchLanguageTag(LANGUAGES, 'pt-BR')).toBe('pt-BR');
    expect(matchLanguageTag(LANGUAGES, 'zh-Hans')).toBe('zh-Hans');
    expect(matchLanguageTag(LANGUAGES, 'PT_br')).toBe('pt-BR');
    expect(matchLanguageTag(LANGUAGES, 'ZH-hans')).toBe('zh-Hans');
    expect(matchLanguageTag(LANGUAGES, 'ca')).toBe('ca');
  });

  it('serves Simplified Chinese to every tag that is written in it', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-MY', 'zh-Hans-CN', 'zh-Hans-SG', 'zh-Hans-HK']) {
      expect(matchLanguageTag(LANGUAGES, tag)).toBe('zh-Hans');
    }
  });

  it('never serves Simplified Chinese to a reader of Traditional', () => {
    for (const tag of ['zh-Hant', 'zh-Hant-TW', 'zh-Hant-HK', 'zh-TW', 'zh-HK', 'zh-MO']) {
      expect(matchLanguageTag(LANGUAGES, tag)).toBeUndefined();
    }
    // …and does serve Traditional when it exists.
    expect(matchLanguageTag(['en', 'zh-Hans', 'zh-Hant'], 'zh-TW')).toBe('zh-Hant');
    expect(matchLanguageTag(['en', 'zh-Hans', 'zh-Hant'], 'zh-Hant-HK')).toBe('zh-Hant');
    expect(matchLanguageTag(['en', 'zh-Hans', 'zh-Hant'], 'zh-CN')).toBe('zh-Hans');
  });

  it('serves the one Portuguese to every region of it', () => {
    for (const tag of ['pt', 'pt-PT', 'pt-AO', 'pt-MZ', 'pt-BR']) {
      expect(matchLanguageTag(LANGUAGES, tag)).toBe('pt-BR');
    }
  });

  it('serves the bare language to a regional variety of it', () => {
    expect(matchLanguageTag(LANGUAGES, 'es-MX')).toBe('es');
    expect(matchLanguageTag(LANGUAGES, 'es-419')).toBe('es');
    expect(matchLanguageTag(LANGUAGES, 'en-GB')).toBe('en');
    expect(matchLanguageTag(LANGUAGES, 'fr-CA')).toBe('fr');
    expect(matchLanguageTag(LANGUAGES, 'de-CH')).toBe('de');
    expect(matchLanguageTag(LANGUAGES, 'ar-EG')).toBe('ar');
    expect(matchLanguageTag(LANGUAGES, 'bn-IN')).toBe('bn');
    expect(matchLanguageTag(LANGUAGES, 'ca-ES-valencia')).toBe('ca');
    expect(matchLanguageTag(LANGUAGES, 'ru-Cyrl-RU')).toBe('ru');
  });

  it("prefers the reader's region, then no region, then another region", () => {
    const offered = ['en', 'pt-BR', 'pt', 'pt-PT'];
    expect(matchLanguageTag(offered, 'pt-PT')).toBe('pt-PT');
    expect(matchLanguageTag(offered, 'pt-AO')).toBe('pt');
    expect(matchLanguageTag(['en', 'pt-BR', 'pt-PT'], 'pt-AO')).toBe('pt-BR');
    expect(matchLanguageTag(['es-ES', 'es-MX'], 'es-MX')).toBe('es-MX');
  });

  it('prefers a tag without a variant the reader did not ask for, and one with the variant they did', () => {
    expect(matchLanguageTag(['ca-valencia', 'ca'], 'ca-ES')).toBe('ca');
    expect(matchLanguageTag(['ca-valencia', 'ca'], 'ca-ES-valencia')).toBe('ca-valencia');
    expect(matchLanguageTag(['ca', 'ca-valencia'], 'ca-ES-valencia')).toBe('ca-valencia');
    expect(matchLanguageTag(['ca-valencia'], 'ca-ES')).toBe('ca-valencia');
  });

  it('refuses a script the language is not written in', () => {
    // Hindi in Latin script is not served Devanagari.
    expect(matchLanguageTag(LANGUAGES, 'hi-Latn')).toBeUndefined();
    expect(matchLanguageTag(LANGUAGES, 'sr-Latn')).toBeUndefined();
  });

  it('answers nothing for a language it does not have, or a tag that is not one', () => {
    expect(matchLanguageTag(LANGUAGES, 'it')).toBeUndefined();
    expect(matchLanguageTag(LANGUAGES, 'yue-HK')).toBeUndefined();
    expect(matchLanguageTag(LANGUAGES, 'etymology')).toBeUndefined();
    expect(matchLanguageTag(LANGUAGES, '')).toBeUndefined();
    expect(matchLanguageTag(LANGUAGES, null)).toBeUndefined();
    expect(matchLanguageTag(LANGUAGES, undefined)).toBeUndefined();
  });

  it('returns the tag as the offer spelled it, and skips an offer that is not a tag', () => {
    expect(matchLanguageTag(['EN', 'zh-hans'], 'zh-CN')).toBe('zh-hans');
    expect(matchLanguageTag(['name:left', 'es'], 'es-AR')).toBe('es');
  });

  it('breaks a tie by the order of the offer', () => {
    expect(matchLanguageTag(['pt-BR', 'pt-AO'], 'pt-PT')).toBe('pt-BR');
    expect(matchLanguageTag(['pt-AO', 'pt-BR'], 'pt-PT')).toBe('pt-AO');
  });
});
