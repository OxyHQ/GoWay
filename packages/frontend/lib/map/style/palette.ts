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
 * ## Where the ground colours come from
 *
 * The anchor hues were supplied by the product owner as a **Google Maps JS API**
 * style array (`featureType` / `elementType` / `stylers`), which is a different
 * language from a MapLibre style document: Google names abstract feature
 * *classes* and cascades; MapLibre names the vector tile's own `source-layer`
 * and `class` values and does not cascade. So the palette was translated onto
 * the OpenMapTiles schema OpenFreeMap serves, feature class by feature class,
 * rather than consumed:
 *
 * | supplied (Google)                      | here                                   |
 * |----------------------------------------|----------------------------------------|
 * | `landscape.man_made` `#f7f1df`         | {@link CartographyPalette.land} and the `landuse` built-up fills |
 * | `landscape.natural` `#d0e3b4`          | {@link CartographyPalette.natural}, i.e. `landcover` wood/grass/scrub |
 * | `landscape.natural.terrain` hidden     | no relief raster, no hillshade, `landcover class=rock` dropped |
 * | `poi.park` `#bde6ab`                   | {@link CartographyPalette.park} — the `park` source-layer + `landuse class=park` |
 * | `poi.medical` `#fbd3da`                | {@link CartographyPalette.medical} — toned down, see below |
 * | `transit.station.airport` `#cfb2db`    | {@link CartographyPalette.airport} — the `aeroway` polygons |
 * | `water` `#a2daf2`                      | {@link CartographyPalette.water} |
 * | `road.highway` `#ffe15f` / `#efd151`   | {@link CartographyPalette.roads} motorway/trunk — desaturated, see below |
 *
 * ## Where the road model comes from — and why it changed
 *
 * The first cut of this style obeyed the supplied array literally: `road` →
 * `geometry.stroke` → `visibility: off` globally, so only the highway tier kept
 * a casing, and `road.local` → `geometry.fill` → black. Shipped and looked at,
 * the first thing the product owner saw was *"unas líneas negras en las
 * carreteras"* — every residential street rendering as a bare black stroke on
 * sand, a black mesh over any dense grid. The verdict was Apple over literal
 * fidelity, so the road model is now Apple's and the supplied road colours are
 * not used:
 *
 *  - **Every class has a casing**, a fine line slightly darker than its fill,
 *    drawn wider and underneath. That is what makes a road read as a *ribbon*
 *    rather than a stroke, and it is what separates overlapping roads at a
 *    junction.
 *  - **Fills are white or near-white**, warming very slightly up the hierarchy.
 *  - **Hierarchy is carried by width, not colour.** A motorway is a wide white
 *    ribbon with a soft warm tint — not a yellow line. The supplied `#ffe15f`
 *    survives only as the *hue* behind a much paler, desaturated tint.
 *
 * The ground colours were never the problem and are unchanged, except
 * {@link CartographyPalette.medical}: `#fbd3da` measured as one of the brightest
 * things on screen at city zoom, louder than any label, so it is now a quiet
 * warm tint in the same family.
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
 *  - Accent hues (park green, medical pink, airport violet, motorway amber)
 *    keep their hue and lose their lightness and most of their saturation.
 *  - Roads are *lighter* than land, so the network reads as lines of light, and
 *    they keep the same width-led hierarchy. Casings go **darker than the
 *    land**, because on a dark ground a casing cannot separate a road from the
 *    terrain — nothing can, the road is already the bright thing — so its only
 *    remaining job is separating roads from each other at an interchange.
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
   * The casing drawn wider and *underneath*.
   *
   * `null` means this tier draws no casing and no casing layer is emitted —
   * not emitted as transparent, not emitted at width zero, because a layer
   * that draws nothing still costs a tile-wide geometry upload. Only
   * footpaths, which are dashed, and anything the `LOCAL_ROAD_FILL` override
   * in `tuning.ts` touches, use it.
   */
  casing: string | null;
}

/**
 * The road hierarchy, in OpenMapTiles `transportation.class` terms.
 *
 * Named after the schema rather than after Google's abstractions (`highway` /
 * `arterial` / `local`) so that a filter and a colour can never disagree about
 * which roads they mean.
 */
export type RoadTier =
  | 'motorway'
  | 'motorwayLink'
  | 'trunk'
  | 'trunkLink'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'local'
  | 'service'
  | 'track'
  | 'path'
  | 'tunnel';

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
  /** `poi.medical`: hospital and clinic grounds, toned to a quiet warm tint. */
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
  /** Every tier's fill + casing. Widths live in `layers.ts`. */
  roads: Record<RoadTier, RoadTone>;
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
 * Daylight.
 *
 * The warm sand ground (`#f7f1df`, ~92% lightness at a +45° hue) is the single
 * decision the rest hangs off: on pure white land a white road would be
 * invisible and the casings would have to carry everything; on neutral grey
 * land the whole map looks printed. Sand makes `#ffffff` read as *brighter*
 * than the ground at every width, which is what lets colour step back and let
 * width do the ranking.
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
  // Supplied as `#fbd3da`. That measured as the loudest thing on a city-zoom
  // screen — a hospital campus outshouting every label near it. Same hue, most
  // of the saturation gone, so it still reads as "not ordinary ground".
  medical: '#f6e3e1',
  institution: '#efe9d2',
  airport: '#ddc9e6',
  sand: '#f3e6c4',
  wetland: '#c8dcb2',
  ice: '#e6f0f4',
  cemetery: '#d7e3bd',

  water: '#a2daf2',
  waterway: '#96d1ec',

  // Fills warm as the hierarchy rises; casings are one step darker than their
  // own fill, never a shared grey. The motorway tint is the supplied `#ffe15f`
  // hue at a fraction of its saturation — warm enough to find the through
  // route at a glance, quiet enough that it is not the first thing you see.
  roads: {
    motorway: { fill: '#fce9bd', casing: '#e7cd8d' },
    motorwayLink: { fill: '#fdeecc', casing: '#e9d3a0' },
    trunk: { fill: '#fdf0d2', casing: '#e9d8a9' },
    trunkLink: { fill: '#fdf3dc', casing: '#ebdcb5' },
    primary: { fill: '#fffdf6', casing: '#e4dbc3' },
    secondary: { fill: '#ffffff', casing: '#e6ddc7' },
    tertiary: { fill: '#ffffff', casing: '#e8e0cc' },
    local: { fill: '#ffffff', casing: '#e6dfc9' },
    service: { fill: '#fdfbf4', casing: '#e9e2cd' },
    track: { fill: '#efe7d0', casing: '#ded4b6' },
    // Footways are dashed, and a dashed line with a casing reads as a ladder.
    path: { fill: '#ddd3b5', casing: null },
    tunnel: { fill: '#f3eddb', casing: '#e7dfc8' },
  },
  rail: '#d8cdae',
  railHatch: '#c3b78f',
  ferry: '#8dcae8',
  aeroway: { fill: '#ece0f1', casing: null },

  // Present, not loud. A footprint should be findable when you look for it and
  // invisible when you are reading a label over it.
  building: '#ebe2c6',
  buildingOutline: '#dccfa8',

  boundaryCountry: '#c6b894',
  boundaryRegion: '#d8ceb0',

  labelPlace: '#2b2720',
  labelPlaceMinor: '#514a3b',
  labelRegion: '#655d4b',
  // Street names recede on Apple's map. Lighter than a place label, never
  // black, and small — see the size ramp in `layers.ts`.
  labelRoad: '#7a7261',
  labelWater: '#3f87a8',
  labelPark: '#4e7c3c',
  labelPoi: '#6a6252',
  halo: 'rgba(247,241,223,0.95)',
  haloStrong: '#ffffff',

  // Derived from the three supplied POI hues — park green, medical pink,
  // airport violet — plus the motorway amber, so the ramp reads as one family.
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
 * Same road model: every tier casinged, hierarchy by width, motorway the one
 * warm tier. Two things invert and neither is an inversion:
 *
 *  - Water (`#111a22`) is darker than land (`#23262b`), as it is in daylight.
 *  - Casings go *below* the land's lightness rather than above their fill's.
 *    A casing's job here is the seam between two roads at an interchange; a
 *    lighter casing would instead draw a halo around every street.
 */
export const DARK_PALETTE: CartographyPalette = {
  appearance: 'dark',

  land: '#23262b',
  landBuiltUp: '#272b31',
  natural: '#273020',
  farmland: '#282c22',
  park: '#1f2e1c',
  parkOutline: '#283a24',
  pitch: '#223420',
  medical: '#2e2729',
  institution: '#282a2b',
  airport: '#2e2635',
  sand: '#2e2b23',
  wetland: '#222e22',
  ice: '#262d33',
  cemetery: '#262c23',

  water: '#111a22',
  waterway: '#16222c',

  roads: {
    motorway: { fill: '#5e5234', casing: '#2b2619' },
    motorwayLink: { fill: '#564c33', casing: '#2b2619' },
    trunk: { fill: '#524a35', casing: '#282318' },
    trunkLink: { fill: '#4b4433', casing: '#282318' },
    primary: { fill: '#4a4f58', casing: '#1a1e23' },
    secondary: { fill: '#454a53', casing: '#1a1e23' },
    tertiary: { fill: '#40454d', casing: '#1a1e23' },
    local: { fill: '#3b4048', casing: '#1a1e23' },
    service: { fill: '#34383f', casing: '#1a1e23' },
    track: { fill: '#2f333a', casing: '#1e2127' },
    path: { fill: '#474c54', casing: null },
    tunnel: { fill: '#2c3036', casing: '#1e2127' },
  },
  rail: '#3a3f46',
  railHatch: '#4c525a',
  ferry: '#294050',
  aeroway: { fill: '#373040', casing: null },

  building: '#2d3138',
  buildingOutline: '#3a4048',

  boundaryCountry: '#4d535c',
  boundaryRegion: '#3a3f47',

  labelPlace: '#f1ede3',
  labelPlaceMinor: '#c5bfb2',
  labelRegion: '#aaa496',
  labelRoad: '#9a958a',
  labelWater: '#5d95b1',
  labelPark: '#7ba066',
  labelPoi: '#aaa499',
  halo: 'rgba(18,21,25,0.88)',
  haloStrong: 'rgba(14,17,20,0.96)',

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
