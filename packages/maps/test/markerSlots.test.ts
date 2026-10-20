/**
 * What `<Markers cluster>` draws at a zoom: Supercluster with Mapbox's
 * options, a pin at its published coordinate, and the cluster's members.
 */
import { describe, expect, test } from 'bun:test';

import { DEFAULT_CLUSTER_OPTIONS, indexMarkers, markerSlotsAt } from '../src/clusters';
import type { MapMarkerData } from '../src/types';

const at = (id: string, latitude: number, longitude: number): MapMarkerData => ({
  id,
  coordinate: { latitude, longitude },
  label: id,
});

// Three homes a few metres apart in Barcelona, and one in Madrid.
const homes = [
  at('a', 41.38701, 2.16801),
  at('b', 41.38702, 2.16802),
  at('c', 41.38703, 2.16803),
  at('m', 40.4168, -3.7038),
];
const NONE = new Set<string>();

describe('clusters', () => {
  test('Mapbox’s defaults', () => {
    expect(DEFAULT_CLUSTER_OPTIONS).toEqual({ radius: 50, maxZoom: 14, minPoints: 2 });
  });

  test('close points gather into one bubble at a country zoom, with their members', () => {
    const slots = markerSlotsAt(indexMarkers(homes, DEFAULT_CLUSTER_OPTIONS), 6, null, NONE);
    const clusters = slots.filter((slot) => slot.item.kind === 'cluster');
    expect(clusters).toHaveLength(1);
    const [first] = clusters;
    if (first?.item.kind !== 'cluster') throw new Error('no cluster');
    expect(first.item.cluster.count).toBe(3);
    expect([...first.item.cluster.markerIds].sort()).toEqual(['a', 'b', 'c']);
    expect(first.expansionZoom).toBeGreaterThan(6);
    // Madrid stands alone, at exactly the coordinate it was given.
    const madrid = slots.find((slot) => slot.key === 'point:m');
    expect(madrid?.coordinate).toEqual({ latitude: 40.4168, longitude: -3.7038 });
  });

  test('past clusterMaxZoom every marker is a pin', () => {
    const slots = markerSlotsAt(indexMarkers(homes, DEFAULT_CLUSTER_OPTIONS), 15, null, NONE);
    expect(slots.every((slot) => slot.item.kind === 'point')).toBe(true);
    expect(slots).toHaveLength(4);
  });

  test('without clustering, every marker is a pin with its state', () => {
    const slots = markerSlotsAt(indexMarkers(homes, null), 3, 'a', new Set(['b']));
    const state = Object.fromEntries(
      slots.map((slot) => [slot.key, slot.item.kind === 'point' ? slot.item.state : null]),
    );
    expect(state).toEqual({
      'point:a': 'active',
      'point:b': 'visited',
      'point:c': 'default',
      'point:m': 'default',
    });
  });

  test('a cluster holding the selected marker is drawn active', () => {
    const slots = markerSlotsAt(indexMarkers(homes, DEFAULT_CLUSTER_OPTIONS), 6, 'b', NONE);
    const cluster = slots.find((slot) => slot.item.kind === 'cluster');
    expect(cluster?.item.state).toBe('active');
  });
});
