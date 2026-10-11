/**
 * The settings button's accessible name, in every `LABEL_LANGUAGES` language.
 *
 * Apart from `mapFeatureLabels.ts` because the BUTTON is on the map from the
 * first paint, while the rest of the dialog's copy loads with the dialog.
 */
import type { Labels } from '@goway.to/sdk';

export const MAP_SETTINGS_TRIGGER_LABEL: Labels = {
  en: 'Map settings',
  ar: 'إعدادات الخريطة',
  bn: 'মানচিত্রের সেটিংস',
  ca: 'Configuració del mapa',
  de: 'Karteneinstellungen',
  es: 'Ajustes del mapa',
  fr: 'Réglages de la carte',
  hi: 'मानचित्र सेटिंग्स',
  ja: '地図の設定',
  'pt-BR': 'Configurações do mapa',
  ru: 'Настройки карты',
  'zh-Hans': '地图设置',
};
