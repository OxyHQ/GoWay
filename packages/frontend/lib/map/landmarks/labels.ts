/**
 * The landmark tour's ways in — the "Landmarks" control in the explore
 * screen's top-right stack and "Landmark tour" in a landmark's place sheet
 * (`features/landmarks/LandmarkEntry.tsx`) — in every `LABEL_LANGUAGES`
 * language. Machine-authored; review status in `docs/LABEL_TRANSLATIONS.md`.
 * `{name}` is the landmark's own name, as the registry gives it.
 */
import type { Labels } from '@goway.to/sdk';

export const LANDMARK_ENTRY_LABELS = {
  pill: {
    en: 'Landmarks',
    ar: 'المعالم',
    bn: 'ল্যান্ডমার্ক',
    ca: 'Monuments',
    de: 'Wahrzeichen',
    es: 'Monumentos',
    fr: 'Monuments',
    hi: 'प्रसिद्ध स्थल',
    ja: 'ランドマーク',
    'pt-BR': 'Pontos turísticos',
    ru: 'Достопримечательности',
    'zh-Hans': '地标',
  },
  pillName: {
    en: 'Landmark tour, starting at {name}',
    ar: 'جولة المعالم، بدءًا من {name}',
    bn: 'ল্যান্ডমার্ক ভ্রমণ, শুরু {name} থেকে',
    ca: 'Ruta de monuments, començant per {name}',
    de: 'Wahrzeichen-Tour, beginnend bei {name}',
    es: 'Ruta de monumentos, empezando por {name}',
    fr: 'Visite des monuments, en commençant par {name}',
    hi: 'प्रसिद्ध स्थलों का दौरा, {name} से शुरू',
    ja: 'ランドマークツアー（{name}から）',
    'pt-BR': 'Tour pelos pontos turísticos, começando por {name}',
    ru: 'Тур по достопримечательностям, начиная с {name}',
    'zh-Hans': '地标游览，从{name}开始',
  },
  placeAction: {
    en: 'Landmark tour',
    ar: 'جولة المعالم',
    bn: 'ল্যান্ডমার্ক ভ্রমণ',
    ca: 'Ruta de monuments',
    de: 'Wahrzeichen-Tour',
    es: 'Ruta de monumentos',
    fr: 'Visite des monuments',
    hi: 'प्रसिद्ध स्थलों का दौरा',
    ja: 'ランドマークツアー',
    'pt-BR': 'Tour pelos pontos turísticos',
    ru: 'Тур по достопримечательностям',
    'zh-Hans': '地标游览',
  },
  placeActionName: {
    en: 'Landmark tour of {name}',
    ar: 'جولة في معلم {name}',
    bn: '{name}-এর ল্যান্ডমার্ক ভ্রমণ',
    ca: 'Ruta pel monument {name}',
    de: 'Wahrzeichen-Tour: {name}',
    es: 'Ruta por el monumento {name}',
    fr: 'Visite du monument {name}',
    hi: '{name} का दौरा',
    ja: '{name}のランドマークツアー',
    'pt-BR': 'Tour por {name}',
    ru: 'Тур: {name}',
    'zh-Hans': '{name}地标游览',
  },
} as const satisfies Readonly<Record<string, Labels>>;
