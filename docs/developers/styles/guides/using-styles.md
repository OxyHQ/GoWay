# Using styles

Recipes for working with GoWay styles directly in MapLibre GL JS: pinning a light, adding your own layer beneath GoWay's labels, and querying what the map draws by source layer. The examples use plain MapLibre and the public URLs, so they work without the GoWay SDK. MapLibre takes coordinates as `[longitude, latitude]` arrays, and the examples follow that.

## Pin a light

A style document is one style in one light, so pinning a light is choosing the document.

The simplest way is to use its URL:

```ts
map.setStyle('https://goway.to/map/styles/outdoors/night.json');
```

If the light comes from user input or the time of day, resolve it against the catalogue, so that a style without that light still loads the nearest one. This function applies the same rules as the SDK's `resolveMapStyle` (see [How a light is resolved](../README.md#how-a-light-is-resolved)):

```ts
type Light = 'day' | 'dawn' | 'dusk' | 'night';

interface StyleIndex {
  v: 1;
  default: string;
  styles: { id: string; presets: string[]; defaultPreset: string; urls: Record<string, string> }[];
}

async function styleUrl(styleId: string, wanted?: Light): Promise<string> {
  const response = await fetch('https://goway.to/map/styles/index.json');
  const index = (await response.json()) as StyleIndex;
  const style = index.styles.find((entry) => entry.id === styleId);
  if (!style) throw new Error(`GoWay has no style "${styleId}"`);

  const pick = (light: string) => style.urls[light];
  if (wanted === undefined) return pick(style.defaultPreset);
  if (style.presets.includes(wanted)) return pick(wanted);
  if (style.presets.length === 1) return pick(style.defaultPreset);
  if (wanted === 'dawn' && style.presets.includes('day')) return pick('day');
  if (wanted === 'dusk' && style.presets.includes('night')) return pick('night');
  return pick(style.defaultPreset);
}

map.setStyle(await styleUrl('streets', 'dusk')); // streets/night.json
```

Throwing on an unknown style id is deliberate: drawing a different style than the one asked for hides the mistake.

With the GoWay packages, the same choice is a name: `goway://styles/streets?light=night` always draws Streets at night, while `goway://styles/streets` follows the light the map is given. `@goway.to/maps` takes these names as its style, and `styleDocumentUrl` in [`@goway.to/sdk/map`](../../sdk/api-reference/map.md) turns them into document URLs.

## Add your own layer under the labels

Every GoWay style contains an empty anchor layer, `goway:anchor:labels`, between the basemap (roads, buildings, boundaries) and the labels. Insert your layers before it and they cover the roads but stay under every street, place and point-of-interest label. The document also names the anchor in its metadata, under `goway:anchor:beforeLabels`, so you do not have to hard-code it.

```ts
import * as maplibregl from 'maplibre-gl';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://goway.to/map/styles/standard/day.json',
  center: [2.1734, 41.3851],
  zoom: 13,
});

function addRoute() {
  const metadata = map.getStyle().metadata as Record<string, unknown> | undefined;
  const beforeId = (metadata?.['goway:anchor:beforeLabels'] as string) ?? 'goway:anchor:labels';

  map.addSource('my-route', {
    type: 'geojson',
    data: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [2.1686, 41.3874],
          [2.1734, 41.3851],
          [2.1769, 41.3825],
        ],
      },
    },
  });

  map.addLayer(
    {
      id: 'my-route-line',
      type: 'line',
      source: 'my-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1a73e8', 'line-width': 5 },
    },
    beforeId,
  );
}

// `style.load` fires for the first style and again after every `setStyle`,
// which drops the sources and layers you added.
map.on('style.load', addRoute);
```

Give your sources and layers ids of your own (`my-route`, not `route`): MapLibre keeps every layer id in one namespace shared with the style. GoWay's own ids are listed in each document's `goway:layers` metadata, and its own overlays use the `goway:` prefix.

To place a layer elsewhere, use any GoWay layer id as `beforeId`. For example, `building` puts your layer under the buildings, and `water` puts it under the water. Check that the id is in `map.getStyle().layers` first: a style leaves out layers it does not draw, and `addLayer` with a `beforeId` that is not in the style fails.

## Query features by source layer

MapLibre's `queryRenderedFeatures` filters by style layer id, not by source layer. To ask "which points of interest are under the cursor", collect the style layers that draw the `poi` source layer and query those:

```ts
function layersFor(sourceLayer: string): string[] {
  return map
    .getStyle()
    .layers.filter((layer) => 'source-layer' in layer && layer['source-layer'] === sourceLayer)
    .map((layer) => layer.id);
}

map.on('click', (event) => {
  const layers = layersFor('poi');
  if (layers.length === 0) return; // `light` and `dark` draw no points of interest
  const [feature] = map.queryRenderedFeatures(event.point, { layers });
  if (!feature) return;

  const { class: poiClass, name } = feature.properties;
  console.log(poiClass, name);

  // Points of interest carry their OpenStreetMap element as the feature id.
  if (typeof feature.id === 'number') {
    const kind = ['', 'node', 'way', 'relation'][feature.id % 10];
    const osmId = Math.floor(feature.id / 10);
    console.log(`https://www.openstreetmap.org/${kind}/${osmId}`);
  }
});
```

Every feature MapLibre returns also has `sourceLayer`, so you can query everything at a point and sort the results yourself:

```ts
const bySourceLayer = Object.groupBy(map.queryRenderedFeatures(event.point), (f) => f.sourceLayer ?? '');
```

`queryRenderedFeatures` sees only what the style draws. To read features that are loaded but not drawn (a class the style filters out, for instance), query the source instead. The vector source in every GoWay style is named `openmaptiles`:

```ts
const cafes = map.querySourceFeatures('openmaptiles', {
  sourceLayer: 'poi',
  filter: ['==', ['get', 'class'], 'cafe'],
});
```

`querySourceFeatures` returns features from the tiles currently loaded, which can include the same feature more than once where it crosses a tile edge. Source layer names, fields and `class` values are listed in [Tiles](tiles.md).

## Related

- [Map styles](../README.md): the catalogue, document URLs and light resolution.
- [Map endpoints](../api-reference.md): every `goway.to/map/*` URL.
- [`@goway.to/maps`](../../maps/README.md): GoWay's map component, which does the light switching and overlay placement for you.
