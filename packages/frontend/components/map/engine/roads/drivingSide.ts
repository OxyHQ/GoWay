/**
 * Which side of the road simulated cars keep to.
 *
 * OSM records `driving_side` on country boundaries, not on ways, and the
 * simulation has no boundaries; so this is a coarse table of the larger
 * left-hand-traffic places, as boxes. It is a SIMULATION parameter: wrong near
 * a border (Hong Kong beside Shenzhen, the two sides of the Thai–Lao border),
 * and stated as approximate in `docs/MAP_CITY_LIFE.md`. Everywhere else keeps
 * right.
 */
export type DrivingSide = 'right' | 'left';

/**
 * `[west, south, east, north]` boxes that drive on the left, cut so that no
 * right-hand capital or large city falls inside one (Seoul, Busan, Kabul,
 * Phnom Penh, Vientiane, Kigali, Lubumbashi were each checked).
 */
const LEFT_HAND: readonly (readonly [number, number, number, number])[] = [
  [-8.7, 49.8, 1.8, 60.9], // Great Britain
  [-10.7, 51.3, -5.4, 55.5], // Ireland and Northern Ireland
  [129.5, 30.9, 146.0, 45.6], // Japan: Honshu, Shikoku, Kyushu, Hokkaido
  [128.5, 30.9, 129.5, 34.2], // Japan: Nagasaki, Goto, Tsushima (Busan is north of it)
  [122.9, 24.0, 131.4, 30.9], // Japan: the Ryukyus
  [68.1, 5.9, 88.2, 30.5], // India, Nepal, Sri Lanka, the Maldives
  [88.0, 20.6, 92.2, 27.5], // Bangladesh, Bhutan, north-east India
  [60.9, 23.6, 71.0, 30.5], // Pakistan, south-west (Kandahar is north of it)
  [71.0, 30.0, 75.5, 35.0], // Pakistan, north-east (Kabul is west of it)
  [112.9, -44.0, 154.0, -10.0], // Australia
  [166.0, -47.5, 178.6, -34.0], // New Zealand
  [94.9, -11.1, 141.1, 6.1], // Indonesia, Timor-Leste, Papua's west
  [141.0, -11.7, 156.0, -1.0], // Papua New Guinea
  [99.6, 0.8, 119.3, 7.4], // Malaysia, Brunei, Singapore
  [98.0, 5.6, 101.0, 20.5], // Thailand, west and Bangkok
  [101.0, 12.5, 102.6, 17.8], // Thailand, east (Vientiane is north of it)
  [102.6, 14.4, 105.6, 17.2], // Thailand, Isan (Cambodia is south of it)
  [113.8, 22.15, 114.45, 22.53], // Hong Kong
  [113.5, 22.1, 113.6, 22.22], // Macau
  [11.7, -34.9, 33.0, -17.0], // Southern Africa: South Africa, Namibia, Botswana, Lesotho, Eswatini
  [25.2, -22.5, 33.1, -15.6], // Zimbabwe
  [22.0, -18.1, 33.7, -12.6], // Zambia, south (Lubumbashi is north of it)
  [28.5, -12.6, 33.7, -8.2], // Zambia, north-east
  [30.2, -26.9, 40.9, -10.4], // Mozambique, Malawi
  [30.8, -11.8, 40.5, -1.0], // Tanzania (Kigali and Bujumbura are west of it)
  [33.9, -4.7, 41.0, 5.0], // Kenya
  [29.9, -1.0, 35.0, 4.2], // Uganda
  [-61.4, 1.2, -53.9, 8.6], // Guyana, Suriname
  [-61.9, 10.0, -60.5, 11.4], // Trinidad and Tobago
  [-78.4, 17.7, -76.2, 18.6], // Jamaica
  [-79.5, 20.9, -72.7, 27.3], // The Bahamas
  [-59.7, 13.0, -59.4, 13.4], // Barbados
  [32.2, 34.5, 34.6, 35.7], // Cyprus
  [14.1, 35.8, 14.6, 36.1], // Malta
];

export function drivingSideAt(lng: number, lat: number): DrivingSide {
  for (const [west, south, east, north] of LEFT_HAND) {
    if (lng >= west && lng <= east && lat >= south && lat <= north) return 'left';
  }
  return 'right';
}
