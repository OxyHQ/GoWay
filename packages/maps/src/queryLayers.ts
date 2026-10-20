/**
 * Which style layers a press and a label read are queried against, derived
 * from the style document itself.
 *
 * Deriving beats naming: layers can be flag-gated, renamed, or absent from a
 * style GoWay did not author, and the OpenMapTiles `source-layer` is the part
 * no style gets to rename. Web reads the loaded style from the engine; native,
 * whose engine does not hand the style back to JS, reads the same document
 * over the network once per URL ({@link queryLayersForUrl}).
 *
 * `tap` is symbols AND circles — the POI dot is what sits at the anchor, and
 * the label is drawn below it, so a tap on the dot has to resolve. `labels` is
 * symbols only: a dot whose label lost its collision is not a NAME on screen.
 */
import { isLabelSourceLayer } from './labels';

export interface QueryLayers {
  tap: readonly string[];
  labels: readonly string[];
}

export const NO_QUERY_LAYERS: QueryLayers = { tap: [], labels: [] };

interface StyleLayerLike {
  id: string;
  type: string;
  'source-layer'?: string;
}

/** The tap and label layer ids of a style document. */
export function queryLayersOf(layers: readonly StyleLayerLike[] | undefined): QueryLayers {
  const tap: string[] = [];
  const labels: string[] = [];
  for (const layer of layers ?? []) {
    const sourceLayer = layer['source-layer'];
    if (!sourceLayer || !isLabelSourceLayer(sourceLayer)) continue;
    if (layer.type === 'symbol') {
      tap.push(layer.id);
      labels.push(layer.id);
    } else if (layer.type === 'circle') {
      tap.push(layer.id);
    }
  }
  return { tap, labels };
}

const byUrl = new Map<string, Promise<QueryLayers>>();

/**
 * The query layers of the style at `url`, fetched once per URL and shared. A
 * style that cannot be read answers with none: presses then resolve to bare
 * map, which is what they did before labels were tappable.
 */
export function queryLayersForUrl(url: string): Promise<QueryLayers> {
  let pending = byUrl.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((response) => (response.ok ? response.json() : null))
      .then((style: { layers?: StyleLayerLike[] } | null) => queryLayersOf(style?.layers))
      .catch(() => {
        byUrl.delete(url);
        return NO_QUERY_LAYERS;
      });
    byUrl.set(url, pending);
  }
  return pending;
}
