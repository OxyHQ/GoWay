/**
 * The time-of-day scrubber's strings, per locale.
 *
 * NOT merged into `lib/i18n.tsx`'s tables: those are in the first-paint
 * bundle, and the scrubber only exists behind the city-sky flag
 * (`lib/map/citySkyFlag.ts`), in its own lazy chunk. The scrubber picks its
 * table with the same `matchLanguageTag` rule `LocaleProvider` uses, so the
 * two can never disagree about the language. `__tests__/citySkyMessages.test.ts`
 * asserts every locale carries every key.
 */

export const CITY_SKY_EN: Record<string, string> = {
  'citySky.label': 'Time of day',
  'citySky.now': 'Now',
  'citySky.earlierDay': 'Previous day',
  'citySky.laterDay': 'Next day',
  'citySky.slider': 'Hour of the day',
  'citySky.phase.day': 'Sun {degrees}° up',
  'citySky.phase.golden': 'Golden hour',
  'citySky.phase.civil': 'Blue hour',
  'citySky.phase.nautical': 'Twilight',
  'citySky.phase.night': 'Night',
};

export const CITY_SKY_ES: Record<string, string> = {
  'citySky.label': 'Hora del día',
  'citySky.now': 'Ahora',
  'citySky.earlierDay': 'Día anterior',
  'citySky.laterDay': 'Día siguiente',
  'citySky.slider': 'Hora del día',
  'citySky.phase.day': 'Sol a {degrees}°',
  'citySky.phase.golden': 'Hora dorada',
  'citySky.phase.civil': 'Hora azul',
  'citySky.phase.nautical': 'Crepúsculo',
  'citySky.phase.night': 'Noche',
};

export const CITY_SKY_MESSAGES: Record<string, Record<string, string>> = {
  en: CITY_SKY_EN,
  es: CITY_SKY_ES,
};
