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
 * ## What this palette is aiming at
 *
 * Apple Maps' **current** cartography, described by property rather than by
 * sample — see the honesty note at the bottom of this block. The properties, in
 * the order they matter:
 *
 *  1. **Very low contrast, and a lot of light.** Until labels are drawn the map
 *     is close to monochrome. Colour appears sparingly and never competes with
 *     type. Every decision below is downstream of this one.
 *  2. **Land is a very pale warm grey**, near-white. The warmth is a hint, not
 *     a tint — enough that white roads read as brighter than the ground, and no
 *     more.
 *  3. **Water is a muted, slightly grey blue.** It is the one large area
 *     allowed any saturation, and even that is restrained.
 *  4. **Green space is soft sage, close in value to the land**, so a park reads
 *     as a calm area rather than a bright patch.
 *  5. **Roads are white.** Motorways are *not* yellow — the hierarchy is width
 *     plus casing strength, with at most a whisper of warmth at the top.
 *  6. **Category tints are nearly gone.** A hospital campus, an airport apron,
 *     a school: present, below the land's own contrast, never the brightest
 *     thing on screen.
 *
 * ## The retired source — READ THIS BEFORE REINTRODUCING ANY HEX BELOW
 *
 * The first two versions of this palette were built from a Google Maps JS API
 * style array supplied as an "Apple Maps" reference. It is
 * **snazzymaps.com/style/42, published 20 November 2013**, by an anonymous
 * author, whose own description claims only that it "largely resembles the
 * Apple Maps theme, albeit somewhat flatter". It imitates **iOS 6/7-era** Apple
 * Maps: creamy land, saturated green, bright blue water, and — the loudest
 * giveaway — **yellow motorways**, which Apple retired years ago. Following it
 * faithfully is precisely what made this map look unlike Apple Maps today.
 *
 * It is recorded here for provenance and for nothing else. **These are not
 * targets.** If a value below drifts back toward one of them, that is a
 * regression, not a restoration:
 *
 * | retired 2013 source (Google)           | what it drove                          |
 * |----------------------------------------|----------------------------------------|
 * | `landscape.man_made` `#f7f1df`         | {@link CartographyPalette.land} — now a pale warm grey |
 * | `landscape.natural` `#d0e3b4`          | {@link CartographyPalette.natural} — now desaturated sage |
 * | `landscape.natural.terrain` hidden     | still hidden: no relief raster, no hillshade, `landcover class=rock` dropped |
 * | `poi.park` `#bde6ab`                   | {@link CartographyPalette.park} — now close in value to the land |
 * | `poi.medical` `#fbd3da`                | {@link CartographyPalette.medical} — now barely a tint |
 * | `transit.station.airport` `#cfb2db`    | {@link CartographyPalette.airport} — now barely a tint |
 * | `water` `#a2daf2`                      | {@link CartographyPalette.water} — now muted and greyer |
 * | `road.highway` `#ffe15f` / `#efd151`   | motorway/trunk — **now white**, see below |
 *
 * The translation *method* still applies to anything new: Google names abstract
 * feature classes and cascades, MapLibre names the vector tile's own
 * `source-layer` and `class` values and does not, so a Google style is
 * translated feature class by feature class, never consumed.
 *
 * ## The road model, which did NOT change
 *
 * The geometry is right and stays. The first cut obeyed the 2013 array
 * literally — `road` → `geometry.stroke` → `visibility: off` globally, so only
 * the highway tier kept a casing, and `road.local` → `geometry.fill` → black.
 * Shipped and looked at, the first thing the product owner saw was *"unas
 * líneas negras en las carreteras"*. The model that replaced it is Apple's and
 * survives this pass untouched:
 *
 *  - **Every class has a casing**, a fine line darker than its fill, drawn
 *    wider and underneath. That is what makes a road read as a *ribbon* rather
 *    than a stroke, and what separates overlapping roads at a junction.
 *  - **Fills are white or near-white**, the whole way up the hierarchy.
 *  - **Hierarchy is carried by width and by casing strength, not by colour.**
 *    A motorway is the widest ribbon with the firmest edge. Its fill carries a
 *    whisper of warmth and nothing more; `#ffe15f` is gone entirely.
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
 *  - Roads are a touch *lighter* than the ground, keeping the same width-led
 *    hierarchy. Casings go **darker than the land**, because on a dark ground a
 *    casing cannot separate a road from the terrain — nothing can, the road is
 *    already the bright thing — so its only remaining job is separating roads
 *    from each other at an interchange.
 *  - Labels are warm off-white over dark halos.
 *
 * ## Honesty note
 *
 * Nobody who worked on this file has seen Apple Maps 2026. These values are
 * reasoned from its design *language* — low contrast, light ground, width-led
 * roads, sparing colour — and not matched against a screenshot or a sample.
 * Treat the result as "built to those properties", not as "matches Apple Maps",
 * and let the person looking at both decide.
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
   * A stronger casing colour used at LOW zoom, fading to {@link casing} by
   * z14.
   *
   * Only the tiers that carry the strategic network set it. At z11 a motorway
   * is a 3.8px ribbon with about a pixel of casing on each side, and on a
   * near-white ground a pale edge at that scale is not an edge — the first
   * render of this palette turned the whole Madrid region into an unreadable
   * white tangle where the A-roads could not be traced. Deepening the casing
   * as you zoom out restores the network without making the same edge look
   * drawn in pencil at z17, where the ribbon is 24px wide and needs no help.
   */
  casingLowZoom?: string;
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
/**
 * Daylight.
 *
 * `#f3f2ef` — a pale warm grey at ~95% lightness with barely 5% saturation —
 * replaces the 2013 array's creamy `#f7f1df`. That single value is most of the
 * change: on a cream ground every white road had to be tinted to stay visible
 * and every landcover had to be saturated to stay distinct, so the whole map
 * drifted warm and bright. On a near-white warm grey, `#ffffff` roads read as
 * brighter than the ground on their own, and green space can be a sage sitting
 * four or five points of lightness below the land instead of a fresh green
 * shouting over it.
 *
 * The road ladder is **casing strength plus width**, never fill colour: a
 * motorway's casing is `#d8d2c4` and a residential street's is `#e7e4dc`, so
 * the firmer edge and the wider ribbon rank together and reinforce each other.
 */
export const LIGHT_PALETTE: CartographyPalette = {
  appearance: 'light',

  land: '#f3f2ef',
  landBuiltUp: '#ebeae6',
  natural: '#dde4d4',
  farmland: '#e8eade',
  park: '#d6e2ca',
  parkOutline: '#c7d7b9',
  pitch: '#cfdcc3',
  // Both of these were vivid enough in the 2013 source to be the brightest
  // thing on a city-zoom screen. They are now a breath away from the land:
  // enough to say "this block is a hospital / an airport", never enough to
  // outrank a label.
  medical: '#f1eae9',
  institution: '#eeeeea',
  airport: '#e9e6ee',
  sand: '#efe9da',
  wetland: '#dbe2d5',
  ice: '#e9eef1',
  cemetery: '#e0e5d7',

  // The one large area allowed any saturation, and even this is restrained:
  // `#a2daf2` was a bright swimming-pool blue that pulled the eye off every
  // label near a river.
  water: '#b5cfdd',
  waterway: '#abc7d7',

  // NO YELLOW ANYWHERE. Motorway fills carry a whisper of warmth — three
  // points, invisible in isolation — so that at region zoom the strategic
  // network reads as very slightly warmer than the arterials beside it. The
  // work is done by the casings, which darken monotonically up the hierarchy.
  roads: {
    motorway: { fill: '#fffdf8', casing: '#d3ccbb', casingLowZoom: '#b9ae95' },
    motorwayLink: { fill: '#fffdf8', casing: '#dad3c4', casingLowZoom: '#c3b9a2' },
    trunk: { fill: '#fffefb', casing: '#d7d0c0', casingLowZoom: '#c0b69f' },
    trunkLink: { fill: '#fffefb', casing: '#ddd6c7', casingLowZoom: '#c7bda7' },
    primary: { fill: '#ffffff', casing: '#dcd8cc', casingLowZoom: '#cbc4b0' },
    secondary: { fill: '#ffffff', casing: '#e0dcd2', casingLowZoom: '#d4cdbc' },
    tertiary: { fill: '#ffffff', casing: '#e3dfd6' },
    local: { fill: '#ffffff', casing: '#e4e1d7' },
    service: { fill: '#fdfdfb', casing: '#eae7df' },
    track: { fill: '#eae6da', casing: '#ddd8c9' },
    // Footways are dashed, and a dashed line with a casing reads as a ladder.
    path: { fill: '#d8d2c3', casing: null },
    tunnel: { fill: '#efeee8', casing: '#e3e0d6' },
  },
  rail: '#d5d1c6',
  railHatch: '#bfbbad',
  ferry: '#9dbfd0',
  aeroway: { fill: '#e6e2ea', casing: null },

  // A very light neutral grey. Present when you look for a footprint, gone
  // when you are reading a label over one.
  building: '#e8e6df',
  buildingOutline: '#d7d4ca',

  boundaryCountry: '#c0bbab',
  boundaryRegion: '#d2cec1',

  // RE-DARKENED for the new ground. The previous values were lightened to
  // recede against a cream land; against a near-white one they would have gone
  // faint, and street names sit on `#ffffff` ribbons where a light warm grey
  // has even less to push against. Place names are near-black; street and POI
  // names are a medium warm grey that still clears 4.5:1 on white.
  labelPlace: '#26251f',
  labelPlaceMinor: '#4a4840',
  labelRegion: '#5f5c52',
  labelRoad: '#6c6a5f',
  // Both of these are DARKER than a blue-grey/green of this family would
  // normally be, because their backgrounds moved: muted water and sage park
  // sit far closer to the land's lightness than the 2013 palette's bright blue
  // and fresh green did. Measured against their own fills rather than eyeballed
  // — `#5b87a3` on `#b5cfdd` is 2.38:1, which is a label you can see is there
  // and cannot read.
  labelWater: '#2d5c75',
  labelPark: '#4a6839',
  labelPoi: '#5e5c51',
  halo: 'rgba(243,242,239,0.95)',
  haloStrong: '#ffffff',

  // The one place the basemap still spends saturation, because a POI dot is
  // content rather than terrain. Pulled back from the previous ramp so the
  // dots sit on a quieter ground without turning a high street into confetti.
  poi: {
    foodDrink: '#cc8450',
    shopping: '#b79a4e',
    outdoors: '#67a05a',
    transit: '#8571a8',
    lodging: '#7d79b3',
    health: '#cc8189',
    civic: '#73808f',
    culture: '#a96f95',
    worship: '#8b8794',
    vehicle: '#6f8da4',
    other: '#8f8b80',
  },
};

/**
 * Night — derived from the light palette, not from `fiord`.
 *
 * Same road model: every tier casinged, hierarchy by width and casing. Two
 * things invert and neither is an inversion:
 *
 *  - Water (`#0f151c`) is darker than land (`#212429`), as it is in daylight.
 *  - Casings go *below* the land's lightness rather than above their fill's.
 *    A casing's job here is the seam between two roads at an interchange; a
 *    lighter casing would instead draw a halo around every street.
 *
 * The ground is a shade deeper and a shade bluer than the previous pass, for
 * the same reason daylight went pale: the less the terrain asserts, the more
 * the labels and the route line have to work with.
 */
export const DARK_PALETTE: CartographyPalette = {
  appearance: 'dark',

  land: '#212429',
  landBuiltUp: '#252930',
  natural: '#242b22',
  farmland: '#262a21',
  park: '#1e2a1c',
  parkOutline: '#273423',
  pitch: '#213021',
  medical: '#2a2528',
  institution: '#262829',
  airport: '#282630',
  sand: '#2a2823',
  wetland: '#212a22',
  ice: '#242b30',
  cemetery: '#242a22',

  water: '#0f151c',
  waterway: '#141d26',

  // Same ladder as daylight, read the other way up: the fill lightens toward
  // the top of the hierarchy and the motorway keeps its whisper of warmth.
  // Casings are one value below the land, so they are a seam at an interchange
  // and nothing at all in open ground.
  roads: {
    motorway: { fill: '#4f5157', casing: '#191c21', casingLowZoom: '#12151a' },
    motorwayLink: { fill: '#4b4d53', casing: '#191c21', casingLowZoom: '#12151a' },
    trunk: { fill: '#494b51', casing: '#191c21', casingLowZoom: '#13161b' },
    trunkLink: { fill: '#45474d', casing: '#191c21', casingLowZoom: '#13161b' },
    primary: { fill: '#42474e', casing: '#191c21', casingLowZoom: '#15181d' },
    secondary: { fill: '#3e434a', casing: '#191c21' },
    tertiary: { fill: '#3a3f46', casing: '#191c21' },
    local: { fill: '#373c43', casing: '#191c21' },
    service: { fill: '#32373d', casing: '#191c21' },
    track: { fill: '#2d3138', casing: '#1c1f25' },
    path: { fill: '#41464d', casing: null },
    tunnel: { fill: '#292d33', casing: '#1c1f25' },
  },
  rail: '#383d44',
  railHatch: '#4a5058',
  ferry: '#25394a',
  aeroway: { fill: '#302c38', casing: null },

  building: '#2b2f35',
  buildingOutline: '#383d45',

  boundaryCountry: '#4a505a',
  boundaryRegion: '#383d45',

  labelPlace: '#f0ede6',
  labelPlaceMinor: '#c3beb3',
  labelRegion: '#a9a498',
  // Lifted for the same reason in reverse: a street name sits ON the road
  // ribbon, and a `#373c43` ribbon is lighter than the land the rest of the
  // type is measured against.
  labelRoad: '#aca79b',
  labelWater: '#5c8ea8',
  labelPark: '#79a06a',
  labelPoi: '#a9a49a',
  halo: 'rgba(16,19,24,0.9)',
  haloStrong: 'rgba(12,15,19,0.96)',

  poi: {
    foodDrink: '#d9945f',
    shopping: '#c2a95f',
    outdoors: '#74b166',
    transit: '#9a85bd',
    lodging: '#8e8ac6',
    health: '#d9929a',
    civic: '#8391a1',
    culture: '#bb82a7',
    worship: '#9a96a3',
    vehicle: '#7f9cb5',
    other: '#a09b8f',
  },
};

/** Both palettes, keyed by appearance. */
export const CARTOGRAPHY_PALETTES = {
  light: LIGHT_PALETTE,
  dark: DARK_PALETTE,
} as const;
