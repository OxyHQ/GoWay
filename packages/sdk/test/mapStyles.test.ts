import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  DEFAULT_MAP_STYLE,
  GoWayValidationError,
  isMapStyleId,
  MAP_LIGHT_PRESETS,
  MAP_STYLE_CATALOGUE,
  MAP_STYLE_IDS,
  type MapStyleId,
  parseMapStyleIndex,
  resolveMapStyle,
} from '../src/index';
import { fakeFetch } from './helpers';

const client = createGoWayClient({ fetch: fakeFetch(200, {}).fetch });

describe('map styles', () => {
  it('names every published style once, each with its default light first', () => {
    expect(MAP_STYLE_CATALOGUE.map((entry) => entry.id)).toEqual([...MAP_STYLE_IDS]);
    expect(DEFAULT_MAP_STYLE).toBe('standard');
    for (const entry of MAP_STYLE_CATALOGUE) {
      expect(entry.presets.length).toBeGreaterThan(0);
      for (const preset of entry.presets) expect(MAP_LIGHT_PRESETS).toContain(preset);
    }
  });

  it('builds a style document URL, in the style’s own light by default', () => {
    expect(client.links.mapStyle('streets')).toBe('https://goway.to/map/styles/streets/day.json');
    expect(client.links.mapStyle('standard', 'dusk')).toBe(
      'https://goway.to/map/styles/standard/dusk.json',
    );
    // A light the style is not published in: the nearest one it is.
    expect(client.links.mapStyle('dark', 'day')).toBe(
      'https://goway.to/map/styles/dark/night.json',
    );
    expect(client.links.mapStyle('navigation', 'dusk')).toBe(
      'https://goway.to/map/styles/navigation/night.json',
    );
    expect(client.links.mapStyleIndex()).toBe('https://goway.to/map/styles/index.json');
  });

  it('refuses a style or a light GoWay does not publish', () => {
    expect(() => client.links.mapStyle('hologram' as MapStyleId)).toThrow(GoWayValidationError);
    expect(() => client.links.mapStyle('standard', 'noon' as never)).toThrow(GoWayValidationError);
  });

  it('builds an embed URL with a style and a light', () => {
    expect(
      client.links.embed({ latitude: 41.39, longitude: 2.17, zoom: 14 }, { style: 'outdoors' }),
    ).toBe('https://goway.to/frame?lat=41.39&light=day&lng=2.17&style=outdoors&zoom=14');
    expect(client.links.embed({ latitude: 41.39, longitude: 2.17, zoom: 14 })).toBe(
      'https://goway.to/frame?lat=41.39&lng=2.17&zoom=14',
    );
  });

  it('resolves lights the way the app does', () => {
    expect(resolveMapStyle('streets', 'dawn')).toEqual({ style: 'streets', preset: 'day' });
    expect(resolveMapStyle('light')).toEqual({ style: 'light', preset: 'day' });
  });

  it('parses the catalogue document, and keeps a style it does not know yet', () => {
    const index = parseMapStyleIndex({
      v: 1,
      default: 'standard',
      styles: [
        {
          id: 'standard',
          light: 'follows',
          presets: ['day', 'night'],
          defaultPreset: 'day',
          urls: { day: 'https://goway.to/map/styles/standard/day.json' },
        },
        {
          id: 'aurora',
          light: 'follows',
          presets: ['day'],
          defaultPreset: 'day',
          urls: { day: 'https://goway.to/map/styles/aurora/day.json' },
        },
      ],
    });
    expect(index.styles.map((s) => s.id).filter(isMapStyleId)).toEqual(['standard']);
    expect(() => parseMapStyleIndex({ v: 2, styles: [] })).toThrow(GoWayValidationError);
  });
});
