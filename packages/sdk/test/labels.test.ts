import { CAPABILITY_DEFINITIONS, CAPABILITY_GROUP_LABELS, languageTagSchema, labelsSchema } from '@goway/contracts';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_GROUPS,
  CAPABILITY_KEYS,
  LABEL_LANGUAGES,
  capabilityGroupLabel,
  capabilityLabel,
  capabilityValueLabel,
  createGoWayClient,
  localizedLabel,
  matchLanguageTag,
  type Labels,
} from '../src/index';
import { PLACE } from './fixtures';
import { fakeFetch } from './helpers';

/**
 * Label languages and the locale matcher every label read goes through: the
 * BCP 47 best match, the device tags it is handed, and a capability vocabulary
 * written in every label language with no gaps.
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

describe('LABEL_LANGUAGES', () => {
  it("are Mercaria's locales, English first as the fallback", () => {
    expect([...LABEL_LANGUAGES]).toEqual(LANGUAGES);
  });
});

const CAFE: Labels = {
  en: 'Café',
  ar: 'مقهى',
  bn: 'ক্যাফে',
  ca: 'Cafeteria',
  de: 'Café',
  es: 'Cafetería',
  fr: 'Café',
  hi: 'कैफ़े',
  ja: 'カフェ',
  'pt-BR': 'Cafeteria',
  ru: 'Кафе',
  'zh-Hans': '咖啡馆',
};

describe('localizedLabel', () => {
  it('reads the best language, and English when none serves', () => {
    expect(localizedLabel(CAFE)).toBe('Café');
    expect(localizedLabel(CAFE, 'zh-Hans-CN')).toBe('咖啡馆');
    expect(localizedLabel(CAFE, 'pt-PT')).toBe('Cafeteria');
    expect(localizedLabel(CAFE, 'ja-JP')).toBe('カフェ');
    expect(localizedLabel(CAFE, 'zh-TW')).toBe('Café');
    expect(localizedLabel(CAFE, 'it-IT')).toBe('Café');
    expect(localizedLabel(CAFE, 'not a tag')).toBe('Café');
  });

  it('reads labels stored as data, with any set of languages', () => {
    const stored = { en: 'Café', es: 'Cafetería', 'zh-Hant': '咖啡廳' };
    expect(localizedLabel(stored, 'es-MX')).toBe('Cafetería');
    expect(localizedLabel(stored, 'zh-HK')).toBe('咖啡廳');
    expect(localizedLabel(stored, 'zh-CN')).toBe('Café');
    expect(localizedLabel(stored, 'pt-BR')).toBe('Café');
  });
});

describe('device locales', () => {
  // What `Intl…resolvedOptions().locale` and the OS locale APIs hand the app.
  const DEVICE_TAGS = ['zh-Hans-CN', 'zh-Hant-TW', 'zh-CN', 'pt-BR', 'pt-PT', 'en-US', 'es-419', 'ca-ES', 'ar-SA', 'hi-IN', 'ja-JP'];

  it('are accepted as a `?locale=` and as the client default', () => {
    for (const tag of [...LABEL_LANGUAGES, ...DEVICE_TAGS]) {
      expect(languageTagSchema.safeParse(tag).success, tag).toBe(true);
      const { fetch } = fakeFetch(200, PLACE);
      expect(() => createGoWayClient({ fetch, locale: tag }), tag).not.toThrow();
    }
  });

  it('each read a label', () => {
    expect(DEVICE_TAGS.map((tag) => capabilityGroupLabel('payment', tag))).toEqual([
      '支付',
      'Payment',
      '支付',
      'Pagamento',
      'Pagamento',
      'Payment',
      'Pago',
      'Pagament',
      'الدفع',
      'भुगतान',
      '支払い',
    ]);
  });
});

describe('the capability vocabulary', () => {
  it('is written in every label language, with no gaps', () => {
    const entries: [string, Labels][] = [
      ...CAPABILITY_GROUPS.map((group) => [`group ${group}`, CAPABILITY_GROUP_LABELS[group]] as [string, Labels]),
      ...CAPABILITY_KEYS.flatMap((key) => {
        const definition = CAPABILITY_DEFINITIONS[key];
        const value = definition.value;
        const values =
          value.kind === 'enum' || value.kind === 'enum_set'
            ? Object.entries(value.values).map(([member, labels]) => [`${key}:${member}`, labels] as [string, Labels])
            : [];
        return [[key, definition.labels] as [string, Labels], ...values];
      }),
    ];
    for (const [name, labels] of entries) {
      expect(labelsSchema.safeParse(labels).success, name).toBe(true);
      expect(Object.keys(labels), name).toEqual([...LABEL_LANGUAGES]);
      for (const language of LABEL_LANGUAGES) {
        expect(labels[language], `${name} ${language}`).toBe(labels[language].trim());
        // No bidi controls: the Arabic labels carry Latin brand names as they are.
        expect(labels[language], `${name} ${language}`).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
      }
    }
  });

  it('keeps brand names as they are written', () => {
    for (const language of LABEL_LANGUAGES) {
      expect(capabilityLabel('payments.faircoin.accepted', language)).toContain('FairCoin');
      expect(capabilityLabel('commerce.mercaria.store', language)).toContain('Mercaria');
      expect(capabilityLabel('brand.wikidata', language)).toContain('Wikidata');
      expect(capabilityLabel('social.whatsapp', language)).toBe('WhatsApp');
    }
  });

  it('labels keys, values and groups in the reader’s language', () => {
    expect(capabilityLabel('payments.cash', 'ca')).toBe('Efectiu');
    expect(capabilityLabel('payments.faircoin.accepted', 'ja-JP')).toBe('FairCoin 対応');
    expect(capabilityValueLabel('food.cuisine', 'catalan', 'ca-ES')).toBe('Catalana');
    expect(capabilityValueLabel('food.cuisine', 'italian', 'pt-PT')).toBe('Italiana');
    expect(capabilityValueLabel('accessibility.wheelchair', 'yes', 'de-AT')).toBe('Rollstuhlgerecht');
    expect(capabilityGroupLabel('accessibility', 'zh-SG')).toBe('无障碍');
    expect(capabilityGroupLabel('accessibility', 'zh-HK')).toBe('Accessibility');
  });
});
