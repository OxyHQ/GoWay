/**
 * Taxi paint where a city's taxis wear a statutory colour — Barcelona's
 * black with yellow doors, New York's yellow. These are municipal liveries,
 * not an operator's brand, so a generic simulated taxi may wear them; nowhere
 * else gets taxis at all (their slots are ordinary saloons), because a
 * plausible-looking local taxi that a city does not have would be invented
 * detail (`docs/MAP_CITY_LIFE.md` → Honesty).
 *
 * Boxes, approximate at their edges, like `drivingSide.ts`.
 */
export interface TaxiLivery {
  /** Body paint, sRGB 0–255. */
  body: [number, number, number];
  /** Door panels. */
  doors: [number, number, number];
}

const LIVERIES: readonly { box: [number, number, number, number]; livery: TaxiLivery }[] = [
  {
    // Àrea Metropolitana de Barcelona.
    box: [1.9, 41.25, 2.35, 41.55],
    livery: { body: [40, 40, 44], doors: [238, 200, 70] },
  },
  {
    // New York City.
    box: [-74.26, 40.49, -73.69, 40.92],
    livery: { body: [242, 198, 64], doors: [242, 198, 64] },
  },
];

export function taxiLiveryAt(lng: number, lat: number): TaxiLivery | null {
  for (const { box, livery } of LIVERIES) {
    if (lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3]) return livery;
  }
  return null;
}
