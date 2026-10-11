/**
 * Official 3D building datasets the compiler can merge, with what using each
 * one obliges. Only a source whose licence was verified on the publisher's
 * own pages to allow a publicly served, ODbL-licensed derivative is listed;
 * `docs/MAP_3D_SOURCES.md` has the survey, the verdicts and the ones refused
 * (Barcelona's municipal model among them, until the city confirms its terms).
 *
 * The CREDIT shown on the map is `CITY_LOD2_SOURCES` in `lib/map/cityOfficial.ts`
 * (the client reads it); this module holds the rest, for the archive's
 * metadata and receipt.
 */
import { CITY_LOD2_SOURCES, type CityLod2Source } from '../../../lib/map/cityOfficial';
import type { StoreyRegion } from '../storeys';

export interface Lod2SourceInfo {
  id: CityLod2Source;
  name: string;
  publisher: string;
  /** The dataset's landing page. */
  url: string;
  /** Where the files were downloaded from, as of the survey. */
  download: string;
  format: 'citygml' | 'cityjson' | 'inspire-bu';
  /** Used when a file declares no `srsName`. */
  defaultSrs?: string;
  /** Attributes that identify a building, in preference order (provenance). */
  idAttributes: readonly string[];
  licence: string;
  /** The attribution text, as the archive metadata and the doc carry it. */
  attribution: string;
  /** When the data describes the world as it was. */
  referenceDate: string;
  /** How conflation treats it (`conflate.ts`). */
  policy: {
    /**
     * Drop a model building whose heights disagree with OSM's (a dated
     * capture, replaced since). Off for a source kept current by law.
     */
    staleCheck: boolean;
    /**
     * When OSM's own 3D wins over the model's flat blocks: `parts-or-roofs`
     * (hand-made `building:part`s or roof shapes), `roofs` (roof shapes only —
     * where OSM's parts are themselves an import of this very source).
     */
    osmRicher: 'parts-or-roofs' | 'roofs';
    /** What `height_source` says on an OSM feature this source sets the height of. */
    heightSource: 'lod2' | 'cadastre';
    /**
     * For a source that records storeys, the region's storeys → metres model
     * (`citygen/storeys.ts`). It also resolves OSM's `building:levels` in the
     * same area: there they are overwhelmingly a copy of this source's count,
     * and one storey count must stand one height whichever source carried it.
     */
    storeys?: StoreyRegion;
  };
}

export const LOD2_SOURCES: Record<CityLod2Source, Lod2SourceInfo> = {
  'nyc-3dbm': {
    id: 'nyc-3dbm',
    name: 'NYC 3-D Building Model',
    publisher: 'City of New York, Office of Technology and Innovation (OTI)',
    url: CITY_LOD2_SOURCES['nyc-3dbm'].href,
    download: 'https://s-media.nyc.gov/agencies/oti/DA_WISE_GML.zip',
    format: 'citygml',
    defaultSrs: 'EPSG:2263',
    idAttributes: ['BIN', 'DOITT_ID'],
    licence:
      'NYC Open Data — no licence; "There are no restrictions on the use of Open Data" (NYC Open Data FAQ)',
    attribution:
      'NYC 3-D Building Model (2014 capture, published 2016), City of New York OTI; roof surfaces only, conflated with OpenStreetMap by GoWay',
    referenceDate: '2014',
    policy: { staleCheck: true, osmRicher: 'parts-or-roofs', heightSource: 'lod2' },
  },
  'es-catastro': {
    id: 'es-catastro',
    name: 'Catastro INSPIRE Buildings (building parts)',
    publisher: 'Dirección General del Catastro (Ministerio de Hacienda), Spain',
    url: CITY_LOD2_SOURCES['es-catastro'].href,
    download:
      'https://www.catastro.hacienda.gob.es/INSPIRE/buildings/ES.SDGC.BU.atom.xml (one zip per municipality; `catastro:list` selects them)',
    format: 'inspire-bu',
    idAttributes: [],
    licence:
      'Catastro INSPIRE licence v1.0 (2016): public and commercial use of TRANSFORMED cadastral information; the original may not be redistributed untransformed, its content must not be altered or distorted, and the result must not be called cadastral cartography. Feed rights: free of charge "as long as that the D. G. of the Cadastre (Ministry of Finance) is mentioned as author and owner of the information".',
    attribution:
      'Dirección General del Catastro (Ministerio de Hacienda): building parts and storeys above ground, transformed into heights (the Spanish storey model: 4.0 m ground floor, 3.05 m upper floors, 0.9 m parapet) and conflated with OpenStreetMap by GoWay',
    referenceDate: 'updated twice a year; the feed date is in the receipt',
    // Kept current by law, and OSM's Spanish parts ARE an import of it.
    policy: { staleCheck: false, osmRicher: 'roofs', heightSource: 'cadastre', storeys: 'es' },
  },
};

export function isLod2Source(id: string): id is CityLod2Source {
  return Object.hasOwn(LOD2_SOURCES, id);
}
