import { describe, expect, test } from 'bun:test';

import { MapCameraStore } from '../src/cameraStore';
import type { MapCameraChange } from '../src/types';

const change = (zoom: number): MapCameraChange => ({
  viewport: { latitude: 10, longitude: 20, zoom, bearing: 0, pitch: 0 },
  bounds: { west: 0, south: 0, east: 1, north: 1 },
  source: 'user',
  isFinal: false,
});

describe('MapCameraStore', () => {
  test('is fed whether or not the app passed onCameraChanged', () => {
    const store = new MapCameraStore();
    expect(store.get()).toBeNull();
    store.forward(change(5));
    expect(store.get()?.zoom).toBe(5);
  });

  test('tells the store first, then the app, with the same change', () => {
    const store = new MapCameraStore();
    const order: string[] = [];
    store.subscribe(() => order.push(`store:${store.get()?.zoom}`));
    store.setCaller((received) => order.push(`app:${received.viewport.zoom}`));
    store.forward(change(7));
    expect(order).toEqual(['store:7', 'app:7']);
  });

  test('stops telling a subscriber that unsubscribed', () => {
    const store = new MapCameraStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.forward(change(1));
    unsubscribe();
    store.forward(change(2));
    expect(calls).toBe(1);
  });
});
