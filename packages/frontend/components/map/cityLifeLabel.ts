/**
 * What the city-life label says: which things in view are SIMULATED and which
 * are LIVE — "Simulated: cars, people · Live: buses".
 *
 * Real first (`docs/MAP_CITY_LIFE.md`): the simulation fills only the classes
 * no real feed covers here, so the label names both sides, and never one
 * class on both. Its words are an in-code vocabulary, so every
 * `LABEL_LANGUAGES` language is required by the `Labels` type and read with
 * `localizedLabel` (AGENTS.md); the review state of these strings is in
 * `docs/LABEL_TRANSLATIONS.md`.
 *
 * Pure: the chip (`cityLifeChip.web.ts`) draws it.
 */
import { type Labels, localizedLabel } from '@goway.to/sdk';

import type { RealClass } from './engine/cityLife/realCoverage';

/** What the simulation draws, as the label names it. */
export type SimulatedThing = 'cars' | 'buses' | 'people';

/** `{list}` is replaced by the joined nouns. */
const SIMULATED: Labels = {
  en: 'Simulated: {list}',
  ar: 'محاكاة: {list}',
  bn: 'সিমুলেটেড: {list}',
  ca: 'Simulat: {list}',
  de: 'Simuliert: {list}',
  es: 'Simulado: {list}',
  fr: 'Simulé : {list}',
  hi: 'सिम्युलेटेड: {list}',
  ja: 'シミュレーション：{list}',
  'pt-BR': 'Simulado: {list}',
  ru: 'Симуляция: {list}',
  'zh-Hans': '模拟：{list}',
};

const LIVE: Labels = {
  en: 'Live: {list}',
  ar: 'مباشر: {list}',
  bn: 'লাইভ: {list}',
  ca: 'En directe: {list}',
  de: 'Live: {list}',
  es: 'En directo: {list}',
  fr: 'En direct : {list}',
  hi: 'लाइव: {list}',
  ja: 'リアルタイム：{list}',
  'pt-BR': 'Ao vivo: {list}',
  ru: 'В реальном времени: {list}',
  'zh-Hans': '实时：{list}',
};

export const CITY_LIFE_NOUNS: Readonly<Record<SimulatedThing | RealClass, Labels>> = {
  cars: {
    en: 'cars',
    ar: 'السيارات',
    bn: 'গাড়ি',
    ca: 'cotxes',
    de: 'Autos',
    es: 'coches',
    fr: 'voitures',
    hi: 'कारें',
    ja: '車',
    'pt-BR': 'carros',
    ru: 'машины',
    'zh-Hans': '汽车',
  },
  buses: {
    en: 'buses',
    ar: 'الحافلات',
    bn: 'বাস',
    ca: 'autobusos',
    de: 'Busse',
    es: 'autobuses',
    fr: 'bus',
    hi: 'बसें',
    ja: 'バス',
    'pt-BR': 'ônibus',
    ru: 'автобусы',
    'zh-Hans': '公交车',
  },
  people: {
    en: 'people',
    ar: 'المشاة',
    bn: 'পথচারী',
    ca: 'vianants',
    de: 'Fußgänger',
    es: 'peatones',
    fr: 'piétons',
    hi: 'पैदल यात्री',
    ja: '歩行者',
    'pt-BR': 'pedestres',
    ru: 'пешеходы',
    'zh-Hans': '行人',
  },
  bus: {
    en: 'buses',
    ar: 'الحافلات',
    bn: 'বাস',
    ca: 'autobusos',
    de: 'Busse',
    es: 'autobuses',
    fr: 'bus',
    hi: 'बसें',
    ja: 'バス',
    'pt-BR': 'ônibus',
    ru: 'автобусы',
    'zh-Hans': '公交车',
  },
  tram: {
    en: 'trams',
    ar: 'الترام',
    bn: 'ট্রাম',
    ca: 'tramvies',
    de: 'Straßenbahnen',
    es: 'tranvías',
    fr: 'tramways',
    hi: 'ट्राम',
    ja: '路面電車',
    'pt-BR': 'bondes',
    ru: 'трамваи',
    'zh-Hans': '有轨电车',
  },
  train: {
    en: 'trains',
    ar: 'القطارات',
    bn: 'ট্রেন',
    ca: 'trens',
    de: 'Züge',
    es: 'trenes',
    fr: 'trains',
    hi: 'ट्रेनें',
    ja: '列車',
    'pt-BR': 'trens',
    ru: 'поезда',
    'zh-Hans': '火车',
  },
  metro: {
    en: 'metro',
    ar: 'المترو',
    bn: 'মেট্রো',
    ca: 'metro',
    de: 'U-Bahn',
    es: 'metro',
    fr: 'métro',
    hi: 'मेट्रो',
    ja: '地下鉄',
    'pt-BR': 'metrô',
    ru: 'метро',
    'zh-Hans': '地铁',
  },
  ferry: {
    en: 'ferries',
    ar: 'العبّارات',
    bn: 'ফেরি',
    ca: 'transbordadors',
    de: 'Fähren',
    es: 'ferris',
    fr: 'ferries',
    hi: 'फ़ेरी',
    ja: 'フェリー',
    'pt-BR': 'balsas',
    ru: 'паромы',
    'zh-Hans': '渡轮',
  },
};

/** The accessible explanation behind the label. */
export const CITY_LIFE_DETAIL: Labels = {
  en: 'Whatever is marked simulated moves on the real street network but is not live traffic and says nothing about real conditions. Whatever is marked live comes from a real feed.',
  ar: 'ما وُسم بأنه محاكاة يتحرك على شبكة الشوارع الحقيقية لكنه ليس حركة مرور مباشرة ولا يدل على الأحوال الحقيقية. وما وُسم بأنه مباشر يأتي من مصدر بيانات حقيقي.',
  bn: 'যা সিমুলেটেড হিসেবে চিহ্নিত তা আসল রাস্তার নেটওয়ার্কে চলে, কিন্তু তা লাইভ ট্রাফিক নয় এবং বাস্তব অবস্থা সম্পর্কে কিছু বলে না। যা লাইভ হিসেবে চিহ্নিত তা আসল ডেটা থেকে আসে।',
  ca: 'El que surt com a simulat es mou per la xarxa de carrers real, però no és trànsit en directe ni diu res de l’estat real dels carrers. El que surt en directe ve d’una font de dades real.',
  de: 'Was als simuliert markiert ist, bewegt sich auf dem echten Straßennetz, ist aber kein Live-Verkehr und sagt nichts über die tatsächliche Lage. Was als live markiert ist, stammt aus einer echten Datenquelle.',
  es: 'Lo marcado como simulado se mueve por la red de calles real, pero no es tráfico en tiempo real ni indica el estado real de las calles. Lo marcado en directo viene de una fuente de datos real.',
  fr: 'Ce qui est indiqué comme simulé circule sur le vrai réseau de rues, mais ce n’est pas du trafic en direct et cela ne dit rien des conditions réelles. Ce qui est indiqué en direct provient d’une source de données réelle.',
  hi: 'जो सिम्युलेटेड के रूप में चिह्नित है वह असली सड़क नेटवर्क पर चलता है, पर यह लाइव ट्रैफ़िक नहीं है और असली हालात के बारे में कुछ नहीं बताता। जो लाइव के रूप में चिह्नित है वह असली डेटा स्रोत से आता है।',
  ja: 'シミュレーションと表示されたものは実際の道路網の上を動きますが、リアルタイムの交通ではなく、実際の状況を示すものではありません。リアルタイムと表示されたものは実際のデータに基づいています。',
  'pt-BR':
    'O que está marcado como simulado se move pela rede de ruas real, mas não é trânsito ao vivo e não diz nada sobre as condições reais. O que está marcado como ao vivo vem de uma fonte de dados real.',
  ru: 'То, что отмечено как симуляция, движется по реальной сети улиц, но это не трафик в реальном времени и он ничего не говорит о реальной обстановке. То, что отмечено как «в реальном времени», берётся из реального источника данных.',
  'zh-Hans':
    '标为模拟的内容在真实的街道网络上移动，但不是实时交通，也不反映实际路况。标为实时的内容来自真实的数据源。',
};

function join(items: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

export interface CityLifeLabelContent {
  /** Simulated things drawn in view, in label order. */
  simulated: SimulatedThing[];
  /** Classes with fresh real data in view. */
  live: RealClass[];
}

/** The label's text and its accessible detail, in the reader's language. */
export function cityLifeLabel(
  content: CityLifeLabelContent,
  locale: string,
): { text: string; detail: string } {
  const parts: string[] = [];
  const nouns = (things: (SimulatedThing | RealClass)[]) =>
    join(
      things.map((thing) => localizedLabel(CITY_LIFE_NOUNS[thing], locale)),
      locale,
    );
  if (content.simulated.length > 0) {
    parts.push(localizedLabel(SIMULATED, locale).replace('{list}', nouns(content.simulated)));
  }
  if (content.live.length > 0) {
    parts.push(localizedLabel(LIVE, locale).replace('{list}', nouns(content.live)));
  }
  return { text: parts.join(' · '), detail: localizedLabel(CITY_LIFE_DETAIL, locale) };
}

/** Every template and noun, for the tests. */
export const CITY_LIFE_LABELS: readonly Labels[] = [
  SIMULATED,
  LIVE,
  CITY_LIFE_DETAIL,
  ...Object.values(CITY_LIFE_NOUNS),
];
