/**
 * A style or light change is swapped into the SAME map (`styleSwap.web.ts`),
 * never a new one: what the runtime added to the old document is carried
 * into the new one, the swap is a diff, and it never lands mid-gesture,
 * mid-animation or mid-flyover. And the web canvas really does it that way:
 * its engine is no longer rebuilt for a style.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StyleSpecification } from 'maplibre-gl';

import { carryRuntimeStyle, createStyleSwapper } from '@/components/map/styleSwap.web';

const OWNED = ['background', 'water', 'road', 'building-3d', 'label'];

function documentOf(layers: string[], extra: Partial<StyleSpecification> = {}): StyleSpecification {
  return {
    version: 8,
    metadata: { 'goway:layers': OWNED },
    sources: { openmaptiles: { type: 'vector', url: 'https://goway.to/map/tiles.json' } },
    layers: layers.map((id) => ({ id, type: 'background' }) as StyleSpecification['layers'][number]),
    ...extra,
  };
}

describe('carryRuntimeStyle', () => {
  test('the runtime’s layers and sources go into the next document, where they were', () => {
    const previous = documentOf(['background', 'water', 'road', 'building-3d', 'label']);
    previous.layers.splice(2, 0, {
      id: 'goway-relief-hillshade',
      type: 'hillshade',
      source: 'goway-relief-dem-hillshade',
    });
    previous.layers.push({ id: 'goway-live-points', type: 'circle', source: 'goway-live' });
    previous.sources['goway-relief-dem-hillshade'] = { type: 'raster-dem', tiles: ['x'] };
    previous.sources['goway-relief-dem-terrain'] = { type: 'raster-dem', tiles: ['y'] };
    previous.sources['goway-live'] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
    previous.sources['goway-unused'] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
    previous.terrain = { source: 'goway-relief-dem-terrain', exaggeration: 1 };
    previous.projection = { type: 'globe' };
    previous.light = { anchor: 'map', intensity: 0.4 };

    const next = documentOf(['background', 'water', 'road', 'building-3d', 'label']);
    const carried = carryRuntimeStyle(previous, next, { keepLight: true });

    expect(carried.layers.map((l) => l.id)).toEqual([
      'background',
      'water',
      'goway-relief-hillshade',
      'road',
      'building-3d',
      'label',
      'goway-live-points',
    ]);
    expect(Object.keys(carried.sources).sort()).toEqual([
      'goway-live',
      'goway-relief-dem-hillshade',
      'goway-relief-dem-terrain',
      'openmaptiles',
    ]);
    expect(carried.terrain).toEqual(previous.terrain);
    expect(carried.projection).toEqual({ type: 'globe' });
    expect(carried.light).toEqual(previous.light);
    // The input is not touched.
    expect(next.layers).toHaveLength(5);
  });

  test('a document’s own layer the next one lacks is dropped, with its source', () => {
    const previous = documentOf(['background', 'water', 'road', 'label'], {
      sources: {
        openmaptiles: { type: 'vector', url: 'x' },
        'goway-contours': { type: 'vector', tiles: ['c'] },
      },
    });
    previous.layers.splice(2, 0, { id: 'road', type: 'line', source: 'goway-contours' } as never);
    const next = documentOf(['background', 'water', 'label']);
    const carried = carryRuntimeStyle(
      { ...previous, metadata: { 'goway:layers': [...OWNED, 'contour-line'] } },
      next,
      { keepLight: false },
    );
    expect(carried.layers.map((l) => l.id)).toEqual(['background', 'water', 'label']);
    expect(Object.keys(carried.sources)).toEqual(['openmaptiles']);
    expect(carried.light).toBeUndefined();
  });

  test('the next document’s own terrain, projection and sources win', () => {
    const previous = documentOf(['background'], {
      terrain: { source: 'old', exaggeration: 1 },
      projection: { type: 'globe' },
    });
    previous.sources.old = { type: 'raster-dem', tiles: ['o'] };
    const next = documentOf(['background'], {
      terrain: { source: 'new', exaggeration: 2 },
      projection: { type: 'mercator' },
    });
    next.sources.new = { type: 'raster-dem', tiles: ['n'] };
    const carried = carryRuntimeStyle(previous, next, { keepLight: true });
    expect(carried.terrain).toEqual({ source: 'new', exaggeration: 2 });
    expect(carried.projection).toEqual({ type: 'mercator' });
    expect(carried.sources.old).toBeUndefined();
  });
});

type Listener = (event?: unknown) => void;

/** A map that records `setStyle` and fires `style.load` as an applied diff does. */
function fakeMap() {
  const listeners = new Map<string, Set<Listener>>();
  let moving = false;
  const calls: { document: StyleSpecification; options: Record<string, unknown> }[] = [];
  const style = {};
  let current = documentOf(OWNED);
  const map = {
    style,
    calls,
    setMoving(next: boolean) {
      moving = next;
    },
    fire(type: string, event?: unknown) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    isMoving: () => moving,
    getStyle: () => current,
    on(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    once(type: string, listener: Listener) {
      const wrapped: Listener = (event) => {
        listeners.get(type)?.delete(wrapped);
        listener(event);
      };
      map.on(type, wrapped);
    },
    off(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    setStyle(document: StyleSpecification, options: Record<string, unknown>) {
      calls.push({ document, options });
      const transform = options.transformStyle as
        | ((p: StyleSpecification, n: StyleSpecification) => StyleSpecification)
        | undefined;
      current = transform ? transform(current, document) : document;
      map.fire('style.load');
    },
  };
  return map;
}

function fakeContainer() {
  return { addEventListener() {}, removeEventListener() {} };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('createStyleSwapper', () => {
  const originalFetch = globalThis.fetch;
  const withFetch = (document: StyleSpecification) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(document), { status: 200 })) as unknown as typeof fetch;
  };
  const restore = () => {
    globalThis.fetch = originalFetch;
  };

  test('swaps in place with a diff, the hooks around it, and nothing torn down', async () => {
    withFetch(documentOf(OWNED, { name: 'next' }));
    const map = fakeMap();
    const order: string[] = [];
    const swapper = createStyleSwapper(
      map as never,
      fakeContainer() as never,
      {
        before: () => order.push('before'),
        after: (rebuilt) => order.push(`after:${rebuilt}`),
        onError: (message) => order.push(`error:${message}`),
      },
      { keepLight: () => false },
    );
    swapper.request('/map/styles/standard/night.json', (style) => style);
    await settle();
    expect(map.calls).toHaveLength(1);
    expect(map.calls[0].options.diff).toBe(true);
    expect(typeof map.calls[0].options.transformStyle).toBe('function');
    expect(order).toEqual(['before', 'after:false']);
    swapper.dispose();
    restore();
  });

  test('never while the camera moves, nor between a flyover’s frames', async () => {
    withFetch(documentOf(OWNED, { name: 'next' }));
    const map = fakeMap();
    const order: string[] = [];
    const swapper = createStyleSwapper(
      map as never,
      fakeContainer() as never,
      { before: () => order.push('before'), after: () => order.push('after'), onError() {} },
      { keepLight: () => false },
    );
    map.setMoving(true);
    swapper.request('/map/styles/standard/dusk.json', (style) => style);
    await settle();
    expect(map.calls).toHaveLength(0);
    // A flyover frame ends: still animating.
    map.setMoving(false);
    map.fire('moveend', { gowayTransient: true });
    expect(map.calls).toHaveLength(0);
    // The flyover's closing, ordinary move settles it: now.
    map.fire('moveend', {});
    expect(map.calls).toHaveLength(1);
    expect(order).toEqual(['before', 'after']);
    swapper.dispose();
    restore();
  });

  test('the density is folded into the document it swaps in', async () => {
    withFetch(documentOf(OWNED));
    const map = fakeMap();
    const swapper = createStyleSwapper(
      map as never,
      fakeContainer() as never,
      { before() {}, after() {}, onError() {} },
      { keepLight: () => false },
    );
    swapper.request('/map/styles/streets/day.json', (style) => ({ ...style, name: 'folded' }));
    await settle();
    expect(map.calls[0].document.name).toBe('folded');
    swapper.dispose();
    restore();
  });
});

describe('the web canvas swaps, it does not rebuild', () => {
  const source = readFileSync(join(import.meta.dir, '../MapCanvas.web.tsx'), 'utf8');

  test('the engine effect does not depend on the style URL or its light', () => {
    // The engine effect's dependency list: the one that names `reloadKey` and `relief`.
    const deps = /\}, \[\s*reloadKey,\s*relief,[^\]]*\]\);/.exec(source)?.[0] ?? '';
    expect(deps).not.toBe('');
    expect(deps).not.toContain('styleUrl');
    expect(deps).not.toContain('FollowsLight');
  });

  test('a new style is requested from the swapper, and the 3D city is restyled in place', () => {
    expect(source).toContain('swapper.request(');
    expect(source).toContain('.restyle(now)');
    // The city effect re-attaches for a tier or an epoch, not for a style or light.
    const city = /\}, \[\s*ready,\s*runtime,\s*qualityTier,[^\]]*\]\);/.exec(source)?.[0] ?? '';
    expect(city).not.toBe('');
    expect(city).not.toContain('styleId');
    expect(city).not.toContain('stylePreset');
    expect(city).not.toContain('resolvedAppearance');
  });
});
