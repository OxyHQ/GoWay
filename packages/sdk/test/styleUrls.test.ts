import { describe, expect, it } from 'vitest';
import {
  createGoWayClient,
  GOWAY_STYLE_URL_PREFIX,
  GoWayValidationError,
  gowayStyleUrl,
  parseGoWayStyleUrl,
} from '../src/index';
import { fakeFetch } from './helpers';

const client = createGoWayClient({ fetch: fakeFetch(200, {}).fetch });

describe('goway:// style URLs', () => {
  it('names a style, with or without a light', () => {
    expect(GOWAY_STYLE_URL_PREFIX).toBe('goway://styles/');
    expect(gowayStyleUrl('standard')).toBe('goway://styles/standard');
    expect(gowayStyleUrl('streets', 'night')).toBe('goway://styles/streets?light=night');
  });

  it('reads back exactly what it names, and nothing else', () => {
    expect(parseGoWayStyleUrl('goway://styles/standard')).toEqual({ style: 'standard' });
    expect(parseGoWayStyleUrl('goway://styles/streets?light=night')).toEqual({
      style: 'streets',
      light: 'night',
    });
    expect(parseGoWayStyleUrl('https://goway.to/map/styles/standard/day.json')).toBeNull();
    expect(parseGoWayStyleUrl('goway://styles/nope')).toBeNull();
    expect(parseGoWayStyleUrl('goway://styles/standard?light=noon')).toBeNull();
    expect(parseGoWayStyleUrl('goway://styles/standard?theme=dark')).toBeNull();
  });

  it('resolves a name to its document in the asked light; the name’s own light wins', () => {
    expect(client.links.styleUrl('goway://styles/standard')).toBe(
      'https://goway.to/map/styles/standard/day.json',
    );
    expect(client.links.styleUrl('goway://styles/standard', 'night')).toBe(
      'https://goway.to/map/styles/standard/night.json',
    );
    expect(client.links.styleUrl('goway://styles/standard?light=dawn', 'night')).toBe(
      'https://goway.to/map/styles/standard/dawn.json',
    );
    // A light the style is not published in: the nearest one it is.
    expect(client.links.styleUrl('goway://styles/dark', 'day')).toBe(
      'https://goway.to/map/styles/dark/night.json',
    );
  });

  it('passes any other URL through, and refuses an unpublished goway:// name', () => {
    const other = 'https://example.org/style.json';
    expect(client.links.styleUrl(other, 'night')).toBe(other);
    expect(() => client.links.styleUrl('goway://styles/nope')).toThrow(GoWayValidationError);
  });

  it('builds on the client’s web origin', () => {
    const local = createGoWayClient({
      fetch: fakeFetch(200, {}).fetch,
      webBaseUrl: 'http://localhost:8081',
    });
    expect(local.links.styleUrl('goway://styles/outdoors', 'night')).toBe(
      'http://localhost:8081/map/styles/outdoors/night.json',
    );
  });
});
