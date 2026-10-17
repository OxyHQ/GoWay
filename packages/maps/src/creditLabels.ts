/**
 * The compact credit's control (`components/map/MapAttribution.tsx`), in every
 * `LABEL_LANGUAGES` language. The credits themselves are not here: they are
 * the sources' own names, and stay as each source asks to be credited.
 */
import type { Labels } from '@goway.to/sdk';

export const CREDIT_LABELS = {
  show: {
    en: 'Show map credits',
    ar: 'إظهار مصادر الخريطة',
    bn: 'মানচিত্রের কৃতিত্ব দেখান',
    ca: 'Mostra els crèdits del mapa',
    de: 'Kartenquellen anzeigen',
    es: 'Mostrar los créditos del mapa',
    fr: 'Afficher les crédits de la carte',
    hi: 'मानचित्र के श्रेय दिखाएँ',
    ja: '地図のクレジットを表示',
    'pt-BR': 'Mostrar os créditos do mapa',
    ru: 'Показать источники карты',
    'zh-Hans': '显示地图来源',
  },
  hide: {
    en: 'Hide map credits',
    ar: 'إخفاء مصادر الخريطة',
    bn: 'মানচিত্রের কৃতিত্ব লুকান',
    ca: 'Amaga els crèdits del mapa',
    de: 'Kartenquellen ausblenden',
    es: 'Ocultar los créditos del mapa',
    fr: 'Masquer les crédits de la carte',
    hi: 'मानचित्र के श्रेय छिपाएँ',
    ja: '地図のクレジットを隠す',
    'pt-BR': 'Ocultar os créditos do mapa',
    ru: 'Скрыть источники карты',
    'zh-Hans': '隐藏地图来源',
  },
} as const satisfies Readonly<Record<string, Labels>>;
