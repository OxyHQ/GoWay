/**
 * The time-of-day control's accessible name, in every `LABEL_LANGUAGES`
 * language: the sun button in the explore screen's top-right stack that opens
 * the scrubber (`docs/MAP_FEATURES.md` → "The time of day").
 *
 * Apart from the scrubber's own words (`lib/messages/citySky.ts`) because the
 * BUTTON is on the map whenever the sky draws, while the scrubber is a lazy
 * chunk loaded on the first press.
 */
import type { Labels } from '@goway.to/sdk';

export const TIME_OF_DAY_TRIGGER_LABEL: Labels = {
  en: 'Time of day',
  ar: 'وقت اليوم',
  bn: 'দিনের সময়',
  ca: 'Hora del dia',
  de: 'Tageszeit',
  es: 'Hora del día',
  fr: 'Heure de la journée',
  hi: 'दिन का समय',
  ja: '時刻',
  'pt-BR': 'Hora do dia',
  ru: 'Время суток',
  'zh-Hans': '时刻',
};
