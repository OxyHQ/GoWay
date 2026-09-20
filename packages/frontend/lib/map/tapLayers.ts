/**
 * The style layers a tap is queried against, for an engine that cannot read its
 * own style back.
 *
 * ## Why this is not symmetrical between the forks, and why that is fine
 *
 * The web fork derives its list from the LOADED style document: it walks
 * `map.getStyle().layers` and keeps the symbol and circle layers whose
 * `source-layer` is one of `labels.ts`'s. That is strictly better where it is
 * possible — it survives a layer rename, it honours the `tuning.ts` flags that
 * omit layers entirely, and it keeps working under the `openfreemap` fallback
 * style, whose layer ids are a vendor's and share nothing with ours.
 *
 * MapLibre **Native** cannot hand the loaded style to JS at all. That is the
 * same limitation `lib/map/provider.ts` documents for `anchors.beforeLabels` —
 * the reason GoWay's style had to RESERVE an anchor id rather than let native
 * derive one — and the answer here is the same: name the ids, from the
 * published contract rather than as string literals.
 *
 * So this module exists for the native fork only. Web never imports it, which
 * is also why importing `lib/map/style/layers.ts` (a ~1000-line layer list that
 * exists to be rendered to JSON at build time) costs the web bundle nothing.
 *
 * The honest consequence, stated rather than hidden: under a style this file
 * has not seen — `EXPO_PUBLIC_MAP_STYLE_URL_*`, or the `openfreemap` fallback —
 * a native build queries layer ids that do not exist and finds no labels, so
 * tapping a basemap label does nothing. Web degrades better there. Owning the
 * tile and style pipeline end to end is what closes that gap.
 */
import { GOWAY_STYLE_LAYER_IDS } from './style/layers';

/**
 * Which of the contract's layers draw a NAME.
 *
 * Every `label-*` id qualifies, and the prefix is the test rather than a hand
 * kept list, so a new tier added to the style is tappable the day it is added
 * rather than the day somebody remembers this file. The style's naming
 * convention is what makes that safe: `label-*` is type, everything else is
 * geometry, and the one symbol layer that is NOT type — `road-oneway`, an
 * arrow — does not carry the prefix.
 */
function isTappableLabelId(id: string): boolean {
  return id.startsWith('label-');
}

/**
 * Style-layer ids a tap is queried against.
 *
 * Derived from {@link GOWAY_STYLE_LAYER_IDS} — the published id contract — so
 * a rename there moves this rather than breaking it silently. The POI dots come
 * in whole: they are the only thing under the finger at the anchor itself (the
 * label is drawn BELOW it), and a tap on the dot has to work.
 */
export const TAP_LAYER_IDS: readonly string[] = [
  ...GOWAY_STYLE_LAYER_IDS.poi,
  ...GOWAY_STYLE_LAYER_IDS.labels.filter(isTappableLabelId),
];

/**
 * Style-layer ids that draw a NAME, for the viewport read that feeds duplicate
 * suppression.
 *
 * The POI dots are deliberately excluded, and the distinction is the whole
 * point of having two lists. `poi-dot` renders from z15 whether or not the
 * label beside it won its collision, so a dot is not evidence that the basemap
 * is showing the user a name — and suppressing GoWay's own chip against a dot
 * would hide the only thing on screen that says what the place is.
 */
export const LABEL_LAYER_IDS: readonly string[] =
  GOWAY_STYLE_LAYER_IDS.labels.filter(isTappableLabelId);
