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
 * ## Every value here is MEASURED
 *
 * Three earlier versions of this file were reasoned — first from a 2013
 * snazzymaps array sold as "Apple Maps-esque", then twice from a description of
 * Apple's design language. All three were wrong, and wrong in the same
 * direction: they assumed the target was quiet, desaturated and near
 * monochrome. It is not. Apple Maps is **warm and saturated in daylight and
 * blue-violet at night**, and it spends real colour on water, parks and the
 * built-up fabric of a city.
 *
 * So this pass stopped reasoning. Apple Maps was captured in a headless browser
 * — eleven views across Manhattan, the New York metro area, JFK, the Catskills,
 * upper Manhattan and central Madrid, in both appearances — and every colour
 * below was sampled off those renders. The method mattered: single pixels are
 * unreliable next to antialiasing and label halos, so each value is the
 * dominant colour of a REGION, and nothing was accepted until it appeared in at
 * least two independent captures. Run-length scans across roads were used to
 * tell a fill from its casing, which no region sample can do.
 *
 * Each field carries its measurement in a trailing comment:
 *   `// #8ddbf6 — light-city 17.8%, jfk 96%, light-wide 20.4%`
 * A field with **(chosen)** was NOT measurable — either Apple does not draw
 * that class, or no capture contained it — and is an interpolation between
 * neighbours. Those are the ones to distrust first.
 *
 * The captures live in `.apple-maps-reference/` and are gitignored: they are
 * someone else's rendering of someone else's data, useful to sample and not
 * ours to redistribute. Once the hexes are recorded here with their provenance,
 * the images have done their job. `shoot.ts` in that folder takes more.
 *
 * ## What the measurements overturned
 *
 * Four structural findings, each of which changed a layer and not just a hex:
 *
 *  1. **Motorways are a solid cool grey, not white and not yellow.** At every
 *     zoom from z10 to z15, Apple draws expressways as an unbroken `#b3b5b9`
 *     ribbon while ordinary streets are `#fefefe` with a cool casing. The
 *     hierarchy inverts the usual one: the biggest road is the *darkest*, not
 *     the brightest. Measured by scanning across the Henry Hudson Parkway, the
 *     FDR and I-495.
 *  2. **The built-up tint is zoom-gated.** `#fef4df` covers 15% of a z14
 *     Manhattan canvas and is entirely absent from a z10 one; the same is true
 *     of its dark counterpart `#45476e`. It fades in, and `layers.ts` fades it
 *     in with it.
 *  3. **Road casings are COOL on warm land.** `#e0e3e6` and `#ced1d4` are
 *     blue-greys sitting on `#f6f4eb` cream. Every previous version of this
 *     file used warm casings, which is why the roads never separated from the
 *     ground the way Apple's do.
 *  4. **Dark mode is blue-violet, not charcoal.** Land `#34445b`, built-up
 *     `#45476e`, water `#1c347a`, parks `#005d5b`. There is no grey in it.
 *
 * ## Honesty
 *
 * These are measurements of Apple Maps as captured on 2026-09-20, at the zooms
 * and in the places listed. They are not a claim that GoWay looks like Apple
 * Maps: GoWay reads a different tile schema, which distinguishes things Apple
 * merges and merges things Apple distinguishes. Where that bites, the field
 * comment says so.
 */

/** A road tier's two-tone recipe: the ribbon, and the line around it. */
export interface RoadTone {
  /** The road surface itself. */
  fill: string;
  /**
   * A different FILL colour used at low zoom, fading to {@link fill} by z13.
   *
   * Apple's expressways are measurably bluer when you zoom out — `#b3baca` in
   * a z10 capture against `#b3b5b9` in a z14 one, and `#889dbf` against
   * `#7d91b1` at night. Small, but it is the difference between a motorway
   * network that reads as a system at region scale and one that reads as
   * scratches, so it is reproduced rather than averaged away.
   */
  fillLowZoom?: string;
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
  /** The halo behind every label. Generous halos are half of the reason a
   *  label-forward map stays readable over a dense basemap. */
  halo: string;
  /** A stronger halo for labels that sit directly on roads. */
  haloStrong: string;

  poi: PoiPalette;
  /**
   * The same category hues, as TEXT.
   *
   * Apple's single strongest cartographic device is that a POI's *label* is
   * printed in its category's colour, not just its pin: a view of Barcelona at
   * z16 contains ~1380 coloured glyph components and ~340 neutral ones, so the
   * coloured type IS the map. Measured on `apple-bcn-z16-light`; GoWay scored
   * 83 to 380 the other way round before this field existed.
   *
   * It cannot be {@link poi} itself. A pin is a filled disc and reads at
   * 3:1; text is thin strokes and needs 4.5:1, and `#fc791e` on the halo cream
   * is **2.41:1** — Apple ships that, and a product with an accessibility floor
   * cannot. So every hue here is its {@link poi} twin walked down (light) or up
   * (dark) its own lightness axis, hue and saturation untouched, until it
   * clears 4.5:1. The family survives the walk: the orange is still the orange
   * next to the green, which is the entire job the colour is doing.
   *
   * Contrast is quoted against the HALO, because a haloed glyph sits on its
   * halo and not on the ground — light `#f6f4eb`, dark the 0.9-alpha halo over
   * land, `#29364a` effective. The light values additionally clear 4.5:1
   * against `#fefefe`, the brightest thing a POI label can land on (a street).
   *
   * This REPLACES a single `labelPoi` grey (`#3b3d3d` / `#b9c5d4`), which is
   * why that field is gone: a POI label now has no colour of its own, only its
   * category's. `other` is the grey an unmapped class falls to.
   *
   * On a DARK ground the brightening cannot go further without losing the
   * device. Walking the same hues to 6.5:1 instead of 4.5:1 collapses civic and
   * vehicle onto the same `#c8d1f1` and turns the orange into `#ffc6a0`, at
   * which point there are no longer eleven distinguishable categories — so
   * dark mode's POI type is measurably dimmer than Apple's and stays that way.
   */
  poiLabel: PoiPalette;
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
 * Daylight — measured from `light-city.png` (Manhattan z14), `light-wide.png`
 * (NY metro z10), `campus-light.png` (upper Manhattan z15),
 * `madrid-light.png` (central Madrid z15), `jfk-light.png` (JFK z13) and
 * `rural-light.png` (Catskills z9).
 *
 * The two values that set everything else: land `#f6f4eb`, a warm cream at 31%
 * of a city canvas, and water `#8ddbf6`, a genuinely vivid cyan at 18%. Every
 * previous version of this file had the land too grey and the water far too
 * desaturated, and those two errors dragged the rest of the palette with them.
 */
export const LIGHT_PALETTE: CartographyPalette = {
  appearance: 'light',

  land: '#f6f4eb', // light-city 31.3%; campus/jfk agree; light-wide reads #f5f1ea
  landBuiltUp: '#fef4df', // light-city 14.6%; madrid-light #fef5e3. Zoom-gated, see layers.ts
  natural: '#c2e5a8', // rural-light forest mass (hillshaded #bcdea3..#c4e6ab)
  farmland: '#f2f0e2', // (chosen) rural-light draws farmland as bare land; a hair off land
  park: '#c6e9a8', // light-city; campus-light #b7dd9d under its own shading
  parkOutline: '#bce2a0', // (chosen) Apple draws NO park outline — kept near-invisible
  pitch: '#cdebb0', // madrid-light Prado gardens; light-wide #cce8b5
  medical: '#fbebe8', // campus-light (CUIMC) + madrid-light (Hospital de la VOT)
  institution: '#edede6', // campus-light, the Columbia/NewYork-Presbyterian blocks
  airport: '#dbe5ee', // jfk-light aerodrome polygon 57%
  sand: '#efe3cc', // (chosen) no capture contained a drawn beach
  wetland: '#e3ecc2', // jfk-light Jamaica Bay salt marsh
  ice: '#e8f3f7', // (chosen) no capture contained ice
  cemetery: '#d9e7c4', // (chosen) between park and pitch

  water: '#8ddbf6', // light-city 17.8%, jfk-light 96%, light-wide 20.4% — identical in all
  waterway: '#8ddbf6', // rural-light rivers render in the same cyan

  // THE INVERSION. Apple's expressways are a solid cool grey at every zoom
  // measured, while ordinary streets are white with a cool casing — so the
  // most important road is the DARKEST thing in the network, not the
  // brightest. Verified by run-length scans across the Henry Hudson Parkway
  // (campus-light), the FDR (light-city) and I-495 (light-wide).
  roads: {
    // The grey tiers' casings sit only ONE step under their fill. Apple's
    // expressway ribbon reads as a single uniform grey with a hairline edge;
    // a casing as dark as an ordinary road's turns it into a heavy dark band
    // at region zoom, which is what the first render of this palette did.
    motorway: { fill: '#b3b5b9', casing: '#a8abb0', fillLowZoom: '#b3baca' }, // fill light-city/campus; fillLowZoom light-wide; casing (chosen)
    motorwayLink: { fill: '#bfc1c5', casing: '#b1b4b9' }, // (chosen) one step off motorway
    trunk: { fill: '#c4c7ca', casing: '#b6b9bd' }, // (chosen) between motorway grey and white
    trunkLink: { fill: '#cdcfd2', casing: '#bfc2c6' }, // (chosen)
    primary: { fill: '#fefefe', casing: '#ced1d4' }, // fill + casing both light-city
    secondary: { fill: '#fefefe', casing: '#d8dadd' }, // (chosen) between the two measured casings
    tertiary: { fill: '#fefefe', casing: '#e0e3e6' }, // light-city, madrid-light
    local: { fill: '#fefefe', casing: '#e0e3e6' }, // light-city, madrid-light, campus-light
    service: { fill: '#fdfdfc', casing: '#e6e8ea' }, // (chosen) one step quieter than local
    track: { fill: '#efece4', casing: '#ddd9cf' }, // fill = jfk-light unpaved/terminal tone
    // Footways are dashed, and a dashed line with a casing reads as a ladder.
    path: { fill: '#d8d3c6', casing: null }, // (chosen) madrid-light draws them as dotted tan
    tunnel: { fill: '#eceef0', casing: '#dcdee1' }, // (chosen)
  },
  rail: '#c9ccd0', // (chosen) campus-light shows a thin grey line with hatching
  railHatch: '#aeb2b7', // (chosen)
  ferry: '#7cc4dd', // (chosen) light-wide draws ferry routes as a dotted blue
  aeroway: { fill: '#cad9e3', casing: null }, // jfk-light runway 87%; apron reads #d6e4ec

  // Apple draws only NOTABLE buildings as distinct shapes (#e7e4dc with a
  // #b0aea8 edge, measured on the Royal Palace); ordinary ones melt into the
  // block tint at #fdf4e2. GoWay draws every footprint the tile carries, so
  // taking the notable-building grey would turn a dense city into a grey mass
  // Apple never shows. This sits between the two.
  building: '#f7eed9', // (chosen) between measured #fdf4e2 (ordinary) and #e7e4dc (notable)
  buildingOutline: '#e4d9bd', // (chosen)

  boundaryCountry: '#b8b3a6', // (chosen) light-wide draws a thin grey dashed line
  boundaryRegion: '#c9c4b8', // (chosen)

  labelPlace: '#222222', // light-wide "New York" / "Newark" — near-black, not a soft grey
  // DARKENED from the measured #747979, which lands at 4.01:1 on the built-up
  // cream. Apple can afford that; a product with an accessibility floor cannot.
  labelPlaceMinor: '#646969', // measured #747979 -> 5.10:1 (a11y divergence)
  labelRegion: '#6a6f6f', // (chosen) 4.63:1 on land; #8a8f8f would be 2.97:1
  // 4.9:1 on the white street fill that carries almost every road label. Over
  // the grey motorway ribbon no text colour reaches 4.5:1 without going
  // near-black, so there the 1.3px white halo is the mechanism — see the
  // divergence table in the README.
  labelRoad: '#636766', // (chosen)
  labelWater: '#245f7c', // (chosen) 4.53:1 on #8ddbf6; a lighter blue cannot clear it
  labelPark: '#166a2f', // measured #1f823d -> 4.98:1 (a11y divergence; measured is 3.62:1)
  halo: 'rgba(246,244,235,0.95)', // the land colour, which is what Apple haloes with
  haloStrong: '#ffffff',

  // Apple's own category colours, sampled from the pin glyphs in madrid-light.
  // These are the one place the basemap is allowed to be vivid, and Apple is
  // very vivid here — `#fc791e` is a real orange, not a muted terracotta.
  poi: {
    foodDrink: '#fc791e', // madrid-light restaurant pins
    shopping: '#f4aa0b', // madrid-light shop/supermarket pins
    outdoors: '#23ae48', // madrid-light park/garden pins
    transit: '#1a64e5', // madrid-light metro/rail pins
    lodging: '#a568e3', // madrid-light hotel pins
    health: '#f25283', // madrid-light hospital/pharmacy pins
    civic: '#5b71cb', // madrid-light civic/attraction pins
    culture: '#e76ec3', // madrid-light museum/theatre pins
    worship: '#8a7fb8', // (chosen) between lodging and civic
    vehicle: '#5f75ce', // (chosen) civic blue, one step lighter
    other: '#8d8f8f', // (chosen) neutral grey for an unnamed class
  },

  // Each one is its `poi` twin darkened until it clears 4.5:1 on the halo
  // cream, hue and saturation held. The trailing numbers are `halo / white
  // street` — the second is the worst ground a POI label lands on.
  poiLabel: {
    foodDrink: '#bc4e03', // from #fc791e (2.41:1) -> 4.51:1 / 4.92:1
    shopping: '#926607', // from #f4aa0b (1.80:1) -> 4.62:1 / 5.05:1
    outdoors: '#1a7f35', // from #23ae48 (2.64:1) -> 4.61:1 / 5.04:1
    transit: '#1a64e5', // already 4.77:1 / 5.21:1 — unchanged
    lodging: '#9248dd', // from #a568e3 (3.35:1) -> 4.55:1 / 4.97:1
    health: '#da104e', // from #f25283 (3.02:1) -> 4.58:1 / 5.00:1
    civic: '#5169c8', // from #5b71cb (4.08:1) -> 4.53:1 / 4.95:1
    culture: '#cb2299', // from #e76ec3 (2.57:1) -> 4.51:1 / 4.92:1
    worship: '#7466aa', // from #8a7fb8 (3.28:1) -> 4.51:1 / 4.93:1
    vehicle: '#5169ca', // from #5f75ce (3.87:1) -> 4.51:1 / 4.93:1
    other: '#6e7070', // from #8d8f8f (2.95:1) -> 4.52:1 / 4.94:1
  },
};

/**
 * Night — measured from `dark-city.png` (Manhattan z14), `dark-wide.png`
 * (NY metro z10), `madrid-dark.png` (central Madrid z15) and `jfk-dark.png`.
 *
 * **There is no grey in it.** Apple's dark map is a blue-violet: slate-blue
 * land, violet built-up blocks, deep indigo water, teal-green parks. Every
 * previous version of this file used a desaturated charcoal, which is why dark
 * mode read as a different product from light mode rather than the same map at
 * night.
 */
export const DARK_PALETTE: CartographyPalette = {
  appearance: 'dark',

  land: '#34445b', // dark-city 27.9%; dark-wide/jfk-dark read #314256
  landBuiltUp: '#45476e', // dark-city 13.0%; madrid-dark #42496a. Zoom-gated like its light twin
  natural: '#1c3e3a', // (chosen) dark-wide leaves forest untinted; teal, between land and park
  farmland: '#333f4f', // (chosen)
  park: '#005d5b', // dark-city, dark-wide, madrid-dark — all three agree
  parkOutline: '#00706d', // (chosen) Apple draws none
  pitch: '#016b63', // (chosen) one step brighter than park
  medical: '#404458', // dark-city, the Bellevue/NYU blocks
  institution: '#3b4560', // (chosen) between land and built-up
  airport: '#314d76', // jfk-dark aerodrome polygon 58%
  sand: '#3a4053', // (chosen)
  wetland: '#16655f', // jfk-dark Jamaica Bay marsh
  ice: '#36485e', // (chosen)
  cemetery: '#2a4a48', // (chosen)

  water: '#1c347a', // dark-city 16.6%, jfk-dark 96%; dark-wide reads #213782
  waterway: '#1c347a',

  // Dark inverts the light hierarchy back the usual way round: the expressway
  // is the BRIGHTEST road, ordinary streets are dimmer, and one casing colour
  // sits between the land and the street for all of them.
  roads: {
    motorway: { fill: '#7d91b1', casing: '#43536b', fillLowZoom: '#889dbf' }, // dark-city FDR; fillLowZoom dark-wide
    motorwayLink: { fill: '#75889f', casing: '#43536b' }, // (chosen)
    trunk: { fill: '#7a8ba1', casing: '#43536b' }, // dark-city
    trunkLink: { fill: '#72839a', casing: '#43536b' }, // (chosen)
    primary: { fill: '#6d7f97', casing: '#43536b' }, // (chosen) between trunk and secondary
    secondary: { fill: '#63758d', casing: '#43536b' }, // dark-city, madrid-dark
    tertiary: { fill: '#63758d', casing: '#43536b' }, // dark-city, madrid-dark
    local: { fill: '#5d6d82', casing: '#43536b' }, // jfk-dark residential streets
    service: { fill: '#526277', casing: '#3d4b60' }, // jfk-dark
    track: { fill: '#4a5a6e', casing: '#3a485d' }, // (chosen)
    path: { fill: '#5a6a7f', casing: null }, // jfk-dark
    tunnel: { fill: '#43536b', casing: '#3a485d' }, // dark-city
  },
  rail: '#55647a', // (chosen)
  railHatch: '#6d7f97', // (chosen)
  ferry: '#2f4a86', // (chosen)
  aeroway: { fill: '#304b73', casing: null }, // jfk-dark runway 87%

  building: '#4c4f74', // (chosen) between measured #42496a (block) and #637690 (notable)
  buildingOutline: '#5b5f86', // (chosen)

  boundaryCountry: '#5b6b81', // (chosen)
  boundaryRegion: '#45536a', // (chosen)

  labelPlace: '#dae4ed', // dark-wide "New York"; dark-city agrees
  labelPlaceMinor: '#bcc8d6', // measured #a5b4c6 -> 5.20:1 (a11y divergence)
  labelRegion: '#abb7c6', // (chosen) 4.86:1 on land
  // Lifted as far as it can usefully go. Against the dark motorway fill
  // (#7d91b1) even pure white only reaches 3.20:1, so 4.5:1 is arithmetically
  // unreachable there for ANY text colour — the dark halo carries it instead.
  labelRoad: '#f2f5f9', // (chosen) 4.31:1 on ordinary streets
  labelWater: '#7fa8d8', // (chosen)
  labelPark: '#7ee0b4', // (chosen) 4.86:1 on #005d5b
  halo: 'rgba(40,53,72,0.9)', // a shade under the land, which is what Apple haloes with
  haloStrong: 'rgba(32,42,58,0.95)',

  // The same Apple category hues, lifted for a dark ground.
  poi: {
    foodDrink: '#ff9147', // (chosen) dark-city food pins read brighter than light's #fc791e
    shopping: '#f8bc3a',
    outdoors: '#3fc667',
    transit: '#4a89f0',
    lodging: '#b98bee',
    health: '#f9789d',
    civic: '#7f93de',
    culture: '#f08ed6',
    worship: '#a79ccd',
    vehicle: '#8397e0',
    other: '#a6a9ad',
  },

  // Lifted rather than darkened — on a dark ground the legible direction is up.
  // Contrast is quoted on the halo (`rgba(40,53,72,0.9)` over land, `#29364a`
  // effective), then on bare land, which is the softer of the two.
  poiLabel: {
    foodDrink: '#ff944c', // from #ff9147 (4.42:1 land) -> 5.57:1 / 4.52:1
    shopping: '#f8bc3a', // already 7.12:1 / 5.77:1 — unchanged
    outdoors: '#41c769', // from #3fc667 (4.47:1) -> 5.58:1 / 4.52:1
    transit: '#87b1f5', // from #4a89f0 (2.89:1) -> 5.60:1 / 4.54:1
    lodging: '#c59ff1', // from #b98bee (3.76:1) -> 5.58:1 / 4.52:1
    health: '#fa90af', // from #f9789d (3.86:1) -> 5.62:1 / 4.55:1
    civic: '#9faee6', // from #7f93de (3.36:1) -> 5.62:1 / 4.55:1
    culture: '#f090d7', // from #f08ed6 (4.49:1) -> 5.62:1 / 4.56:1
    worship: '#b3aad4', // from #a79ccd (3.90:1) -> 5.59:1 / 4.53:1
    vehicle: '#9eade7', // from #8397e0 (3.52:1) -> 5.57:1 / 4.51:1
    other: '#adafb3', // from #a6a9ad (4.19:1) -> 5.56:1 / 4.50:1
  },
};

/** Both palettes, keyed by appearance. */
export const CARTOGRAPHY_PALETTES = {
  light: LIGHT_PALETTE,
  dark: DARK_PALETTE,
} as const;
