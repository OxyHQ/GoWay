/**
 * The settings modal's pages come from the registry: each feature on its own
 * section's page, Labs features only once Labs is revealed, nothing a build
 * or platform cannot offer, and no empty page in the rail.
 */
import { describe, expect, test } from 'bun:test';

import {
  MAP_FEATURES,
  type MapFeatureDefinition,
  type MapPlatform,
  resolveMapFeatures,
} from '@/lib/map/mapFeatures';
import { mapSettingsLayout } from '@/lib/map/mapSettingsPages';

function layout(options: { labs: boolean; development?: boolean; platform?: MapPlatform }) {
  const features = resolveMapFeatures({
    features: MAP_FEATURES.map((feature) => ({ ...feature, build: undefined })),
    choices: {},
    platform: options.platform ?? 'web',
    development: options.development ?? false,
    search: '',
  });
  return mapSettingsLayout(features, options.labs);
}
const ids = (states: readonly { id: string }[]) => states.map((state) => state.id);

describe('the settings pages', () => {
  test('every registered feature names its page', () => {
    for (const feature of MAP_FEATURES as readonly MapFeatureDefinition[]) {
      expect(['map', 'layers']).toContain(feature.section);
    }
  });

  test('Labs hidden: the stable features — Street 3D and live data on Layers — and no Labs page', () => {
    const { pages, features } = layout({ labs: false });
    expect(pages).toEqual(['map', 'layers', 'general', 'about']);
    expect(ids(features.map)).toEqual(['globe', 'terrain']);
    expect(ids(features.layers)).toEqual(['street3d', 'live']);
  });

  test('Labs revealed (production): sky on Map, the layers on Layers, and a Labs page', () => {
    const { pages, features } = layout({ labs: true });
    expect(pages).toEqual(['map', 'layers', 'labs', 'general', 'about']);
    expect(ids(features.map)).toEqual(['globe', 'terrain', 'citySky', 'detailedCity']);
    // City tiles, simulated traffic and landmarks have nothing to draw over in
    // production.
    expect(ids(features.layers)).toEqual([
      'street3d',
      'city3d',
      'city3dTrees',
      'city3dTreeFill',
      'live',
      'flyover',
    ]);
  });

  test('Labs revealed (development): the development-only layers join', () => {
    const { features } = layout({ labs: true, development: true });
    expect(ids(features.layers)).toEqual([
      'street3d',
      'city3d',
      'cityTiles',
      'city3dTrees',
      'city3dTreeFill',
      'cityLife',
      'landmarks',
      'live',
      'flyover',
    ]);
  });

  test('native lists only what native draws', () => {
    const { features } = layout({ labs: true, platform: 'ios' });
    expect(ids(features.map)).toEqual(['terrain']);
    expect(ids(features.layers)).toEqual(['street3d', 'flyover']);
  });
});
