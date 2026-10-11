/**
 * The layers button's accessible name, in every `LABEL_LANGUAGES` language.
 *
 * Apart from `mapFeatureLabels.ts` because the BUTTON is on the map from the
 * first paint, while the rest of the panel's copy loads with the panel.
 */
import type { Labels } from '@goway.to/sdk';

export const MAP_LAYERS_TRIGGER_LABEL: Labels = {
  en: 'Map layers',
  ar: 'طبقات الخريطة',
  bn: 'মানচিত্রের স্তর',
  ca: 'Capes del mapa',
  de: 'Kartenebenen',
  es: 'Capas del mapa',
  fr: 'Calques de la carte',
  hi: 'मानचित्र परतें',
  ja: '地図レイヤー',
  'pt-BR': 'Camadas do mapa',
  ru: 'Слои карты',
  'zh-Hans': '地图图层',
};
