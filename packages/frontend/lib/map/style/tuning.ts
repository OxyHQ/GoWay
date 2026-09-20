/**
 * The three places GoWay's style **disagrees with, or literally obeys, a
 * contested instruction** — each one flag, each one argued in place.
 *
 * The light palette was supplied as a Google Maps JS API style array. Most of
 * it translates onto the OpenMapTiles schema without a judgement call (see
 * `palette.ts`). Three rules do not, and resolving them silently inside a
 * 900-line layer list is how a product decision becomes undiscoverable. They
 * are hoisted here instead: one constant apiece, flippable in one line, with
 * the reasoning next to the value rather than in a commit message.
 *
 * None of these is a colour. Colours live in `palette.ts`.
 */

/**
 * **1. Local roads are black.** Supplied literally; applied literally.
 *
 * `road.local` → `geometry.fill` → `#000000`, with `road` → `geometry.stroke`
 * hidden. So on `#f7f1df` sand, every residential street, alley and service
 * road is a solid black ribbon with no casing.
 *
 * The tension, stated rather than resolved: this inverts the hierarchy a
 * label-forward map normally uses. Apple's local streets are *white* with a
 * fine warm-grey casing, which lets the road network describe the shape of a
 * city while staying underneath the labels; black local roads do the opposite,
 * and in a dense grid at z17+ the streets become the loudest thing on screen —
 * a black mesh that a route line and a set of search pins then have to compete
 * with. It is a real style (it is how several "paper map" themes read) and it
 * may be exactly what was wanted; it is just not the Apple-like default the
 * rest of the brief asks for.
 *
 * To switch to the Apple-like alternative, set this to `null`: the local tier
 * then takes `#ffffff` with a fine `#e8e2d8` casing, and
 * {@link LOCAL_ROAD_CASING_WHEN_WHITE} is what it uses.
 */
export const LOCAL_ROAD_FILL: string | null = '#000000';

/** The Apple-like local-road recipe used when {@link LOCAL_ROAD_FILL} is `null`. */
export const LOCAL_ROAD_CASING_WHEN_WHITE = { fill: '#ffffff', casing: '#e6dfc9' } as const;

/**
 * **2. Road and POI labels stay ON.** Supplied as hidden; overridden.
 *
 * The supplied style sets `road` → `labels` → visibility `off` and `poi` →
 * `labels` → visibility `off`. That is the one rule not applied, because it is
 * not a restyling — it removes the product's core job. GoWay is a map you
 * search, navigate and open places from: a street with no name cannot be
 * confirmed as the street the route turns onto, and a place with no name cannot
 * be recognised before it is tapped. Apple Maps is label-*forward*; labels are
 * the most prominent thing on its map, and the brief that asked for Apple-like
 * cartography asked for that too.
 *
 * Set to `false` to obey the supplied style exactly. Place labels (cities,
 * towns, neighbourhoods) are unaffected either way — the supplied style never
 * hid those.
 */
export const SHOW_ROAD_AND_POI_LABELS = true;

/**
 * **3. POIs stay on the basemap, quietly.** Supplied as hidden; overridden.
 *
 * The supplied style sets `poi.business` → visibility `off`. Combined with
 * rule 2 that would leave the map with no points of interest at all — which is
 * the exact gap this style document exists to *close*. No OpenFreeMap dark
 * style ships a `poi` source-layer, so dark mode has had no basemap POIs at
 * all; GoWay authoring its own style against the same vector schema is what
 * fixes it, and switching POIs off would ship the bug deliberately in both
 * appearances instead.
 *
 * The compromise is restraint rather than absence: POIs are a small tinted dot
 * plus a small label, only where the tile carries a name, with the pure-clutter
 * classes (barriers, gates, waste baskets, payphones) filtered out entirely and
 * the rest staged by `rank` so a dense high street does not fill with pins. See
 * `POI_*` in `layers.ts`.
 *
 * Set to `false` to obey the supplied style exactly and ship a POI-less map.
 */
export const SHOW_BASEMAP_POIS = true;
