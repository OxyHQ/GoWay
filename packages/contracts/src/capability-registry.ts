/**
 * The capability registry — every key a place can carry, with the TYPE of its
 * value.
 *
 * A capability is one row in `places_capabilities`: a key, a value, a
 * verification tier and a freshness. Before this registry the key space was
 * open and the value was `boolean | string | number` for every key, so
 * `accessibility.wheelchair = 7` and `payments.faircoin.accepted = "maybe"`
 * were both writable and both meaningless. Now each key declares:
 *
 *  - its value shape ({@link CapabilityValueSpec}): a flag, one of a closed set,
 *    a subset of a closed set, a bounded integer, a price level, a URL, or a
 *    short text;
 *  - its label in every label language, and its enum values' labels;
 *  - the group a client renders it under;
 *  - the OpenStreetMap tags it is read from, where OpenStreetMap has one.
 *
 * Every write is validated against its key's spec, and a key that is not here
 * is refused. The verification tiers, the strongest-assertion rule and the
 * provenance rows are unchanged: this registry types the VALUE, it does not
 * touch who may assert it.
 *
 * ## No new table
 *
 * Accessibility, payment methods, amenities, cuisine and social links are all
 * capabilities. Each of them is a claim somebody makes about a place with some
 * strength at some time — the shape `places_capabilities` already has, with
 * the community/business/Oxy tiers kept apart so a passer-by's report cannot
 * overwrite the business's own. A column per attribute would have no
 * provenance at all.
 */

import { z } from 'zod';
import { localizedLabel, type Labels } from './labels';

/**
 * How a capability claim came to be believed.
 *
 * Ordered weakest to strongest, and the ORDER is the contract: it is the rank
 * `strongestCapability` reads and the capability filter applies. A historic
 * community report must never be presented as guaranteed current acceptance
 * without qualification — see `observedAt` on `PlaceCapability`. Hours
 * exceptions carry the same tiers, ranked the same way.
 */
export const CAPABILITY_VERIFICATIONS = [
  'community_reported',
  'external_source',
  'business_asserted',
  'oxy_verified',
] as const;
export type CapabilityVerification = (typeof CAPABILITY_VERIFICATIONS)[number];

/** The sections a client renders capabilities under, in display order. */
export const CAPABILITY_GROUPS = [
  'accessibility',
  'payment',
  'amenities',
  'food',
  'price',
  'social',
  'brand',
  'ecosystem',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export const CAPABILITY_GROUP_LABELS: Readonly<Record<CapabilityGroup, Labels>> = {
  accessibility: {
    en: 'Accessibility',
    ar: 'إمكانية الوصول',
    bn: 'প্রবেশযোগ্যতা',
    ca: 'Accessibilitat',
    de: 'Barrierefreiheit',
    es: 'Accesibilidad',
    fr: 'Accessibilité',
    hi: 'सुगम्यता',
    ja: 'バリアフリー',
    'pt-BR': 'Acessibilidade',
    ru: 'Доступность',
    'zh-Hans': '无障碍',
  },
  payment: {
    en: 'Payment',
    ar: 'الدفع',
    bn: 'পেমেন্ট',
    ca: 'Pagament',
    de: 'Zahlung',
    es: 'Pago',
    fr: 'Paiement',
    hi: 'भुगतान',
    ja: '支払い',
    'pt-BR': 'Pagamento',
    ru: 'Оплата',
    'zh-Hans': '支付',
  },
  amenities: {
    en: 'Amenities',
    ar: 'المرافق',
    bn: 'সুযোগ-সুবিধা',
    ca: 'Serveis',
    de: 'Ausstattung',
    es: 'Servicios',
    fr: 'Équipements',
    hi: 'सुविधाएँ',
    ja: '設備・サービス',
    'pt-BR': 'Comodidades',
    ru: 'Удобства',
    'zh-Hans': '设施与服务',
  },
  food: {
    en: 'Food',
    ar: 'الطعام',
    bn: 'খাবার',
    ca: 'Menjar',
    de: 'Essen',
    es: 'Comida',
    fr: 'Restauration',
    hi: 'खाना',
    ja: '料理',
    'pt-BR': 'Comida',
    ru: 'Еда',
    'zh-Hans': '餐饮',
  },
  price: {
    en: 'Price',
    ar: 'السعر',
    bn: 'দাম',
    ca: 'Preu',
    de: 'Preis',
    es: 'Precio',
    fr: 'Prix',
    hi: 'क़ीमत',
    ja: '価格',
    'pt-BR': 'Preço',
    ru: 'Цена',
    'zh-Hans': '价格',
  },
  social: {
    en: 'Social media',
    ar: 'وسائل التواصل الاجتماعي',
    bn: 'সোশ্যাল মিডিয়া',
    ca: 'Xarxes socials',
    de: 'Soziale Medien',
    es: 'Redes sociales',
    fr: 'Réseaux sociaux',
    hi: 'सोशल मीडिया',
    ja: 'SNS',
    'pt-BR': 'Redes sociais',
    ru: 'Соцсети',
    'zh-Hans': '社交媒体',
  },
  brand: {
    en: 'Brand',
    ar: 'العلامة التجارية',
    bn: 'ব্র্যান্ড',
    ca: 'Marca',
    de: 'Marke',
    es: 'Marca',
    fr: 'Marque',
    hi: 'ब्रांड',
    ja: 'ブランド',
    'pt-BR': 'Marca',
    ru: 'Бренд',
    'zh-Hans': '品牌',
  },
  ecosystem: {
    en: 'In the Oxy ecosystem',
    ar: 'في منظومة Oxy',
    bn: 'Oxy ইকোসিস্টেমে',
    ca: "A l'ecosistema Oxy",
    de: 'Im Oxy-Ökosystem',
    es: 'En el ecosistema Oxy',
    fr: "Dans l'écosystème Oxy",
    hi: 'Oxy इकोसिस्टम में',
    ja: 'Oxy エコシステム',
    'pt-BR': 'No ecossistema Oxy',
    ru: 'В экосистеме Oxy',
    'zh-Hans': 'Oxy 生态',
  },
};

/** The value kinds a capability may declare. */
export const CAPABILITY_VALUE_KINDS = [
  'boolean',
  'enum',
  'enum_set',
  'integer',
  'price_level',
  'url',
  'text',
] as const;
export type CapabilityValueKind = (typeof CAPABILITY_VALUE_KINDS)[number];

/** The values of an enum or an enum set, each with its label, in display order. */
export type CapabilityValueLabels = Readonly<Record<string, Labels>>;

/**
 * What a capability's value is.
 *
 * `enum.absent` names the values that mean the place does NOT have the thing —
 * `wheelchair = no` is an assertion, and it must not make a place match
 * `?capabilities=accessibility.wheelchair`.
 *
 * `url.handle` lets a caller (or a source) give a bare handle — `@cafe`, a
 * phone number for WhatsApp — and stores the canonical URL instead, so one
 * spelling is stored however it arrived. `url.hosts` refuses a link to the
 * wrong service under the key.
 */
export type CapabilityValueSpec =
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'enum';
      readonly values: CapabilityValueLabels;
      readonly absent?: readonly string[];
    }
  | { readonly kind: 'enum_set'; readonly values: CapabilityValueLabels }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'price_level' }
  | {
      readonly kind: 'url';
      readonly hosts?: readonly string[];
      readonly handle?: {
        readonly url: string;
        readonly pattern: RegExp;
        readonly digitsOnly?: boolean;
      };
    }
  | { readonly kind: 'text'; readonly maxLength: number; readonly pattern?: RegExp };

/**
 * Where OpenStreetMap says it.
 *
 * - `tags` — read in order. For a boolean, any `yes` value wins over any `no`
 *   (`payment:credit_cards=yes` with `payment:cards` absent is cards); for an
 *   enum the value is taken when it is one of the enum's; for an enum set the
 *   value is a `;`-separated list; for a URL or text the first non-empty value.
 * - `prefix` — an enum set read from keys: `diet:vegan=yes` puts `vegan` in.
 * - `yes` / `no` — the tag values that mean true and false. `['yes']` and
 *   `['no']` when absent.
 */
export interface CapabilityOsmTags {
  readonly tags?: readonly string[];
  readonly prefix?: string;
  readonly yes?: readonly string[];
  readonly no?: readonly string[];
}

export interface CapabilityDefinition {
  readonly group: CapabilityGroup;
  readonly labels: Labels;
  readonly value: CapabilityValueSpec;
  readonly osm?: CapabilityOsmTags;
}

const BOOLEAN = { kind: 'boolean' } as const;

const CUISINES: CapabilityValueLabels = {
  regional: {
    en: 'Regional',
    ar: 'إقليمي',
    bn: 'আঞ্চলিক',
    ca: 'Regional',
    de: 'Regional',
    es: 'Regional',
    fr: 'Régionale',
    hi: 'क्षेत्रीय',
    ja: '郷土料理',
    'pt-BR': 'Regional',
    ru: 'Местная',
    'zh-Hans': '地方菜',
  },
  spanish: {
    en: 'Spanish',
    ar: 'إسباني',
    bn: 'স্প্যানিশ',
    ca: 'Espanyola',
    de: 'Spanisch',
    es: 'Española',
    fr: 'Espagnole',
    hi: 'स्पैनिश',
    ja: 'スペイン料理',
    'pt-BR': 'Espanhola',
    ru: 'Испанская',
    'zh-Hans': '西班牙菜',
  },
  tapas: {
    en: 'Tapas',
    ar: 'تاباس',
    bn: 'তাপাস',
    ca: 'Tapes',
    de: 'Tapas',
    es: 'Tapas',
    fr: 'Tapas',
    hi: 'तापस',
    ja: 'タパス',
    'pt-BR': 'Tapas',
    ru: 'Тапас',
    'zh-Hans': '西班牙小吃',
  },
  catalan: {
    en: 'Catalan',
    ar: 'كتالوني',
    bn: 'কাতালান',
    ca: 'Catalana',
    de: 'Katalanisch',
    es: 'Catalana',
    fr: 'Catalane',
    hi: 'कैटलन',
    ja: 'カタルーニャ料理',
    'pt-BR': 'Catalã',
    ru: 'Каталонская',
    'zh-Hans': '加泰罗尼亚菜',
  },
  mediterranean: {
    en: 'Mediterranean',
    ar: 'متوسطي',
    bn: 'ভূমধ্যসাগরীয়',
    ca: 'Mediterrània',
    de: 'Mediterran',
    es: 'Mediterránea',
    fr: 'Méditerranéenne',
    hi: 'मेडिटेरेनियन',
    ja: '地中海料理',
    'pt-BR': 'Mediterrânea',
    ru: 'Средиземноморская',
    'zh-Hans': '地中海菜',
  },
  italian: {
    en: 'Italian',
    ar: 'إيطالي',
    bn: 'ইতালীয়',
    ca: 'Italiana',
    de: 'Italienisch',
    es: 'Italiana',
    fr: 'Italienne',
    hi: 'इटैलियन',
    ja: 'イタリアン',
    'pt-BR': 'Italiana',
    ru: 'Итальянская',
    'zh-Hans': '意大利菜',
  },
  pizza: {
    en: 'Pizza',
    ar: 'بيتزا',
    bn: 'পিৎজা',
    ca: 'Pizza',
    de: 'Pizza',
    es: 'Pizza',
    fr: 'Pizza',
    hi: 'पिज़्ज़ा',
    ja: 'ピザ',
    'pt-BR': 'Pizza',
    ru: 'Пицца',
    'zh-Hans': '披萨',
  },
  french: {
    en: 'French',
    ar: 'فرنسي',
    bn: 'ফরাসি',
    ca: 'Francesa',
    de: 'Französisch',
    es: 'Francesa',
    fr: 'Française',
    hi: 'फ़्रेंच',
    ja: 'フレンチ',
    'pt-BR': 'Francesa',
    ru: 'Французская',
    'zh-Hans': '法国菜',
  },
  portuguese: {
    en: 'Portuguese',
    ar: 'برتغالي',
    bn: 'পর্তুগিজ',
    ca: 'Portuguesa',
    de: 'Portugiesisch',
    es: 'Portuguesa',
    fr: 'Portugaise',
    hi: 'पुर्तगाली',
    ja: 'ポルトガル料理',
    'pt-BR': 'Portuguesa',
    ru: 'Португальская',
    'zh-Hans': '葡萄牙菜',
  },
  greek: {
    en: 'Greek',
    ar: 'يوناني',
    bn: 'গ্রিক',
    ca: 'Grega',
    de: 'Griechisch',
    es: 'Griega',
    fr: 'Grecque',
    hi: 'ग्रीक',
    ja: 'ギリシャ料理',
    'pt-BR': 'Grega',
    ru: 'Греческая',
    'zh-Hans': '希腊菜',
  },
  german: {
    en: 'German',
    ar: 'ألماني',
    bn: 'জার্মান',
    ca: 'Alemanya',
    de: 'Deutsch',
    es: 'Alemana',
    fr: 'Allemande',
    hi: 'जर्मन',
    ja: 'ドイツ料理',
    'pt-BR': 'Alemã',
    ru: 'Немецкая',
    'zh-Hans': '德国菜',
  },
  turkish: {
    en: 'Turkish',
    ar: 'تركي',
    bn: 'তুর্কি',
    ca: 'Turca',
    de: 'Türkisch',
    es: 'Turca',
    fr: 'Turque',
    hi: 'तुर्की',
    ja: 'トルコ料理',
    'pt-BR': 'Turca',
    ru: 'Турецкая',
    'zh-Hans': '土耳其菜',
  },
  kebab: {
    en: 'Kebab',
    ar: 'كباب',
    bn: 'কাবাব',
    ca: 'Kebab',
    de: 'Kebab',
    es: 'Kebab',
    fr: 'Kebab',
    hi: 'कबाब',
    ja: 'ケバブ',
    'pt-BR': 'Kebab',
    ru: 'Кебаб',
    'zh-Hans': '烤肉卷',
  },
  lebanese: {
    en: 'Lebanese',
    ar: 'لبناني',
    bn: 'লেবানিজ',
    ca: 'Libanesa',
    de: 'Libanesisch',
    es: 'Libanesa',
    fr: 'Libanaise',
    hi: 'लेबनानी',
    ja: 'レバノン料理',
    'pt-BR': 'Libanesa',
    ru: 'Ливанская',
    'zh-Hans': '黎巴嫩菜',
  },
  arab: {
    en: 'Arabic',
    ar: 'عربي',
    bn: 'আরবি',
    ca: 'Àrab',
    de: 'Arabisch',
    es: 'Árabe',
    fr: 'Arabe',
    hi: 'अरबी',
    ja: 'アラブ料理',
    'pt-BR': 'Árabe',
    ru: 'Арабская',
    'zh-Hans': '阿拉伯菜',
  },
  african: {
    en: 'African',
    ar: 'أفريقي',
    bn: 'আফ্রিকান',
    ca: 'Africana',
    de: 'Afrikanisch',
    es: 'Africana',
    fr: 'Africaine',
    hi: 'अफ़्रीकी',
    ja: 'アフリカ料理',
    'pt-BR': 'Africana',
    ru: 'Африканская',
    'zh-Hans': '非洲菜',
  },
  indian: {
    en: 'Indian',
    ar: 'هندي',
    bn: 'ভারতীয়',
    ca: 'Índia',
    de: 'Indisch',
    es: 'India',
    fr: 'Indienne',
    hi: 'भारतीय',
    ja: 'インド料理',
    'pt-BR': 'Indiana',
    ru: 'Индийская',
    'zh-Hans': '印度菜',
  },
  nepalese: {
    en: 'Nepalese',
    ar: 'نيبالي',
    bn: 'নেপালি',
    ca: 'Nepalesa',
    de: 'Nepalesisch',
    es: 'Nepalí',
    fr: 'Népalaise',
    hi: 'नेपाली',
    ja: 'ネパール料理',
    'pt-BR': 'Nepalesa',
    ru: 'Непальская',
    'zh-Hans': '尼泊尔菜',
  },
  chinese: {
    en: 'Chinese',
    ar: 'صيني',
    bn: 'চাইনিজ',
    ca: 'Xinesa',
    de: 'Chinesisch',
    es: 'China',
    fr: 'Chinoise',
    hi: 'चाइनीज़',
    ja: '中華',
    'pt-BR': 'Chinesa',
    ru: 'Китайская',
    'zh-Hans': '中餐',
  },
  japanese: {
    en: 'Japanese',
    ar: 'ياباني',
    bn: 'জাপানি',
    ca: 'Japonesa',
    de: 'Japanisch',
    es: 'Japonesa',
    fr: 'Japonaise',
    hi: 'जापानी',
    ja: '和食',
    'pt-BR': 'Japonesa',
    ru: 'Японская',
    'zh-Hans': '日本料理',
  },
  sushi: {
    en: 'Sushi',
    ar: 'سوشي',
    bn: 'সুশি',
    ca: 'Sushi',
    de: 'Sushi',
    es: 'Sushi',
    fr: 'Sushi',
    hi: 'सुशी',
    ja: '寿司',
    'pt-BR': 'Sushi',
    ru: 'Суши',
    'zh-Hans': '寿司',
  },
  ramen: {
    en: 'Ramen',
    ar: 'رامن',
    bn: 'রামেন',
    ca: 'Ramen',
    de: 'Ramen',
    es: 'Ramen',
    fr: 'Ramen',
    hi: 'रामेन',
    ja: 'ラーメン',
    'pt-BR': 'Lámen',
    ru: 'Рамен',
    'zh-Hans': '拉面',
  },
  korean: {
    en: 'Korean',
    ar: 'كوري',
    bn: 'কোরিয়ান',
    ca: 'Coreana',
    de: 'Koreanisch',
    es: 'Coreana',
    fr: 'Coréenne',
    hi: 'कोरियन',
    ja: '韓国料理',
    'pt-BR': 'Coreana',
    ru: 'Корейская',
    'zh-Hans': '韩国料理',
  },
  thai: {
    en: 'Thai',
    ar: 'تايلاندي',
    bn: 'থাই',
    ca: 'Tailandesa',
    de: 'Thailändisch',
    es: 'Tailandesa',
    fr: 'Thaïlandaise',
    hi: 'थाई',
    ja: 'タイ料理',
    'pt-BR': 'Tailandesa',
    ru: 'Тайская',
    'zh-Hans': '泰国菜',
  },
  vietnamese: {
    en: 'Vietnamese',
    ar: 'فيتنامي',
    bn: 'ভিয়েতনামি',
    ca: 'Vietnamita',
    de: 'Vietnamesisch',
    es: 'Vietnamita',
    fr: 'Vietnamienne',
    hi: 'वियतनामी',
    ja: 'ベトナム料理',
    'pt-BR': 'Vietnamita',
    ru: 'Вьетнамская',
    'zh-Hans': '越南菜',
  },
  asian: {
    en: 'Asian',
    ar: 'آسيوي',
    bn: 'এশীয়',
    ca: 'Asiàtica',
    de: 'Asiatisch',
    es: 'Asiática',
    fr: 'Asiatique',
    hi: 'एशियाई',
    ja: 'アジア料理',
    'pt-BR': 'Asiática',
    ru: 'Азиатская',
    'zh-Hans': '亚洲菜',
  },
  mexican: {
    en: 'Mexican',
    ar: 'مكسيكي',
    bn: 'মেক্সিকান',
    ca: 'Mexicana',
    de: 'Mexikanisch',
    es: 'Mexicana',
    fr: 'Mexicaine',
    hi: 'मैक्सिकन',
    ja: 'メキシコ料理',
    'pt-BR': 'Mexicana',
    ru: 'Мексиканская',
    'zh-Hans': '墨西哥菜',
  },
  peruvian: {
    en: 'Peruvian',
    ar: 'بيروفي',
    bn: 'পেরুভিয়ান',
    ca: 'Peruana',
    de: 'Peruanisch',
    es: 'Peruana',
    fr: 'Péruvienne',
    hi: 'पेरूवियन',
    ja: 'ペルー料理',
    'pt-BR': 'Peruana',
    ru: 'Перуанская',
    'zh-Hans': '秘鲁菜',
  },
  argentinian: {
    en: 'Argentinian',
    ar: 'أرجنتيني',
    bn: 'আর্জেন্টাইন',
    ca: 'Argentina',
    de: 'Argentinisch',
    es: 'Argentina',
    fr: 'Argentine',
    hi: 'अर्जेंटीनी',
    ja: 'アルゼンチン料理',
    'pt-BR': 'Argentina',
    ru: 'Аргентинская',
    'zh-Hans': '阿根廷菜',
  },
  american: {
    en: 'American',
    ar: 'أمريكي',
    bn: 'আমেরিকান',
    ca: 'Americana',
    de: 'Amerikanisch',
    es: 'Americana',
    fr: 'Américaine',
    hi: 'अमेरिकन',
    ja: 'アメリカ料理',
    'pt-BR': 'Americana',
    ru: 'Американская',
    'zh-Hans': '美式',
  },
  burger: {
    en: 'Burgers',
    ar: 'برغر',
    bn: 'বার্গার',
    ca: 'Hamburgueses',
    de: 'Burger',
    es: 'Hamburguesas',
    fr: 'Burgers',
    hi: 'बर्गर',
    ja: 'ハンバーガー',
    'pt-BR': 'Hambúrgueres',
    ru: 'Бургеры',
    'zh-Hans': '汉堡',
  },
  chicken: {
    en: 'Chicken',
    ar: 'دجاج',
    bn: 'চিকেন',
    ca: 'Pollastre',
    de: 'Hähnchen',
    es: 'Pollo',
    fr: 'Poulet',
    hi: 'चिकन',
    ja: 'チキン',
    'pt-BR': 'Frango',
    ru: 'Курица',
    'zh-Hans': '炸鸡',
  },
  sandwich: {
    en: 'Sandwiches',
    ar: 'سندويشات',
    bn: 'স্যান্ডউইচ',
    ca: 'Entrepans',
    de: 'Sandwiches',
    es: 'Bocadillos',
    fr: 'Sandwichs',
    hi: 'सैंडविच',
    ja: 'サンドイッチ',
    'pt-BR': 'Sanduíches',
    ru: 'Сэндвичи',
    'zh-Hans': '三明治',
  },
  barbecue: {
    en: 'Barbecue',
    ar: 'مشاوي',
    bn: 'বারবিকিউ',
    ca: 'Barbacoa',
    de: 'Grill',
    es: 'Barbacoa',
    fr: 'Barbecue',
    hi: 'बारबेक्यू',
    ja: 'バーベキュー',
    'pt-BR': 'Churrasco',
    ru: 'Барбекю',
    'zh-Hans': '烧烤',
  },
  steak_house: {
    en: 'Steakhouse',
    ar: 'ستيك',
    bn: 'স্টেকহাউস',
    ca: 'Brasa',
    de: 'Steakhaus',
    es: 'Asador',
    fr: 'Grill',
    hi: 'स्टेकहाउस',
    ja: 'ステーキ',
    'pt-BR': 'Churrascaria',
    ru: 'Стейк-хаус',
    'zh-Hans': '牛排',
  },
  seafood: {
    en: 'Seafood',
    ar: 'مأكولات بحرية',
    bn: 'সামুদ্রিক খাবার',
    ca: 'Marisc',
    de: 'Meeresfrüchte',
    es: 'Marisco',
    fr: 'Fruits de mer',
    hi: 'सीफ़ूड',
    ja: 'シーフード',
    'pt-BR': 'Frutos do mar',
    ru: 'Морепродукты',
    'zh-Hans': '海鲜',
  },
  fish: {
    en: 'Fish',
    ar: 'أسماك',
    bn: 'মাছ',
    ca: 'Peix',
    de: 'Fisch',
    es: 'Pescado',
    fr: 'Poisson',
    hi: 'मछली',
    ja: '魚料理',
    'pt-BR': 'Peixes',
    ru: 'Рыба',
    'zh-Hans': '鱼',
  },
  international: {
    en: 'International',
    ar: 'عالمي',
    bn: 'আন্তর্জাতিক',
    ca: 'Internacional',
    de: 'International',
    es: 'Internacional',
    fr: 'Internationale',
    hi: 'इंटरनेशनल',
    ja: '多国籍料理',
    'pt-BR': 'Internacional',
    ru: 'Интернациональная',
    'zh-Hans': '国际美食',
  },
  coffee_shop: {
    en: 'Coffee',
    ar: 'قهوة',
    bn: 'কফি',
    ca: 'Cafè',
    de: 'Kaffee',
    es: 'Café',
    fr: 'Café',
    hi: 'कॉफ़ी',
    ja: 'コーヒー',
    'pt-BR': 'Café',
    ru: 'Кофе',
    'zh-Hans': '咖啡',
  },
  breakfast: {
    en: 'Breakfast',
    ar: 'فطور',
    bn: 'নাস্তা',
    ca: 'Esmorzars',
    de: 'Frühstück',
    es: 'Desayunos',
    fr: 'Petit-déjeuner',
    hi: 'नाश्ता',
    ja: 'モーニング',
    'pt-BR': 'Café da manhã',
    ru: 'Завтраки',
    'zh-Hans': '早餐',
  },
  ice_cream: {
    en: 'Ice cream',
    ar: 'آيس كريم',
    bn: 'আইসক্রিম',
    ca: 'Gelats',
    de: 'Eis',
    es: 'Helados',
    fr: 'Glaces',
    hi: 'आइसक्रीम',
    ja: 'アイスクリーム',
    'pt-BR': 'Sorvetes',
    ru: 'Мороженое',
    'zh-Hans': '冰淇淋',
  },
  crepe: {
    en: 'Crêpes',
    ar: 'كريب',
    bn: 'ক্রেপ',
    ca: 'Creps',
    de: 'Crêpes',
    es: 'Crepes',
    fr: 'Crêpes',
    hi: 'क्रेप',
    ja: 'クレープ',
    'pt-BR': 'Crepes',
    ru: 'Блины',
    'zh-Hans': '可丽饼',
  },
  bubble_tea: {
    en: 'Bubble tea',
    ar: 'بابل تي',
    bn: 'বাবল টি',
    ca: 'Te de bombolles',
    de: 'Bubble Tea',
    es: 'Té de burbujas',
    fr: 'Bubble tea',
    hi: 'बबल टी',
    ja: 'タピオカティー',
    'pt-BR': 'Bubble tea',
    ru: 'Бабл-ти',
    'zh-Hans': '奶茶',
  },
};

const DIETS: CapabilityValueLabels = {
  vegan: {
    en: 'Vegan',
    ar: 'نباتي صرف',
    bn: 'ভেগান',
    ca: 'Vegana',
    de: 'Vegan',
    es: 'Vegana',
    fr: 'Végane',
    hi: 'वीगन',
    ja: 'ヴィーガン',
    'pt-BR': 'Vegana',
    ru: 'Веганское',
    'zh-Hans': '纯素',
  },
  vegetarian: {
    en: 'Vegetarian',
    ar: 'نباتي',
    bn: 'নিরামিষ',
    ca: 'Vegetariana',
    de: 'Vegetarisch',
    es: 'Vegetariana',
    fr: 'Végétarienne',
    hi: 'शाकाहारी',
    ja: 'ベジタリアン',
    'pt-BR': 'Vegetariana',
    ru: 'Вегетарианское',
    'zh-Hans': '素食',
  },
  gluten_free: {
    en: 'Gluten-free',
    ar: 'خالٍ من الغلوتين',
    bn: 'গ্লুটেন-মুক্ত',
    ca: 'Sense gluten',
    de: 'Glutenfrei',
    es: 'Sin gluten',
    fr: 'Sans gluten',
    hi: 'ग्लूटेन-फ़्री',
    ja: 'グルテンフリー',
    'pt-BR': 'Sem glúten',
    ru: 'Без глютена',
    'zh-Hans': '无麸质',
  },
  halal: {
    en: 'Halal',
    ar: 'حلال',
    bn: 'হালাল',
    ca: 'Halal',
    de: 'Halal',
    es: 'Halal',
    fr: 'Halal',
    hi: 'हलाल',
    ja: 'ハラール',
    'pt-BR': 'Halal',
    ru: 'Халяль',
    'zh-Hans': '清真',
  },
  kosher: {
    en: 'Kosher',
    ar: 'كوشر',
    bn: 'কোশার',
    ca: 'Kosher',
    de: 'Koscher',
    es: 'Kosher',
    fr: 'Casher',
    hi: 'कोशर',
    ja: 'コーシャ',
    'pt-BR': 'Kosher',
    ru: 'Кошерное',
    'zh-Hans': '犹太洁食',
  },
};

/**
 * Every capability key GoWay accepts.
 *
 * `payments.faircoin.accepted` keeps its original spelling, and the other
 * payment methods join it under `payments.`, so the key FairCoin integrated
 * against in 0.1 still names the same assertion. The ecosystem keys keep the
 * `<domain>.<product>.<capability>` shape for the same reason.
 *
 * `accessibility.*` holds the four flags Mercaria records on a pickup
 * location (`stepFreeAccess`, `accessibleToilet`, `parkingOnSite`,
 * `hearingLoop`) plus OpenStreetMap's three-valued `wheelchair`, so a Mercaria
 * location and the GoWay place it trades from say the same thing in one place.
 */
export const CAPABILITY_DEFINITIONS = {
  // ── Accessibility ─────────────────────────────────────────────────────────
  'accessibility.wheelchair': {
    group: 'accessibility',
    labels: {
      en: 'Wheelchair access',
      ar: 'الوصول بالكرسي المتحرك',
      bn: 'হুইলচেয়ারে প্রবেশ',
      ca: 'Accés amb cadira de rodes',
      de: 'Rollstuhlzugang',
      es: 'Acceso en silla de ruedas',
      fr: 'Accès en fauteuil roulant',
      hi: 'व्हीलचेयर से पहुँच',
      ja: '車いす対応',
      'pt-BR': 'Acesso para cadeira de rodas',
      ru: 'Доступ для колясок',
      'zh-Hans': '轮椅通行',
    },
    value: {
      kind: 'enum',
      values: {
        yes: {
          en: 'Wheelchair accessible',
          ar: 'يمكن الوصول بالكرسي المتحرك',
          bn: 'হুইলচেয়ারে প্রবেশযোগ্য',
          ca: 'Accessible amb cadira de rodes',
          de: 'Rollstuhlgerecht',
          es: 'Accesible en silla de ruedas',
          fr: 'Accessible en fauteuil roulant',
          hi: 'व्हीलचेयर से पहुँच योग्य',
          ja: '車いす対応',
          'pt-BR': 'Acessível para cadeira de rodas',
          ru: 'Доступно для колясок',
          'zh-Hans': '轮椅可通行',
        },
        limited: {
          en: 'Partly wheelchair accessible',
          ar: 'وصول جزئي بالكرسي المتحرك',
          bn: 'হুইলচেয়ারে আংশিক প্রবেশযোগ্য',
          ca: 'Parcialment accessible',
          de: 'Teilweise rollstuhlgerecht',
          es: 'Parcialmente accesible',
          fr: 'Partiellement accessible',
          hi: 'व्हीलचेयर से आंशिक पहुँच',
          ja: '一部車いす対応',
          'pt-BR': 'Parcialmente acessível',
          ru: 'Частично доступно для колясок',
          'zh-Hans': '轮椅部分可通行',
        },
        no: {
          en: 'Not wheelchair accessible',
          ar: 'لا يمكن الوصول بالكرسي المتحرك',
          bn: 'হুইলচেয়ারে প্রবেশযোগ্য নয়',
          ca: 'No accessible amb cadira de rodes',
          de: 'Nicht rollstuhlgerecht',
          es: 'No accesible en silla de ruedas',
          fr: 'Non accessible en fauteuil roulant',
          hi: 'व्हीलचेयर से पहुँच नहीं',
          ja: '車いす非対応',
          'pt-BR': 'Sem acesso para cadeira de rodas',
          ru: 'Недоступно для колясок',
          'zh-Hans': '轮椅无法通行',
        },
      },
      absent: ['no'],
    },
    osm: { tags: ['wheelchair'] },
  },
  'accessibility.toilets_wheelchair': {
    group: 'accessibility',
    labels: {
      en: 'Accessible toilet',
      ar: 'دورة مياه مهيأة',
      bn: 'প্রবেশযোগ্য শৌচাগার',
      ca: 'Lavabo adaptat',
      de: 'Barrierefreie Toilette',
      es: 'Aseo adaptado',
      fr: 'Toilettes accessibles',
      hi: 'सुलभ शौचालय',
      ja: '多目的トイレ',
      'pt-BR': 'Banheiro acessível',
      ru: 'Доступный туалет',
      'zh-Hans': '无障碍卫生间',
    },
    value: BOOLEAN,
    osm: { tags: ['toilets:wheelchair'] },
  },
  'accessibility.step_free_entrance': {
    group: 'accessibility',
    labels: {
      en: 'Step-free entrance',
      ar: 'مدخل بلا درجات',
      bn: 'সিঁড়িবিহীন প্রবেশপথ',
      ca: 'Entrada sense graons',
      de: 'Stufenloser Eingang',
      es: 'Entrada sin escalones',
      fr: 'Entrée de plain-pied',
      hi: 'बिना सीढ़ी का प्रवेश',
      ja: '段差のない入口',
      'pt-BR': 'Entrada sem degraus',
      ru: 'Вход без ступенек',
      'zh-Hans': '无台阶入口',
    },
    value: BOOLEAN,
  },
  'accessibility.parking_accessible': {
    group: 'accessibility',
    labels: {
      en: 'Accessible parking',
      ar: 'موقف مهيأ لذوي الإعاقة',
      bn: 'প্রবেশযোগ্য পার্কিং',
      ca: 'Aparcament adaptat',
      de: 'Behindertenparkplatz',
      es: 'Aparcamiento adaptado',
      fr: 'Parking accessible',
      hi: 'सुलभ पार्किंग',
      ja: '車いす用駐車場',
      'pt-BR': 'Estacionamento acessível',
      ru: 'Парковка для инвалидов',
      'zh-Hans': '无障碍停车位',
    },
    value: BOOLEAN,
  },
  'accessibility.hearing_loop': {
    group: 'accessibility',
    labels: {
      en: 'Hearing loop',
      ar: 'حلقة سمعية',
      bn: 'হিয়ারিং লুপ',
      ca: 'Bucle magnètic',
      de: 'Induktionsschleife',
      es: 'Bucle magnético',
      fr: 'Boucle magnétique',
      hi: 'हियरिंग लूप',
      ja: 'ヒアリングループ',
      'pt-BR': 'Aro magnético',
      ru: 'Индукционная петля',
      'zh-Hans': '助听感应环路',
    },
    value: BOOLEAN,
    osm: { tags: ['hearing_loop'], yes: ['yes', 'limited'] },
  },

  // ── Payment ───────────────────────────────────────────────────────────────
  'payments.cash': {
    group: 'payment',
    labels: {
      en: 'Cash',
      ar: 'نقدًا',
      bn: 'নগদ',
      ca: 'Efectiu',
      de: 'Bargeld',
      es: 'Efectivo',
      fr: 'Espèces',
      hi: 'नकद',
      ja: '現金',
      'pt-BR': 'Dinheiro',
      ru: 'Наличные',
      'zh-Hans': '现金',
    },
    value: BOOLEAN,
    osm: { tags: ['payment:cash', 'payment:notes', 'payment:coins'] },
  },
  'payments.cards': {
    group: 'payment',
    labels: {
      en: 'Cards',
      ar: 'البطاقات',
      bn: 'কার্ড',
      ca: 'Targetes',
      de: 'Karten',
      es: 'Tarjetas',
      fr: 'Cartes',
      hi: 'कार्ड',
      ja: 'カード',
      'pt-BR': 'Cartões',
      ru: 'Карты',
      'zh-Hans': '银行卡',
    },
    value: BOOLEAN,
    osm: {
      tags: [
        'payment:cards',
        'payment:credit_cards',
        'payment:debit_cards',
        'payment:visa',
        'payment:mastercard',
      ],
    },
  },
  'payments.contactless': {
    group: 'payment',
    labels: {
      en: 'Contactless',
      ar: 'الدفع دون تلامس',
      bn: 'কন্ট্যাক্টলেস',
      ca: 'Pagament sense contacte',
      de: 'Kontaktlos',
      es: 'Pago sin contacto',
      fr: 'Sans contact',
      hi: 'कॉन्टैक्टलेस',
      ja: 'タッチ決済',
      'pt-BR': 'Pagamento por aproximação',
      ru: 'Бесконтактная оплата',
      'zh-Hans': '非接触支付',
    },
    value: BOOLEAN,
    osm: { tags: ['payment:contactless'] },
  },
  'payments.faircoin.accepted': {
    group: 'payment',
    labels: {
      en: 'Accepts FairCoin',
      ar: 'يقبل FairCoin',
      bn: 'FairCoin গ্রহণ করা হয়',
      ca: 'Accepta FairCoin',
      de: 'Akzeptiert FairCoin',
      es: 'Acepta FairCoin',
      fr: 'Accepte FairCoin',
      hi: 'FairCoin स्वीकार',
      ja: 'FairCoin 対応',
      'pt-BR': 'Aceita FairCoin',
      ru: 'Принимает FairCoin',
      'zh-Hans': '支持 FairCoin',
    },
    value: BOOLEAN,
    osm: { tags: ['payment:faircoin'] },
  },

  // ── Amenities ─────────────────────────────────────────────────────────────
  'amenities.wifi': {
    group: 'amenities',
    labels: {
      en: 'Wi-Fi',
      ar: 'واي فاي',
      bn: 'ওয়াই-ফাই',
      ca: 'Wifi',
      de: 'WLAN',
      es: 'Wifi',
      fr: 'Wi-Fi',
      hi: 'वाई-फ़ाई',
      ja: 'Wi-Fi',
      'pt-BR': 'Wi-Fi',
      ru: 'Wi-Fi',
      'zh-Hans': 'Wi-Fi',
    },
    value: BOOLEAN,
    osm: { tags: ['internet_access'], yes: ['wlan', 'wifi', 'yes'], no: ['no'] },
  },
  'amenities.outdoor_seating': {
    group: 'amenities',
    labels: {
      en: 'Outdoor seating',
      ar: 'جلسات خارجية',
      bn: 'বাইরে বসার জায়গা',
      ca: 'Terrassa',
      de: 'Außenbereich',
      es: 'Terraza',
      fr: 'Terrasse',
      hi: 'बाहर बैठने की जगह',
      ja: 'テラス席',
      'pt-BR': 'Mesas ao ar livre',
      ru: 'Летняя веранда',
      'zh-Hans': '户外座位',
    },
    value: BOOLEAN,
    osm: { tags: ['outdoor_seating'] },
  },
  'amenities.takeaway': {
    group: 'amenities',
    labels: {
      en: 'Takeaway',
      ar: 'طلبات خارجية',
      bn: 'টেকঅ্যাওয়ে',
      ca: 'Per emportar',
      de: 'Zum Mitnehmen',
      es: 'Para llevar',
      fr: 'À emporter',
      hi: 'टेकअवे',
      ja: 'テイクアウト',
      'pt-BR': 'Para viagem',
      ru: 'Еда навынос',
      'zh-Hans': '外带',
    },
    value: BOOLEAN,
    osm: { tags: ['takeaway'], yes: ['yes', 'only'] },
  },
  'amenities.delivery': {
    group: 'amenities',
    labels: {
      en: 'Delivery',
      ar: 'توصيل',
      bn: 'ডেলিভারি',
      ca: 'Lliurament a domicili',
      de: 'Lieferung',
      es: 'Entrega a domicilio',
      fr: 'Livraison',
      hi: 'डिलीवरी',
      ja: 'デリバリー',
      'pt-BR': 'Entrega',
      ru: 'Доставка',
      'zh-Hans': '外卖配送',
    },
    value: BOOLEAN,
    osm: { tags: ['delivery'], yes: ['yes', 'only'] },
  },
  'amenities.reservations': {
    group: 'amenities',
    labels: {
      en: 'Takes reservations',
      ar: 'يقبل الحجوزات',
      bn: 'রিজার্ভেশন নেওয়া হয়',
      ca: 'Accepta reserves',
      de: 'Reservierung möglich',
      es: 'Admite reservas',
      fr: 'Accepte les réservations',
      hi: 'रिज़र्वेशन उपलब्ध',
      ja: '予約可',
      'pt-BR': 'Aceita reservas',
      ru: 'Бронирование столиков',
      'zh-Hans': '可预订',
    },
    value: BOOLEAN,
    osm: { tags: ['reservation'], yes: ['yes', 'required', 'recommended'] },
  },
  'amenities.drive_through': {
    group: 'amenities',
    labels: {
      en: 'Drive-through',
      ar: 'خدمة من السيارة',
      bn: 'ড্রাইভ-থ্রু',
      ca: 'Servei per a cotxes',
      de: 'Drive-in',
      es: 'Servicio para coches',
      fr: 'Drive',
      hi: 'ड्राइव-थ्रू',
      ja: 'ドライブスルー',
      'pt-BR': 'Drive-thru',
      ru: 'Автокафе',
      'zh-Hans': '免下车',
    },
    value: BOOLEAN,
    osm: { tags: ['drive_through'] },
  },
  'amenities.toilets': {
    group: 'amenities',
    labels: {
      en: 'Toilets',
      ar: 'دورات مياه',
      bn: 'শৌচাগার',
      ca: 'Lavabos',
      de: 'Toiletten',
      es: 'Aseos',
      fr: 'Toilettes',
      hi: 'शौचालय',
      ja: 'トイレ',
      'pt-BR': 'Banheiros',
      ru: 'Туалеты',
      'zh-Hans': '卫生间',
    },
    value: BOOLEAN,
    osm: { tags: ['toilets'] },
  },
  'amenities.air_conditioning': {
    group: 'amenities',
    labels: {
      en: 'Air conditioning',
      ar: 'تكييف',
      bn: 'এয়ার কন্ডিশনিং',
      ca: 'Aire condicionat',
      de: 'Klimaanlage',
      es: 'Aire acondicionado',
      fr: 'Climatisation',
      hi: 'एयर कंडीशनिंग',
      ja: 'エアコン',
      'pt-BR': 'Ar-condicionado',
      ru: 'Кондиционер',
      'zh-Hans': '空调',
    },
    value: BOOLEAN,
    osm: { tags: ['air_conditioning'] },
  },

  // ── Food ──────────────────────────────────────────────────────────────────
  'food.cuisine': {
    group: 'food',
    labels: {
      en: 'Cuisine',
      ar: 'المطبخ',
      bn: 'রান্নার ধরন',
      ca: 'Cuina',
      de: 'Küche',
      es: 'Cocina',
      fr: 'Cuisine',
      hi: 'व्यंजन',
      ja: '料理のジャンル',
      'pt-BR': 'Culinária',
      ru: 'Кухня',
      'zh-Hans': '菜系',
    },
    value: { kind: 'enum_set', values: CUISINES },
    osm: { tags: ['cuisine'] },
  },
  'food.diet': {
    group: 'food',
    labels: {
      en: 'Dietary options',
      ar: 'خيارات غذائية',
      bn: 'খাদ্যতালিকার বিকল্প',
      ca: 'Opcions dietètiques',
      de: 'Ernährungsoptionen',
      es: 'Opciones dietéticas',
      fr: 'Options alimentaires',
      hi: 'डाइट विकल्प',
      ja: '食事制限への対応',
      'pt-BR': 'Opções alimentares',
      ru: 'Диетическое меню',
      'zh-Hans': '饮食选择',
    },
    value: { kind: 'enum_set', values: DIETS },
    osm: { prefix: 'diet:', yes: ['yes', 'only'] },
  },

  // ── Price ─────────────────────────────────────────────────────────────────
  'price.level': {
    group: 'price',
    labels: {
      en: 'Price level',
      ar: 'مستوى الأسعار',
      bn: 'দামের স্তর',
      ca: 'Nivell de preu',
      de: 'Preisniveau',
      es: 'Nivel de precio',
      fr: 'Niveau de prix',
      hi: 'क़ीमत का स्तर',
      ja: '価格帯',
      'pt-BR': 'Faixa de preço',
      ru: 'Уровень цен',
      'zh-Hans': '价位',
    },
    value: { kind: 'price_level' },
  },

  // ── Social ────────────────────────────────────────────────────────────────
  'social.instagram': {
    group: 'social',
    labels: {
      en: 'Instagram',
      ar: 'Instagram',
      bn: 'Instagram',
      ca: 'Instagram',
      de: 'Instagram',
      es: 'Instagram',
      fr: 'Instagram',
      hi: 'Instagram',
      ja: 'Instagram',
      'pt-BR': 'Instagram',
      ru: 'Instagram',
      'zh-Hans': 'Instagram',
    },
    value: {
      kind: 'url',
      hosts: ['instagram.com'],
      handle: { url: 'https://www.instagram.com/{handle}', pattern: /^[A-Za-z0-9._]{1,30}$/ },
    },
    osm: { tags: ['contact:instagram', 'instagram'] },
  },
  'social.facebook': {
    group: 'social',
    labels: {
      en: 'Facebook',
      ar: 'Facebook',
      bn: 'Facebook',
      ca: 'Facebook',
      de: 'Facebook',
      es: 'Facebook',
      fr: 'Facebook',
      hi: 'Facebook',
      ja: 'Facebook',
      'pt-BR': 'Facebook',
      ru: 'Facebook',
      'zh-Hans': 'Facebook',
    },
    value: {
      kind: 'url',
      hosts: ['facebook.com', 'fb.com'],
      handle: { url: 'https://www.facebook.com/{handle}', pattern: /^[A-Za-z0-9.-]{1,80}$/ },
    },
    osm: { tags: ['contact:facebook', 'facebook'] },
  },
  'social.x': {
    group: 'social',
    labels: {
      en: 'X',
      ar: 'X',
      bn: 'X',
      ca: 'X',
      de: 'X',
      es: 'X',
      fr: 'X',
      hi: 'X',
      ja: 'X',
      'pt-BR': 'X',
      ru: 'X',
      'zh-Hans': 'X',
    },
    value: {
      kind: 'url',
      hosts: ['x.com', 'twitter.com'],
      handle: { url: 'https://x.com/{handle}', pattern: /^[A-Za-z0-9_]{1,15}$/ },
    },
    osm: { tags: ['contact:x', 'contact:twitter', 'twitter'] },
  },
  'social.tiktok': {
    group: 'social',
    labels: {
      en: 'TikTok',
      ar: 'TikTok',
      bn: 'TikTok',
      ca: 'TikTok',
      de: 'TikTok',
      es: 'TikTok',
      fr: 'TikTok',
      hi: 'TikTok',
      ja: 'TikTok',
      'pt-BR': 'TikTok',
      ru: 'TikTok',
      'zh-Hans': 'TikTok',
    },
    value: {
      kind: 'url',
      hosts: ['tiktok.com'],
      handle: { url: 'https://www.tiktok.com/@{handle}', pattern: /^[A-Za-z0-9._]{1,24}$/ },
    },
    osm: { tags: ['contact:tiktok', 'tiktok'] },
  },
  'social.whatsapp': {
    group: 'social',
    labels: {
      en: 'WhatsApp',
      ar: 'WhatsApp',
      bn: 'WhatsApp',
      ca: 'WhatsApp',
      de: 'WhatsApp',
      es: 'WhatsApp',
      fr: 'WhatsApp',
      hi: 'WhatsApp',
      ja: 'WhatsApp',
      'pt-BR': 'WhatsApp',
      ru: 'WhatsApp',
      'zh-Hans': 'WhatsApp',
    },
    value: {
      kind: 'url',
      hosts: ['wa.me', 'whatsapp.com'],
      handle: { url: 'https://wa.me/{handle}', pattern: /^[0-9]{6,15}$/, digitsOnly: true },
    },
    osm: { tags: ['contact:whatsapp', 'whatsapp'] },
  },

  // ── Brand ─────────────────────────────────────────────────────────────────
  'brand.wikidata': {
    group: 'brand',
    labels: {
      en: 'Brand (Wikidata)',
      ar: 'العلامة التجارية (Wikidata)',
      bn: 'ব্র্যান্ড (Wikidata)',
      ca: 'Marca (Wikidata)',
      de: 'Marke (Wikidata)',
      es: 'Marca (Wikidata)',
      fr: 'Marque (Wikidata)',
      hi: 'ब्रांड (Wikidata)',
      ja: 'ブランド（Wikidata）',
      'pt-BR': 'Marca (Wikidata)',
      ru: 'Бренд (Wikidata)',
      'zh-Hans': '品牌（Wikidata）',
    },
    value: { kind: 'text', maxLength: 16, pattern: /^Q[1-9][0-9]*$/ },
    osm: { tags: ['brand:wikidata'] },
  },

  // ── The Oxy ecosystem ─────────────────────────────────────────────────────
  'commerce.mercaria.store': {
    group: 'ecosystem',
    labels: {
      en: 'Mercaria store',
      ar: 'متجر على Mercaria',
      bn: 'Mercaria স্টোর',
      ca: 'Botiga a Mercaria',
      de: 'Mercaria-Shop',
      es: 'Tienda en Mercaria',
      fr: 'Boutique Mercaria',
      hi: 'Mercaria स्टोर',
      ja: 'Mercaria のストア',
      'pt-BR': 'Loja na Mercaria',
      ru: 'Магазин на Mercaria',
      'zh-Hans': 'Mercaria 店铺',
    },
    // The Mercaria location id, opaque: GoWay stores the reference, Mercaria
    // owns the store.
    value: { kind: 'text', maxLength: 128 },
  },
  'mobility.moovo.pickup': {
    group: 'ecosystem',
    labels: {
      en: 'Moovo pickup point',
      ar: 'نقطة استلام Moovo',
      bn: 'Moovo সংগ্রহের পয়েন্ট',
      ca: 'Punt de recollida Moovo',
      de: 'Moovo-Abholpunkt',
      es: 'Punto de recogida Moovo',
      fr: 'Point de retrait Moovo',
      hi: 'Moovo पिकअप पॉइंट',
      ja: 'Moovo の受け取り場所',
      'pt-BR': 'Ponto de retirada Moovo',
      ru: 'Пункт выдачи Moovo',
      'zh-Hans': 'Moovo 取货点',
    },
    value: BOOLEAN,
  },
  'housing.homiio.listings': {
    group: 'ecosystem',
    labels: {
      en: 'Homiio listings',
      ar: 'إعلانات على Homiio',
      bn: 'Homiio-তে লিস্টিং',
      ca: 'Anuncis a Homiio',
      de: 'Homiio-Inserate',
      es: 'Anuncios en Homiio',
      fr: 'Annonces Homiio',
      hi: 'Homiio लिस्टिंग',
      ja: 'Homiio の物件',
      'pt-BR': 'Anúncios no Homiio',
      ru: 'Объявления на Homiio',
      'zh-Hans': 'Homiio 房源',
    },
    value: { kind: 'integer', min: 0, max: 100_000 },
  },
  'social.mention.location': {
    group: 'ecosystem',
    labels: {
      en: 'Mention location',
      ar: 'موقع على Mention',
      bn: 'Mention-এ লোকেশন',
      ca: 'Ubicació a Mention',
      de: 'Mention-Ort',
      es: 'Ubicación en Mention',
      fr: 'Lieu sur Mention',
      hi: 'Mention लोकेशन',
      ja: 'Mention のスポット',
      'pt-BR': 'Local no Mention',
      ru: 'Место в Mention',
      'zh-Hans': 'Mention 地点',
    },
    value: BOOLEAN,
  },
} as const satisfies Readonly<Record<string, CapabilityDefinition>>;

/** A registered capability key: `accessibility.wheelchair`, `payments.faircoin.accepted`, … */
export type CapabilityKey = keyof typeof CAPABILITY_DEFINITIONS;

/** Every registered key, in display order. */
export const CAPABILITY_KEYS = Object.keys(CAPABILITY_DEFINITIONS) as unknown as readonly [
  CapabilityKey,
  ...CapabilityKey[],
];

/** `Object.hasOwn`, which is ES2022: these contracts ship in the ES2020 SDK bundle. */
function hasOwnKey(object: object, key: string): boolean {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: the contracts ship in the ES2020 SDK bundle, and Object.hasOwn is ES2022.
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** Whether a string is a registered capability key. */
export function isCapabilityKey(value: string): value is CapabilityKey {
  return hasOwnKey(CAPABILITY_DEFINITIONS, value);
}

/** The definition of a key, or `undefined` for a key this build does not know. */
export function capabilityDefinition(key: string): CapabilityDefinition | undefined {
  return isCapabilityKey(key) ? CAPABILITY_DEFINITIONS[key] : undefined;
}

/** The group a key renders under, or `undefined` for a key this build does not know. */
export function capabilityGroupOf(key: string): CapabilityGroup | undefined {
  return capabilityDefinition(key)?.group;
}

/** The kind of value a key holds, or `undefined` for a key this build does not know. */
export function capabilityValueKind(key: string): CapabilityValueKind | undefined {
  return capabilityDefinition(key)?.value.kind;
}

/** The label for a key in a locale; the key itself for one this build does not know. */
export function capabilityLabel(key: string, locale?: string | null): string {
  const definition = capabilityDefinition(key);
  return definition ? localizedLabel(definition.labels, locale) : key;
}

/** The label for one enum value of a key, or the value itself. */
export function capabilityValueLabel(key: string, value: string, locale?: string | null): string {
  const spec = capabilityDefinition(key)?.value;
  const entry =
    spec && (spec.kind === 'enum' || spec.kind === 'enum_set') ? spec.values[value] : undefined;
  return entry ? localizedLabel(entry, locale) : value;
}

/** The label for a group in a locale. */
export function capabilityGroupLabel(group: CapabilityGroup, locale?: string | null): string {
  return localizedLabel(CAPABILITY_GROUP_LABELS[group], locale);
}

// ── Values ──────────────────────────────────────────────────────────────────

/**
 * A capability's stored value: the union of every kind's shape.
 *
 * An enum set is a string array; the other kinds are scalars. The table's
 * CHECK admits exactly these jsonb types.
 */
export const capabilityValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number(),
  z.array(z.string()),
]);
export type CapabilityValue = z.infer<typeof capabilityValueSchema>;

/** A value as a write carries it, before its key's schema is applied. Bounded. */
export const capabilityValueInputSchema = z.union([
  z.boolean(),
  z.string().max(2048),
  z.number(),
  z.array(z.string().max(64)).max(64),
]);

/** `{handle}` substituted, or the URL itself, or `undefined` when neither fits. */
function canonicalUrl(
  spec: Extract<CapabilityValueSpec, { kind: 'url' }>,
  raw: string,
): string | undefined {
  const value = raw.trim();
  // A pattern rather than `URL`: this module runs in every runtime the SDK
  // does, and the global is not one this package may assume a type for.
  const link = /^https?:\/\/([^/?#\s:@]+)(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(value);
  if (link) {
    const host = (link[1] as string).toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
    return spec.hosts && !spec.hosts.includes(host) ? undefined : value;
  }
  if (!spec.handle) return undefined;
  const handle = spec.handle.digitsOnly ? value.replace(/[\s()+.-]/g, '') : value.replace(/^@/, '');
  return spec.handle.pattern.test(handle) ? spec.handle.url.replace('{handle}', handle) : undefined;
}

/**
 * The zod schema for one kind of value, normalizing as it validates.
 *
 * An enum set comes back de-duplicated and in the registry's own order, so the
 * same set is always stored as the same array and two writes of it compare
 * equal. A URL comes back canonical, whether it arrived as a link or a handle.
 */
export function capabilityValueSpecSchema(
  spec: CapabilityValueSpec,
): z.ZodType<CapabilityValue, unknown> {
  switch (spec.kind) {
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum(Object.keys(spec.values) as [string, ...string[]]);
    case 'enum_set': {
      const order = Object.keys(spec.values);
      return z
        .array(z.enum(order as [string, ...string[]]))
        .min(1)
        .max(64)
        .transform((members) => order.filter((value) => members.includes(value)));
    }
    case 'integer':
      return z.number().int().min(spec.min).max(spec.max);
    case 'price_level':
      return z.number().int().min(1).max(4);
    case 'url':
      return z
        .string()
        .max(2048)
        .transform((value, context) => {
          const url = canonicalUrl(spec, value);
          if (url === undefined) {
            context.addIssue({
              code: 'custom',
              message: 'must be a link to this service, or a handle on it',
            });
            return z.NEVER;
          }
          return url;
        });
    case 'text': {
      const text = z.string().trim().min(1).max(spec.maxLength);
      return spec.pattern ? text.regex(spec.pattern) : text;
    }
  }
}

/** The value schema of a registered key. */
export function capabilityValueSchemaFor(key: CapabilityKey): z.ZodType<CapabilityValue, unknown> {
  return capabilityValueSpecSchema(CAPABILITY_DEFINITIONS[key].value);
}

/**
 * Whether a VALUE says the place has the capability.
 *
 * `false`, `0`, `''` and `[]` never do. Beyond that it is the key's to say: an
 * enum value listed in `absent` (`wheelchair = no`) is an assertion that the
 * place does NOT have it. The same rule the `?capabilities=` filter applies
 * server-side.
 */
export function capabilityHolds(key: string, value: CapabilityValue): boolean {
  if (value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  const spec = capabilityDefinition(key)?.value;
  if (spec?.kind === 'enum' && typeof value === 'string' && spec.absent?.includes(value))
    return false;
  return true;
}

/**
 * Every `(key, value)` pair that is asserted but does not hold — the enum
 * values named `absent`. For the SQL half of {@link capabilityHolds}.
 */
export const ABSENT_CAPABILITY_VALUES: readonly (readonly [CapabilityKey, string])[] =
  CAPABILITY_KEYS.flatMap((key) => {
    const spec: CapabilityValueSpec = CAPABILITY_DEFINITIONS[key].value;
    return spec.kind === 'enum' ? (spec.absent ?? []).map((value) => [key, value] as const) : [];
  });

// ── Filters ─────────────────────────────────────────────────────────────────

/** A registered key as a request names it — in a path, or as a bare filter. */
export const capabilityKeySchema = z.enum(CAPABILITY_KEYS);

/**
 * One `?capabilities=` entry: a key, or a key and a value.
 *
 * `payments.faircoin.accepted` matches a place whose strongest assertion of
 * the key holds. `food.cuisine:italian` matches one whose strongest cuisine
 * assertion includes `italian`; `accessibility.wheelchair:limited` one whose
 * strongest wheelchair assertion IS `limited`; `price.level:2` one priced at 2;
 * `commerce.mercaria.store:<locationId>` one whose strongest store link IS that
 * location — a text value matches exactly, after the key's own normalization
 * (trimmed, held to its pattern). A value is accepted for an enum, an enum
 * set, a price level or a text, and only when the key's schema accepts it.
 *
 * Everything after the FIRST `:` is the value, so a text value may itself
 * contain one. It may not contain a comma: a list of filters is one
 * comma-joined query parameter, and a comma would split the value in two.
 */
export interface CapabilityFilter {
  key: CapabilityKey;
  /** The value to match, typed as the key stores it. */
  value?: string | number;
}

/** A filter string read into its parts, or `undefined` when it is not one. */
export function capabilityFilterOf(raw: string): CapabilityFilter | undefined {
  const separator = raw.indexOf(':');
  const key = separator < 0 ? raw : raw.slice(0, separator);
  if (!isCapabilityKey(key)) return undefined;
  if (separator < 0) return { key };

  const text = raw.slice(separator + 1);
  const spec: CapabilityValueSpec = CAPABILITY_DEFINITIONS[key].value;
  if ((spec.kind === 'enum' || spec.kind === 'enum_set') && hasOwnKey(spec.values, text)) {
    return { key, value: text };
  }
  if (spec.kind === 'price_level' && /^[1-4]$/.test(text)) return { key, value: Number(text) };
  if (spec.kind === 'text' && !text.includes(',')) {
    const value = capabilityValueSpecSchema(spec).safeParse(text);
    if (value.success && typeof value.data === 'string') return { key, value: value.data };
  }
  return undefined;
}

/**
 * A filter as a query carries it. Stays a STRING — the SDK sends what this
 * schema outputs — and the server reads it with {@link capabilityFilterOf}.
 */
export const capabilityFilterSchema = z
  .string()
  .max(256)
  .refine((raw) => capabilityFilterOf(raw) !== undefined, {
    message:
      'must be a registered capability key, optionally with :value for an enum, a price level or a text',
  });
