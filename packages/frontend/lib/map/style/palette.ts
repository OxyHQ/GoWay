/**
 * GoWay's **cartographic** palette — deliberately NOT Bloom's product palette.
 *
 * Product chrome and cartography are separate design concerns. Bloom's tokens
 * describe an interface: an accent that must pass contrast against a surface, a
 * danger red that must read as danger. A map describes terrain: its colours sit
 * next to each other in thousands of unplanned combinations, have to carry a
 * hierarchy at every zoom, and have to stay quiet enough that the *content* —
 * labels, search pins, a route line — is what the eye lands on. A brand accent
 * dropped into a landcover fill destroys that, and a landcover green promoted
 * to a button destroys the other. So these values live here, in map terms, and
 * nothing in `components/` or `features/` reads them.
 *
 * ## Where the light palette comes from
 *
 * The anchor colours are the ones the product owner supplied. They arrived as a
 * **Google Maps JS API** style array (`featureType` / `elementType` / `stylers`),
 * which is a different language from a MapLibre style document: Google names
 * abstract feature *classes* and cascades; MapLibre names the vector tile's own
 * `source-layer` and `class` values and does not cascade. So the palette was
 * translated onto the OpenMapTiles schema OpenFreeMap actually serves, feature
 * class by feature class, rather than consumed:
 *
 * | supplied (Google)                      | here                                   |
 * |----------------------------------------|----------------------------------------|
 * | `landscape.man_made` `#f7f1df`         | {@link CartographyPalette.land} and the `landuse` built-up fills |
 * | `landscape.natural` `#d0e3b4`          | {@link CartographyPalette.natural}, i.e. `landcover` wood/grass/scrub |
 * | `landscape.natural.terrain` hidden     | no relief raster, no hillshade, `landcover class=rock` dropped |
 * | `poi.park` `#bde6ab`                   | {@link CartographyPalette.park} — the `park` source-layer + `landuse class=park` |
 * | `poi.medical` `#fbd3da`                | {@link CartographyPalette.medical} — `landuse` hospital |
 * | `transit.station.airport` `#cfb2db`    | {@link CartographyPalette.airport} — the `aeroway` polygons |
 * | `water` `#a2daf2`                      | {@link CartographyPalette.water} |
 * | `road.highway` fill `#ffe15f` / stroke `#efd151` | {@link CartographyPalette.highway} — `motorway` + `trunk` |
 * | `road.arterial` fill `#ffffff`         | {@link CartographyPalette.arterial} — `primary`/`secondary`/`tertiary` |
 * | `road.local` fill black                | {@link CartographyPalette.local} — `minor`/`service`, see `tuning.ts` |
 * | `road` `geometry.stroke` hidden        | casings off everywhere **except** highway, which names a stroke of its own |
 *
 * Three of the supplied rules are contested rather than applied silently —
 * black local roads, hidden road/POI labels, and POIs switched off entirely.
 * Each is a single flag in `tuning.ts` with the argument written next to it.
 *
 * ## Where the dark palette comes from
 *
 * Derived here, from the same hues — not inherited from OpenFreeMap's `fiord`,
 * which is a different map with a different idea of what matters. The rules:
 *
 *  - The base is a deep, desaturated blue-grey charcoal. Never `#000`: pure
 *    black makes an OLED panel look like a hole and leaves nothing underneath
 *    for water to be.
 *  - **Water is darker than land.** In daylight water is the darker mass, so at
 *    night it stays the darker mass or every coastline reads inside-out.
 *  - Accent hues (park green, medical pink, airport violet, highway amber) keep
 *    their hue and lose their lightness and most of their saturation.
 *  - Roads are *lighter* than land, so the network reads as lines of light, and
 *    the tiers keep their supplied ranking — see {@link CartographyPalette.local}.
 *  - Labels are warm off-white over dark halos.
 *
 * Every value is an opaque hex or an `rgba()`; MapLibre parses both on web and
 * native. No `hsl(var(--x))` — that is a Bloom/Tailwind idiom, and a style
 * document is not CSS.
 */

/** A road tier's two-tone recipe: the ribbon, and the line around it. */
export interface RoadTone {
  /** The road surface itself. */
  fill: string;
  /**
   * The casing drawn wider and *underneath*, which is what separates
   * overlapping roads from each other at junctions and interchanges.
   *
   * `null` means the supplied palette hides this tier's stroke, and the layer
   * is not emitted at all — not emitted as transparent, not emitted at width
   * zero. A layer that draws nothing still costs a tile-wide geometry upload.
   */
  casing: string | null;
}

/**
 * Semantic POI groups.
 *
 * The supplied palette colour-codes only three POI families (park, medical,
 * airport). The rest are derived from those three hues so the POI ramp reads as
 * one family rather than a second, unrelated palette. The group names are
 * GoWay's; the OpenMapTiles `class` values each one covers live in `layers.ts`,
 * next to the expression that reads them, because that mapping is schema
 * knowledge and this file is colour.
 */
export interface PoiPalette {
  foodDrink: string;
  shopping: string;
  outdoors: string;
  transit: string;
  lodging: string;
  health: string;
  civic: string;
  culture: string;
  worship: string;
  vehicle: string;
  /** Anything the `match` does not name. Never bright. */
  other: string;
}

export interface CartographyPalette {
  /** Which appearance this palette IS, so a builder cannot mix them up. */
  appearance: 'light' | 'dark';

  // --- Ground ------------------------------------------------------------
  /** `landscape.man_made`. The background under everything. */
  land: string;
  /** Built-up blocks: residential, retail, commercial, industrial. A shade off
   *  {@link land}, never a separate colour. */
  landBuiltUp: string;
  /** `landscape.natural`: the `landcover` fills — wood, grass, scrub, heath. */
  natural: string;
  /** Farmland. Between {@link land} and {@link natural}. */
  farmland: string;
  /** `poi.park`: the `park` source-layer and `landuse class=park`. */
  park: string;
  /** The hairline at a park's edge. Low contrast on purpose. */
  parkOutline: string;
  /** Sports pitches, playgrounds, golf greens. */
  pitch: string;
  /** `poi.medical`: hospital and clinic grounds. */
  medical: string;
  /** Schools, universities, civic campuses. */
  institution: string;
  /** `transit.station.airport`: aprons, terminals, aerodrome polygons. */
  airport: string;
  sand: string;
  wetland: string;
  ice: string;
  cemetery: string;

  // --- Water -------------------------------------------------------------
  water: string;
  /** Rivers and streams drawn as lines rather than polygons. */
  waterway: string;

  // --- Roads -------------------------------------------------------------
  /** `road.highway`: `motorway` and `trunk`. The one tier with a stroke. */
  highway: RoadTone;
  /** Motorway/trunk slip roads. The same colour, thinner. */
  highwayLink: RoadTone;
  /** `road.arterial`: `primary`, `secondary`, `tertiary`. */
  arterial: RoadTone;
  /**
   * `road.local`: `minor` and `service`.
   *
   * The supplied palette asks for **black**, which inverts the usual
   * light-map hierarchy (Apple's local streets are white with a fine casing).
   * It is applied literally and isolated behind `LOCAL_ROAD_FILL` in
   * `tuning.ts`; read the argument there before changing it. The dark palette
   * mirrors the *ranking* rather than the value: in daylight black-on-sand
   * makes local streets the highest-contrast road, so at night they are the
   * lightest one.
   */
  local: RoadTone;
  /** Tracks, alleys and driveways: local, muted. */
  track: RoadTone;
  /** Footways, pedestrian streets, steps, cycleways. */
  path: RoadTone;
  /** Roads passing under something: the same network, dimmed toward {@link land}. */
  tunnel: RoadTone;
  rail: string;
  /** The cross-hatching that makes a railway read as a railway. */
  railHatch: string;
  ferry: string;
  /** Runways and taxiways, drawn over {@link airport}. */
  aeroway: RoadTone;

  // --- Structures --------------------------------------------------------
  building: string;
  buildingOutline: string;

  // --- Administrative ----------------------------------------------------
  boundaryCountry: string;
  boundaryRegion: string;

  // --- Type --------------------------------------------------------------
  /** Cities, towns, villages — the most prominent ink on the map. */
  labelPlace: string;
  /** Neighbourhoods, suburbs, islands: present but secondary. */
  labelPlaceMinor: string;
  /** States, provinces and countries — wide-tracked and lighter. */
  labelRegion: string;
  labelRoad: string;
  labelWater: string;
  labelPark: string;
  labelPoi: string;
  /** The halo behind every label. Generous halos are half of the reason a
   *  label-forward map stays readable over a dense basemap. */
  halo: string;
  /** A stronger halo for labels that sit directly on roads. */
  haloStrong: string;

  poi: PoiPalette;
}

/**
 * Daylight — the supplied palette, translated.
 *
 * The warm sand ground (`#f7f1df`, ~92% lightness at a +45° hue) is the single
 * decision the rest hangs off: on pure white land a white arterial would be
 * invisible, and on neutral grey land the whole map looks printed. Sand keeps
 * `#ffffff` arterials readable as *brighter* than the ground, and gives the
 * yellow highway somewhere to sit.
 */
export const LIGHT_PALETTE: CartographyPalette = {
  appearance: 'light',

  land: '#f7f1df',
  landBuiltUp: '#f2ecd8',
  natural: '#d0e3b4',
  farmland: '#e6e8c6',
  park: '#bde6ab',
  parkOutline: '#a9d894',
  pitch: '#b5dfa2',
  medical: '#fbd3da',
  institution: '#efe9d2',
  airport: '#cfb2db',
  sand: '#f3e6c4',
  wetland: '#c8dcb2',
  ice: '#e6f0f4',
  cemetery: '#d7e3bd',

  water: '#a2daf2',
  waterway: '#96d1ec',

  highway: { fill: '#ffe15f', casing: '#efd151' },
  highwayLink: { fill: '#ffe894', casing: '#efd151' },
  // `road` → `geometry.stroke` → visibility off, in the supplied palette.
  // Highway is the one tier that names a stroke of its own, so it is the one
  // tier that keeps one.
  arterial: { fill: '#ffffff', casing: null },
  local: { fill: '#000000', casing: null },
  track: { fill: '#ded6bb', casing: null },
  path: { fill: '#ddd3b5', casing: null },
  tunnel: { fill: '#eee8d4', casing: null },
  rail: '#d8cdae',
  railHatch: '#c3b78f',
  ferry: '#8dcae8',
  aeroway: { fill: '#e3d0ea', casing: null },

  building: '#eee6cd',
  buildingOutline: '#e0d5b4',

  boundaryCountry: '#c6b894',
  boundaryRegion: '#d8ceb0',

  labelPlace: '#2f2b21',
  labelPlaceMinor: '#4e483a',
  labelRegion: '#5d5646',
  labelRoad: '#6b6452',
  labelWater: '#3f87a8',
  labelPark: '#4e7c3c',
  labelPoi: '#5f5849',
  halo: 'rgba(247,241,223,0.92)',
  haloStrong: '#ffffff',

  // Derived from the three supplied POI hues — park green, medical pink,
  // airport violet — plus the highway amber, so the ramp reads as one family.
  poi: {
    foodDrink: '#d9813f',
    shopping: '#bfa23e',
    outdoors: '#63a64e',
    transit: '#8a68ad',
    lodging: '#7f76bd',
    health: '#d97e8d',
    civic: '#6f8096',
    culture: '#b3689b',
    worship: '#8f869a',
    vehicle: '#6d8fae',
    other: '#93886e',
  },
};

/**
 * Night — derived from the light palette, not from `fiord`.
 *
 * Two inversions that are not inversions:
 *
 *  - Water (`#111a22`) is darker than land (`#23262b`), as it is in daylight.
 *  - The road tiers keep their supplied *ranking*. In daylight the order of
 *    contrast against the ground is local (black) → highway (yellow) →
 *    arterial (white, deliberately quiet on sand). At night that becomes local
 *    (lightest) → highway (amber) → arterial (quiet mid-grey).
 */
export const DARK_PALETTE: CartographyPalette = {
  appearance: 'dark',

  land: '#23262b',
  landBuiltUp: '#272b31',
  natural: '#273020',
  farmland: '#282c22',
  park: '#233620',
  parkOutline: '#2d4229',
  pitch: '#263b23',
  medical: '#35242a',
  institution: '#282a2b',
  airport: '#2e2635',
  sand: '#2e2b23',
  wetland: '#222e22',
  ice: '#262d33',
  cemetery: '#262c23',

  water: '#111a22',
  waterway: '#16222c',

  highway: { fill: '#5f5326', casing: '#7a6a2e' },
  highwayLink: { fill: '#554b25', casing: '#6b5d2a' },
  arterial: { fill: '#3a3e45', casing: null },
  local: { fill: '#8d949d', casing: null },
  track: { fill: '#2f3238', casing: null },
  path: { fill: '#3a3e45', casing: null },
  tunnel: { fill: '#2a2e34', casing: null },
  rail: '#3a3f46',
  railHatch: '#4c525a',
  ferry: '#294050',
  aeroway: { fill: '#373040', casing: null },

  building: '#2a2e34',
  buildingOutline: '#343941',

  boundaryCountry: '#4d535c',
  boundaryRegion: '#3a3f47',

  labelPlace: '#efeade',
  labelPlaceMinor: '#c8c2b4',
  labelRegion: '#b1aa9c',
  labelRoad: '#a7a193',
  labelWater: '#5d95b1',
  labelPark: '#7ba066',
  labelPoi: '#b4ada0',
  halo: 'rgba(18,21,25,0.85)',
  haloStrong: 'rgba(14,17,20,0.95)',

  poi: {
    foodDrink: '#e29656',
    shopping: '#ccb257',
    outdoors: '#74bc5d',
    transit: '#a381c6',
    lodging: '#968dd3',
    health: '#e595a3',
    civic: '#8493a8',
    culture: '#c67cae',
    worship: '#9c93a6',
    vehicle: '#82a3c2',
    other: '#a89d81',
  },
};

/** Both palettes, keyed by appearance. */
export const CARTOGRAPHY_PALETTES = {
  light: LIGHT_PALETTE,
  dark: DARK_PALETTE,
} as const;
