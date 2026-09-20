/**
 * The three places GoWay's style **overrides, or can be made to obey, a
 * contested instruction** — each one flag, each one argued in place.
 *
 * The light palette's ground hues were supplied as a Google Maps JS API style
 * array. Most of it translates onto the OpenMapTiles schema without a judgement
 * call (see `palette.ts`). Three rules did not, and resolving those silently
 * inside a thousand-line layer list is how a product decision becomes
 * undiscoverable. They are hoisted here instead: one constant apiece, flippable
 * in one line, with the reasoning next to the value rather than in a commit
 * message.
 *
 * None of these is a colour. Colours live in `palette.ts`.
 */

/**
 * **1. Local roads.** Supplied as black; the black shipped, was seen, and was
 * rejected. Now `null` — the palette's Apple-like recipe.
 *
 * The supplied array set `road.local` → `geometry.fill` → `#000000` with `road`
 * → `geometry.stroke` hidden, so every residential street, alley and service
 * road rendered as a solid black ribbon with no casing on `#f7f1df` sand. It
 * was implemented literally and isolated here precisely so this moment would be
 * a one-line change. It was: shown the live map, the first thing the product
 * owner said was *"veo unas líneas negras en las carreteras"*, and the
 * instruction became Apple over literal fidelity.
 *
 * `null` means the road tiers come from {@link CartographyPalette.roads}: white
 * fills, a fine casing one step darker on every class, hierarchy carried by
 * width. Setting a colour string here restores the supplied behaviour for the
 * `local` and `service` tiers — the fill becomes that colour and both tiers
 * lose their casing, which is what made the mesh.
 *
 * Note this is not a general "road colour" knob. It exists only to keep the
 * supplied instruction reversible, and reversing it reintroduces a defect the
 * product owner has already rejected once.
 */
export const LOCAL_ROAD_FILL: string | null = null;

/**
 * **2. Road and POI labels stay ON.** Supplied as hidden; overridden.
 *
 * The supplied style sets `road` → `labels` → visibility `off` and `poi` →
 * `labels` → visibility `off`. That is the one rule never applied, because it
 * is not a restyling — it removes the product's core job. GoWay is a map you
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
 * style ships a `poi` source-layer, so dark mode had no basemap POIs at all;
 * GoWay authoring its own style against the same vector schema is what fixes
 * it, and switching POIs off would ship the bug deliberately in both
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
