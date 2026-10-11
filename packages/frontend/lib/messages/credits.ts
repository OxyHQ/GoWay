/**
 * The attribution page's own words (`app/attribution.tsx`), per locale. The
 * credits and the licence notices it shows are NOT here: they are quoted
 * verbatim from the sources' licences (`lib/map/credits.ts`) and stay in the
 * licensor's language. `__tests__/credits.test.ts` keeps the locales in step.
 */
export const CREDITS_EN: Record<string, string> = {
  'credits.title': 'Map data and credits',
  'credits.intro':
    "GoWay's map is drawn from open data. These are its sources, the credit each one asks for, and the notices their licences require.",
  'credits.basemap.heading': 'Streets, places and buildings',
  'credits.basemap.body':
    'Map data from OpenStreetMap, available under the Open Database License (ODbL), in the OpenMapTiles schema.',
  'credits.elevation.heading': 'Elevation: relief and 3D terrain',
  'credits.elevation.body':
    "Terrain tiles from Mapterhorn, which merges open elevation models from many providers; its attribution page lists every one with its licence. Outside the areas covered by finer national models, GoWay's elevation is the Copernicus GLO-30 digital elevation model.",
  'credits.notices': 'Licence notices',
  'credits.back': 'Back to the map',
};

export const CREDITS_ES: Record<string, string> = {
  'credits.title': 'Datos del mapa y créditos',
  'credits.intro':
    'El mapa de GoWay se dibuja con datos abiertos. Estas son sus fuentes, el crédito que pide cada una y los avisos que exigen sus licencias.',
  'credits.basemap.heading': 'Calles, lugares y edificios',
  'credits.basemap.body':
    'Datos del mapa de OpenStreetMap, disponibles bajo la Open Database License (ODbL), en el esquema OpenMapTiles.',
  'credits.elevation.heading': 'Elevación: relieve y terreno 3D',
  'credits.elevation.body':
    'Teselas de terreno de Mapterhorn, que combina modelos de elevación abiertos de muchos proveedores; su página de atribución los enumera todos con su licencia. Fuera de las zonas cubiertas por modelos nacionales más detallados, la elevación de GoWay es el modelo digital de elevación Copernicus GLO-30.',
  'credits.notices': 'Avisos de licencia',
  'credits.back': 'Volver al mapa',
};
