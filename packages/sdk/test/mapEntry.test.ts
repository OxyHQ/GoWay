import { describe, expect, it } from 'vitest';
import { createGoWayClient } from '../src/index';
import * as map from '../src/map';
import { fakeFetch } from './helpers';

describe('@goway.to/sdk/map', () => {
  it('resolves a goway:// name to its document, the name’s own light first', () => {
    expect(map.styleDocumentUrl('goway://styles/standard')).toBe(
      'https://goway.to/map/styles/standard/day.json',
    );
    expect(map.styleDocumentUrl('goway://styles/standard?light=dawn', 'night')).toBe(
      'https://goway.to/map/styles/standard/dawn.json',
    );
    expect(map.styleDocumentUrl('goway://styles/dark', 'day')).toBe(
      'https://goway.to/map/styles/dark/night.json',
    );
    expect(map.styleDocumentUrl('goway://styles/outdoors', 'night', 'http://localhost:8081')).toBe(
      'http://localhost:8081/map/styles/outdoors/night.json',
    );
  });

  it('passes any other URL through and answers null for what is not published', () => {
    expect(map.styleDocumentUrl('https://example.org/style.json', 'night')).toBe(
      'https://example.org/style.json',
    );
    expect(map.styleDocumentUrl('goway://styles/nope')).toBeNull();
    expect(
      map.styleDocumentUrl('goway://styles/standard', 'noon' as map.MapLightPreset),
    ).toBeNull();
  });

  it('is the rule client.links.styleUrl applies', () => {
    const client = createGoWayClient({ fetch: fakeFetch(200, {}).fetch });
    for (const style of map.MAP_STYLE_IDS) {
      for (const light of map.MAP_LIGHT_PRESETS) {
        const name = map.gowayStyleUrl(style);
        expect(client.links.styleUrl(name, light)).toBe(map.styleDocumentUrl(name, light));
      }
    }
  });

  it('carries the tile schema and the label language a renderer reads', () => {
    expect(map.OPENMAPTILES_SOURCE_LAYERS.poi).toBe('poi');
    expect(map.localizedLabel({ en: 'Map', es: 'Mapa' }, 'es-MX')).toBe('Mapa');
    expect(map.DEFAULT_MAP_STYLE).toBe('standard');
  });
});
