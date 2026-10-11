/**
 * The map settings modal's pages, derived from the map-feature registry — the
 * one source of truth for what exists, where it is listed and whether this
 * person sees it (`docs/MAP_FEATURES.md`).
 *
 *  - **map**: the 2D/3D view (always) and every `section: 'map'` feature.
 *  - **layers**: every `section: 'layers'` feature.
 *  - **labs**: what Labs is and how to hide it — only once Labs is revealed.
 *  - **general**, **about**: always.
 *
 * A feature is listed only where the panel offers it (`available`: the build
 * carries it and this platform draws it), and a `labs` feature only once Labs
 * is revealed. A page with nothing to list leaves the rail (the map page
 * always has the view). Pure, so these rules are tests
 * (`__tests__/mapSettingsPages.test.ts`).
 */
import type { MapFeatureState, ResolvedMapFeatures } from './mapFeatures';

export type MapSettingsPageId = 'map' | 'layers' | 'labs' | 'general' | 'about';

export interface MapSettingsLayout {
  /** The rail, in order. */
  pages: readonly MapSettingsPageId[];
  /** The features each feature page lists, in registry order. */
  features: Readonly<Record<'map' | 'layers', readonly MapFeatureState[]>>;
}

export function mapSettingsLayout(features: ResolvedMapFeatures, labs: boolean): MapSettingsLayout {
  const listed = features.list.filter(
    (state) => state.available && (state.tier === 'stable' || labs),
  );
  const map = listed.filter((state) => state.section === 'map');
  const layers = listed.filter((state) => state.section === 'layers');
  const pages: MapSettingsPageId[] = ['map'];
  if (layers.length > 0) pages.push('layers');
  if (labs) pages.push('labs');
  pages.push('general', 'about');
  return { pages, features: { map, layers } };
}
