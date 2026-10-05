/**
 * The place category taxonomy — one closed tree of dotted keys.
 *
 * `food.cafe`, `shop.books`, `transport.rail_station`. A key's PARENT is the
 * key minus its last segment, so the tree is spelled by the keys themselves and
 * cannot disagree with a separate parent column. Every root is a browseable
 * group ("Food & drink"); every child is something a place IS.
 *
 * ## Closed, and enforced at three layers
 *
 * `places.categories` holds taxonomy keys and nothing else: a CHECK built from
 * {@link CATEGORY_KEYS} refuses any other string, the write schemas refuse one
 * as a 422, and the list filters refuse one too. Before this registry the
 * column was free text — the importer wrote OpenMapTiles' `cafe` and
 * `food_drink`, the docs promised `food.cafe`, and the app drew `coworking`,
 * which no writer ever produced. A closed set is what makes a category filter
 * mean the same thing to every caller.
 *
 * Responses are looser on purpose: a published place's categories are read as
 * dotted keys without checking membership, so a category GoWay ADDS is not a
 * parse failure in an SDK built before it.
 *
 * ## Filtering a parent means its descendants
 *
 * A place stores its most specific keys; `?categories=food` matches
 * `food.cafe` and `food.bakery` through {@link categoryDescendants}. Storing
 * ancestors as well would make every key a second write and a second thing to
 * keep consistent.
 *
 * ## The OpenStreetMap mapping lives here, as data
 *
 * Each entry lists the `key=value` tags that file an element under it; `key=*`
 * is a key-wide fallback. The importer reads this table and holds no category
 * vocabulary of its own, so adding a category is one entry here plus the
 * migration that widens the CHECK. The mapping is NOT part of the published
 * {@link Category} shape — OpenStreetMap is one source among the ones GoWay
 * reconciles, never the definition of a category.
 */

import { z } from 'zod';
import { localizedLabel, localizedLabelsSchema, type LocalizedLabels } from './labels';
import { pageSchema } from './pagination';

/**
 * The glyph a category is drawn with, as a provider-neutral key.
 *
 * Each client maps these to its own drawings (the GoWay app to Bloom icons);
 * the key travels instead of an icon file so a client is never asked to fetch
 * artwork to render a pin.
 */
export const CATEGORY_ICONS = [
  'place',
  'restaurant',
  'cafe',
  'bar',
  'nightlife',
  'bakery',
  'grocery',
  'shop',
  'clothing',
  'book',
  'gift',
  'beauty',
  'electronics',
  'hardware',
  'laundry',
  'pet',
  'hotel',
  'camping',
  'park',
  'nature',
  'water',
  'entertainment',
  'sport',
  'golf',
  'museum',
  'art',
  'theatre',
  'cinema',
  'music',
  'landmark',
  'information',
  'bus',
  'train',
  'subway',
  'ferry',
  'bike',
  'car',
  'fuel',
  'parking',
  'charging',
  'hospital',
  'health',
  'pharmacy',
  'school',
  'civic',
  'police',
  'mail',
  'toilets',
  'bank',
  'worship',
  'office',
  'tools',
] as const;
export type CategoryIcon = (typeof CATEGORY_ICONS)[number];

/** One registry entry, as the registry holds it. */
export interface CategoryDefinition<K extends string = string> {
  readonly key: K;
  readonly icon: CategoryIcon;
  readonly labels: LocalizedLabels;
  /** `key=value` OpenStreetMap tags filed here; `key=*` is a key-wide fallback. */
  readonly osm: readonly string[];
}

function category<const K extends string>(
  key: K,
  icon: CategoryIcon,
  en: string,
  es: string,
  osm: readonly string[] = [],
): CategoryDefinition<K> {
  return { key, icon, labels: { en, es }, osm };
}

/**
 * The taxonomy. Roots first within each block, children after their root.
 *
 * Order is presentation order for {@link CATEGORIES}: the roots read as a
 * browse menu, and a child list reads from the commonest to the least.
 */
export const CATEGORY_DEFINITIONS = [
  // ── Food & drink ──────────────────────────────────────────────────────────
  category('food', 'restaurant', 'Food & drink', 'Comida y bebida'),
  category('food.restaurant', 'restaurant', 'Restaurant', 'Restaurante', ['amenity=restaurant']),
  category('food.fast_food', 'restaurant', 'Fast food', 'Comida rápida', ['amenity=fast_food', 'amenity=food_court']),
  category('food.cafe', 'cafe', 'Café', 'Cafetería', ['amenity=cafe', 'shop=coffee', 'shop=tea']),
  category('food.bar', 'bar', 'Bar', 'Bar', ['amenity=bar']),
  category('food.pub', 'bar', 'Pub', 'Pub', ['amenity=pub', 'amenity=biergarten']),
  category('food.nightclub', 'nightlife', 'Nightclub', 'Discoteca', ['amenity=nightclub']),
  category('food.ice_cream', 'cafe', 'Ice cream', 'Heladería', ['amenity=ice_cream', 'shop=ice_cream']),
  category('food.bakery', 'bakery', 'Bakery', 'Panadería', ['shop=bakery', 'shop=pastry']),
  category('food.confectionery', 'bakery', 'Sweets', 'Dulcería', ['shop=confectionery', 'shop=chocolate']),

  // ── Shops ─────────────────────────────────────────────────────────────────
  category('shop', 'shop', 'Shops', 'Tiendas', ['shop=*']),
  category('shop.supermarket', 'grocery', 'Supermarket', 'Supermercado', ['shop=supermarket', 'shop=wholesale']),
  category('shop.convenience', 'grocery', 'Convenience store', 'Tienda de conveniencia', ['shop=convenience']),
  category('shop.greengrocer', 'grocery', 'Greengrocer', 'Frutería', ['shop=greengrocer']),
  category('shop.butcher', 'grocery', 'Butcher', 'Carnicería', ['shop=butcher', 'shop=seafood']),
  category('shop.deli', 'grocery', 'Delicatessen', 'Charcutería', ['shop=deli', 'shop=delicatessen', 'shop=cheese']),
  category('shop.marketplace', 'grocery', 'Market', 'Mercado', ['amenity=marketplace']),
  category('shop.alcohol', 'bar', 'Wine & spirits', 'Vinos y licores', ['shop=alcohol', 'shop=wine', 'shop=beverages']),
  category('shop.books', 'book', 'Bookshop', 'Librería', ['shop=books']),
  category('shop.clothes', 'clothing', 'Clothes', 'Ropa', ['shop=clothes', 'shop=boutique', 'shop=bag', 'shop=fashion_accessories']),
  category('shop.shoes', 'clothing', 'Shoes', 'Zapatería', ['shop=shoes']),
  category('shop.jewelry', 'gift', 'Jewellery', 'Joyería', ['shop=jewelry', 'shop=watches']),
  category('shop.gift', 'gift', 'Gifts & souvenirs', 'Regalos y recuerdos', ['shop=gift', 'shop=souvenir']),
  category('shop.florist', 'nature', 'Florist', 'Floristería', ['shop=florist', 'shop=garden_centre']),
  category('shop.hardware', 'hardware', 'Hardware', 'Ferretería', ['shop=hardware', 'shop=doityourself', 'shop=paint']),
  category('shop.furniture', 'shop', 'Home & furniture', 'Hogar y muebles', [
    'shop=furniture',
    'shop=interior_decoration',
    'shop=houseware',
    'shop=bed',
    'shop=carpet',
    'shop=curtain',
    'shop=lamps',
  ]),
  category('shop.electronics', 'electronics', 'Electronics', 'Electrónica', [
    'shop=electronics',
    'shop=mobile_phone',
    'shop=computer',
    'shop=hifi',
    'shop=video_games',
    'shop=camera',
  ]),
  category('shop.beauty', 'beauty', 'Beauty', 'Belleza', ['shop=beauty', 'shop=cosmetics', 'shop=perfumery', 'shop=perfume']),
  category('shop.hairdresser', 'beauty', 'Hairdresser', 'Peluquería', ['shop=hairdresser', 'shop=barber']),
  category('shop.optician', 'shop', 'Optician', 'Óptica', ['shop=optician', 'shop=hearing_aids']),
  category('shop.chemist', 'pharmacy', 'Drugstore', 'Droguería', ['shop=chemist']),
  category('shop.department_store', 'shop', 'Department store', 'Grandes almacenes', [
    'shop=department_store',
    'shop=mall',
    'shop=variety_store',
  ]),
  category('shop.sports', 'sport', 'Sports shop', 'Tienda de deportes', ['shop=sports', 'shop=outdoor']),
  category('shop.bicycle', 'bike', 'Bicycle shop', 'Tienda de bicicletas', ['shop=bicycle']),
  category('shop.music', 'music', 'Music shop', 'Tienda de música', ['shop=music', 'shop=musical_instrument']),
  category('shop.toys', 'gift', 'Toys', 'Juguetería', ['shop=toys']),
  category('shop.stationery', 'book', 'Stationery', 'Papelería', ['shop=stationery', 'shop=copyshop']),
  category('shop.newsagent', 'book', 'Newsagent', 'Quiosco', ['shop=newsagent', 'shop=kiosk']),
  category('shop.tobacco', 'shop', 'Tobacconist', 'Estanco', ['shop=tobacco', 'shop=e-cigarette']),
  category('shop.pet', 'pet', 'Pet shop', 'Tienda de mascotas', ['shop=pet']),
  category('shop.laundry', 'laundry', 'Laundry', 'Lavandería', ['shop=laundry', 'shop=dry_cleaning']),
  category('shop.second_hand', 'shop', 'Second-hand', 'Segunda mano', ['shop=second_hand', 'shop=charity', 'shop=antiques']),
  category('shop.art', 'art', 'Art & framing', 'Arte y marcos', ['shop=art', 'shop=frame', 'shop=craft']),
  category('shop.travel_agency', 'shop', 'Travel agency', 'Agencia de viajes', ['shop=travel_agency']),

  // ── Stay ──────────────────────────────────────────────────────────────────
  category('lodging', 'hotel', 'Stay', 'Alojamiento'),
  category('lodging.hotel', 'hotel', 'Hotel', 'Hotel', ['tourism=hotel', 'tourism=motel']),
  category('lodging.hostel', 'hotel', 'Hostel', 'Albergue', ['tourism=hostel', 'building=dormitory']),
  category('lodging.guest_house', 'hotel', 'Guest house', 'Casa de huéspedes', ['tourism=guest_house', 'tourism=bed_and_breakfast']),
  category('lodging.apartment', 'hotel', 'Holiday apartment', 'Apartamento turístico', ['tourism=apartment', 'tourism=chalet']),
  category('lodging.camping', 'camping', 'Campsite', 'Cámping', ['tourism=camp_site', 'tourism=caravan_site']),
  category('lodging.hut', 'camping', 'Mountain hut', 'Refugio', ['tourism=alpine_hut', 'tourism=wilderness_hut']),

  // ── Leisure ───────────────────────────────────────────────────────────────
  category('leisure', 'park', 'Leisure', 'Ocio', ['leisure=*']),
  category('leisure.park', 'park', 'Park', 'Parque', ['leisure=park']),
  category('leisure.garden', 'nature', 'Garden', 'Jardín', ['leisure=garden']),
  category('leisure.playground', 'park', 'Playground', 'Parque infantil', ['leisure=playground']),
  category('leisure.dog_park', 'pet', 'Dog park', 'Parque para perros', ['leisure=dog_park']),
  category('leisure.picnic_site', 'park', 'Picnic area', 'Zona de pícnic', ['tourism=picnic_site']),
  category('leisure.nature_reserve', 'nature', 'Nature reserve', 'Reserva natural', ['leisure=nature_reserve']),
  category('leisure.beach', 'water', 'Beach', 'Playa', ['leisure=beach_resort', 'leisure=swimming_area']),
  category('leisure.marina', 'ferry', 'Marina', 'Puerto deportivo', ['leisure=marina', 'waterway=dock']),
  category('leisure.water', 'water', 'Lake or reservoir', 'Lago o embalse', ['landuse=reservoir', 'landuse=basin']),
  category('leisure.amusement', 'entertainment', 'Amusement', 'Entretenimiento', [
    'tourism=theme_park',
    'leisure=amusement_arcade',
    'leisure=escape_game',
    'leisure=bowling_alley',
    'leisure=water_park',
  ]),
  category('leisure.fitness', 'sport', 'Gym', 'Gimnasio', ['leisure=fitness_centre', 'leisure=fitness_station']),

  // ── Sport ─────────────────────────────────────────────────────────────────
  category('sport', 'sport', 'Sport', 'Deporte', ['sport=*']),
  category('sport.centre', 'sport', 'Sports centre', 'Polideportivo', ['leisure=sports_centre', 'leisure=sports_hall']),
  category('sport.pitch', 'sport', 'Sports pitch', 'Pista deportiva', ['leisure=pitch', 'leisure=track']),
  category('sport.stadium', 'sport', 'Stadium', 'Estadio', ['leisure=stadium']),
  category('sport.swimming', 'water', 'Swimming pool', 'Piscina', ['leisure=swimming_pool', 'sport=swimming']),
  category('sport.golf', 'golf', 'Golf', 'Golf', ['leisure=golf_course', 'leisure=miniature_golf', 'sport=golf']),
  category('sport.ice_rink', 'sport', 'Ice rink', 'Pista de hielo', ['leisure=ice_rink']),
  category('sport.horse_riding', 'sport', 'Horse riding', 'Hípica', ['leisure=horse_riding', 'sport=equestrian']),
  category('sport.climbing', 'sport', 'Climbing', 'Escalada', ['sport=climbing']),
  category('sport.skiing', 'sport', 'Skiing', 'Esquí', ['landuse=winter_sports', 'sport=skiing']),

  // ── Culture & sights ──────────────────────────────────────────────────────
  category('culture', 'museum', 'Culture & sights', 'Cultura y turismo', ['tourism=*']),
  category('culture.museum', 'museum', 'Museum', 'Museo', ['tourism=museum']),
  category('culture.gallery', 'art', 'Gallery', 'Galería', ['tourism=gallery', 'amenity=arts_centre']),
  category('culture.theatre', 'theatre', 'Theatre', 'Teatro', ['amenity=theatre']),
  category('culture.cinema', 'cinema', 'Cinema', 'Cine', ['amenity=cinema']),
  category('culture.music_venue', 'music', 'Music venue', 'Sala de conciertos', ['amenity=music_venue', 'amenity=concert_hall']),
  category('culture.attraction', 'landmark', 'Attraction', 'Atracción', ['tourism=attraction']),
  category('culture.viewpoint', 'landmark', 'Viewpoint', 'Mirador', ['tourism=viewpoint']),
  category('culture.artwork', 'art', 'Public art', 'Arte público', ['tourism=artwork']),
  category('culture.zoo', 'pet', 'Zoo', 'Zoo', ['tourism=zoo']),
  category('culture.aquarium', 'water', 'Aquarium', 'Acuario', ['tourism=aquarium']),
  category('culture.information', 'information', 'Tourist information', 'Información turística', ['tourism=information']),
  category('culture.historic', 'landmark', 'Historic site', 'Sitio histórico', ['historic=*']),
  category('culture.monument', 'landmark', 'Monument', 'Monumento', ['historic=monument', 'historic=memorial']),
  category('culture.castle', 'landmark', 'Castle', 'Castillo', ['historic=castle', 'historic=fort', 'historic=ruins']),
  category('culture.archaeological_site', 'landmark', 'Archaeological site', 'Yacimiento arqueológico', [
    'historic=archaeological_site',
  ]),

  // ── Transport ─────────────────────────────────────────────────────────────
  category('transport', 'subway', 'Transport', 'Transporte'),
  category('transport.bus_stop', 'bus', 'Bus stop', 'Parada de autobús', ['highway=bus_stop']),
  category('transport.bus_station', 'bus', 'Bus station', 'Estación de autobuses', ['amenity=bus_station']),
  category('transport.rail_station', 'train', 'Train station', 'Estación de tren', ['railway=station', 'railway=halt']),
  category('transport.tram_stop', 'train', 'Tram stop', 'Parada de tranvía', ['railway=tram_stop']),
  category('transport.aerialway', 'subway', 'Cable car', 'Teleférico', ['aerialway=station']),
  category('transport.ferry_terminal', 'ferry', 'Ferry terminal', 'Terminal de ferris', ['amenity=ferry_terminal']),
  category('transport.taxi', 'car', 'Taxi rank', 'Parada de taxis', ['amenity=taxi']),
  category('transport.bicycle_rental', 'bike', 'Bike hire', 'Alquiler de bicicletas', ['amenity=bicycle_rental']),
  category('transport.car_rental', 'car', 'Car hire', 'Alquiler de coches', ['amenity=car_rental', 'amenity=car_sharing']),

  // ── Vehicles ──────────────────────────────────────────────────────────────
  category('vehicle', 'car', 'Car & vehicle', 'Vehículos'),
  category('vehicle.fuel', 'fuel', 'Petrol station', 'Gasolinera', ['amenity=fuel']),
  category('vehicle.charging', 'charging', 'EV charging', 'Recarga eléctrica', ['amenity=charging_station']),
  category('vehicle.parking', 'parking', 'Parking', 'Aparcamiento', ['amenity=parking', 'amenity=parking_entrance']),
  category('vehicle.repair', 'tools', 'Car repair', 'Taller mecánico', ['shop=car_repair', 'shop=car_parts', 'shop=tyres']),
  category('vehicle.dealer', 'car', 'Car dealer', 'Concesionario', ['shop=car']),
  category('vehicle.car_wash', 'car', 'Car wash', 'Lavado de coches', ['amenity=car_wash']),
  category('vehicle.motorcycle', 'car', 'Motorcycles', 'Motos', ['shop=motorcycle']),

  // ── Health ────────────────────────────────────────────────────────────────
  category('health', 'health', 'Health', 'Salud'),
  category('health.hospital', 'hospital', 'Hospital', 'Hospital', ['amenity=hospital']),
  category('health.clinic', 'health', 'Clinic', 'Centro de salud', ['amenity=clinic']),
  category('health.doctor', 'health', 'Doctor', 'Médico', ['amenity=doctors']),
  category('health.dentist', 'health', 'Dentist', 'Dentista', ['amenity=dentist']),
  category('health.pharmacy', 'pharmacy', 'Pharmacy', 'Farmacia', ['amenity=pharmacy']),
  category('health.veterinary', 'pet', 'Vet', 'Veterinario', ['amenity=veterinary']),
  category('health.care_home', 'health', 'Care home', 'Residencia', ['amenity=nursing_home', 'amenity=social_facility']),

  // ── Education ─────────────────────────────────────────────────────────────
  category('education', 'school', 'Education', 'Educación'),
  category('education.school', 'school', 'School', 'Escuela', ['amenity=school']),
  category('education.kindergarten', 'school', 'Nursery', 'Guardería', ['amenity=kindergarten', 'amenity=childcare']),
  category('education.university', 'school', 'University', 'Universidad', ['amenity=university', 'amenity=college']),
  category('education.library', 'book', 'Library', 'Biblioteca', ['amenity=library']),
  category('education.training', 'school', 'Courses & training', 'Formación', [
    'amenity=language_school',
    'amenity=driving_school',
    'amenity=music_school',
  ]),

  // ── Public services ───────────────────────────────────────────────────────
  category('civic', 'civic', 'Public services', 'Servicios públicos'),
  category('civic.townhall', 'civic', 'Town hall', 'Ayuntamiento', ['amenity=townhall']),
  category('civic.courthouse', 'civic', 'Courthouse', 'Juzgado', ['amenity=courthouse']),
  category('civic.police', 'police', 'Police', 'Policía', ['amenity=police']),
  category('civic.fire_station', 'civic', 'Fire station', 'Bomberos', ['amenity=fire_station']),
  category('civic.post_office', 'mail', 'Post office', 'Oficina de correos', ['amenity=post_office']),
  category('civic.post_box', 'mail', 'Post box', 'Buzón', ['amenity=post_box', 'amenity=parcel_locker']),
  category('civic.community_centre', 'civic', 'Community centre', 'Centro cívico', [
    'amenity=community_centre',
    'amenity=social_centre',
    'leisure=hackerspace',
  ]),
  category('civic.embassy', 'civic', 'Embassy', 'Embajada', ['amenity=embassy', 'office=diplomatic']),
  category('civic.toilets', 'toilets', 'Toilets', 'Aseos', ['amenity=toilets']),
  category('civic.cemetery', 'landmark', 'Cemetery', 'Cementerio', ['landuse=cemetery', 'amenity=grave_yard']),

  // ── Money ─────────────────────────────────────────────────────────────────
  category('finance', 'bank', 'Money', 'Dinero'),
  category('finance.bank', 'bank', 'Bank', 'Banco', ['amenity=bank']),
  category('finance.atm', 'bank', 'Cash machine', 'Cajero automático', ['amenity=atm']),
  category('finance.exchange', 'bank', 'Currency exchange', 'Cambio de divisas', ['amenity=bureau_de_change']),

  // ── Worship ───────────────────────────────────────────────────────────────
  category('worship', 'worship', 'Place of worship', 'Lugar de culto', ['amenity=place_of_worship', 'amenity=monastery']),

  // ── Services, offices and trades ──────────────────────────────────────────
  category('services', 'tools', 'Services', 'Servicios', ['amenity=*']),
  category('office', 'office', 'Offices', 'Oficinas', ['office=*']),
  category('office.coworking', 'office', 'Coworking', 'Coworking', ['amenity=coworking_space', 'office=coworking']),
  category('office.company', 'office', 'Company', 'Empresa', ['office=company']),
  category('office.government', 'civic', 'Government office', 'Oficina pública', ['office=government']),
  category('office.estate_agent', 'office', 'Estate agent', 'Inmobiliaria', ['office=estate_agent']),
  category('office.lawyer', 'office', 'Lawyer', 'Abogado', ['office=lawyer', 'office=notary']),
  category('office.insurance', 'office', 'Insurance', 'Seguros', ['office=insurance']),
  category('craft', 'tools', 'Trades', 'Oficios', ['craft=*']),
  category('craft.brewery', 'bar', 'Brewery', 'Cervecera', ['craft=brewery', 'craft=distillery']),
  category('craft.winery', 'bar', 'Winery', 'Bodega', ['craft=winery']),
] as const;

/** A taxonomy key: `food.cafe`, `shop`, `transport.rail_station`. */
export type CategoryKey = (typeof CATEGORY_DEFINITIONS)[number]['key'];

/** Every key, in registry order. What the `places.categories` CHECK is built from. */
export const CATEGORY_KEYS = CATEGORY_DEFINITIONS.map((entry) => entry.key) as unknown as readonly [
  CategoryKey,
  ...CategoryKey[],
];

const DEFINITION_BY_KEY: ReadonlyMap<string, CategoryDefinition<CategoryKey>> = new Map(
  CATEGORY_DEFINITIONS.map((entry) => [entry.key, entry]),
);

/** Whether a string is a key of the taxonomy. */
export function isCategoryKey(value: string): value is CategoryKey {
  return DEFINITION_BY_KEY.has(value);
}

/** A registry entry by key, or `undefined` for a key this build does not know. */
export function categoryDefinition(key: string): CategoryDefinition<CategoryKey> | undefined {
  return DEFINITION_BY_KEY.get(key);
}

/** The parent key, or `null` for a root. Derived from the key itself. */
export function categoryParent(key: string): string | null {
  const separator = key.lastIndexOf('.');
  return separator < 0 ? null : key.slice(0, separator);
}

/** The root a key belongs to: `food.cafe` → `food`. */
export function categoryRoot(key: string): string {
  const separator = key.indexOf('.');
  return separator < 0 ? key : key.slice(0, separator);
}

/**
 * A key and every key below it, in registry order — what `?categories=food`
 * matches. A key outside the taxonomy expands to nothing.
 */
export function categoryDescendants(key: string): CategoryKey[] {
  if (!isCategoryKey(key)) return [];
  const prefix = `${key}.`;
  return CATEGORY_KEYS.filter((candidate) => candidate === key || candidate.startsWith(prefix));
}

/**
 * The label for a category in a locale, falling back to English; the key
 * itself for a key this build does not know, so an unknown category is
 * identifiable rather than blank.
 */
export function categoryLabel(key: string, locale?: string | null): string {
  const definition = DEFINITION_BY_KEY.get(key);
  return definition ? localizedLabel(definition.labels, locale) : key;
}

// ── The published shapes ────────────────────────────────────────────────────

/** A taxonomy key as a request names it: a member of the registry, or a 422. */
export const categoryKeySchema = z.enum(CATEGORY_KEYS);

/**
 * A category key as a RESPONSE carries it: any dotted lower-case key.
 *
 * Deliberately not the closed enum. A category GoWay adds must not make every
 * SDK built before it reject the places that carry it.
 */
export const publishedCategoryKeySchema = z.string().regex(/^[a-z0-9_]+(?:[.][a-z0-9_]+)*$/);

/** One category as `GET /categories` publishes it. */
export const categorySchema = z.object({
  key: publishedCategoryKeySchema,
  /** The enclosing category, `null` for a root. */
  parent: publishedCategoryKeySchema.nullable(),
  /** A provider-neutral glyph key; each client draws it its own way. */
  icon: z.string().min(1),
  /** English always; every other language GoWay has the category in, by canonical tag. */
  labels: localizedLabelsSchema,
});
export type Category = z.infer<typeof categorySchema>;

export const categoryPageSchema = pageSchema(categorySchema);
export type CategoryPage = z.infer<typeof categoryPageSchema>;

/** The whole taxonomy, in the published shape and in registry order. */
export const CATEGORIES: readonly Category[] = CATEGORY_DEFINITIONS.map((entry) => ({
  key: entry.key,
  parent: categoryParent(entry.key),
  icon: entry.icon,
  labels: entry.labels,
}));

const CATEGORY_BY_KEY: ReadonlyMap<string, Category> = new Map(CATEGORIES.map((entry) => [entry.key, entry]));

/** One category in the published shape, or `undefined` for a key this build does not know. */
export function categoryOf(key: string): Category | undefined {
  return CATEGORY_BY_KEY.get(key);
}
