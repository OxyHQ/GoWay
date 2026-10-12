/**
 * OSM tags → the road tiles' street-detail properties (`citygen/streetTags.ts`):
 * recorded values normalised, junk refused and counted, never coerced.
 */
import { describe, expect, test } from 'bun:test';

import {
  normaliseBusLanes,
  normaliseChangeLanes,
  normaliseCrossingMarkings,
  normaliseTurnLanes,
  parseLengthM,
  type Refusals,
  streetNodeProperties,
  streetProperties,
} from '../citygen/streetTags';

describe('values', () => {
  test('lengths: metres, feet, feet and inches; anything else refused', () => {
    expect(parseLengthM('12')).toBe(12);
    expect(parseLengthM('12.5 m')).toBe(12.5);
    expect(parseLengthM('40 ft')).toBeCloseTo(12.192);
    expect(parseLengthM(`12'6"`)).toBeCloseTo(3.81);
    for (const junk of ['wide', '~10', '10;12', '10-12', '', undefined]) {
      expect(parseLengthM(junk)).toBeUndefined();
    }
  });

  test('turn lanes: every value known, or the whole tag refused', () => {
    expect(normaliseTurnLanes('left|through;right|')).toBe('left|through;right|none');
    expect(normaliseTurnLanes(' Left | Through ')).toBe('left|through');
    expect(normaliseTurnLanes('left|straight')).toBeNull();
    expect(normaliseTurnLanes('l|r')).toBeNull();
    expect(normaliseTurnLanes(Array(13).fill('through').join('|'))).toBeNull();
  });

  test('bus lanes: designated per lane', () => {
    expect(normaliseBusLanes('yes|yes|designated')).toBe('--b');
    expect(normaliseBusLanes('|designated')).toBe('-b');
    expect(normaliseBusLanes('designated|maybe')).toBeNull();
  });

  test('crossing markings: the documented set', () => {
    expect(normaliseCrossingMarkings('Zebra')).toBe('zebra');
    expect(normaliseCrossingMarkings('ladder:skewed')).toBe('ladder:skewed');
    expect(normaliseCrossingMarkings('stripes')).toBeNull();
  });
});

describe('a way', () => {
  test('lane detail is read on drivable ways only, and refusals are counted by key', () => {
    const refused: Refusals = {};
    const props = streetProperties(
      {
        name: 'Carrer de Mallorca',
        width: '12 m',
        'turn:lanes': 'left|through|through;right',
        'psv:lanes': 'no|no|designated',
        'cycleway:left': 'lane',
        'parking:lane:both': 'parallel',
        'sidewalk:both:width': '5',
        'turn:lanes:forward': 'leftish',
      },
      true,
      refused,
    );
    expect(props).toEqual({
      name: 'Carrer de Mallorca',
      width: 12,
      turn_lanes: 'left|through|through;right',
      bus_lanes: '--b',
      cycle_lane: 'left',
      parking: 'both',
      sidewalk_width: 5,
    });
    expect(refused).toEqual({ 'turn:lanes:forward': 1 });
    // A footway gets a name, but no lane tags.
    expect(streetProperties({ name: 'x', 'turn:lanes': 'left' }, false)).toEqual({ name: 'x' });
  });

  test('busway and lanes:bus', () => {
    expect(streetProperties({ busway: 'lane' }, true).busway).toBe('both');
    expect(streetProperties({ 'busway:right': 'lane' }, true).busway).toBe('right');
    expect(streetProperties({ 'lanes:bus': '1' }, true).lanes_bus).toBe(1);
    expect(streetProperties({ 'lanes:psv:forward': '2' }, true).lanes_bus_forward).toBe(2);
    expect(streetProperties({ 'lanes:bus': 'one' }, true).lanes_bus).toBeUndefined();
    // A pattern that designates no lane says nothing to paint.
    expect(streetProperties({ 'bus:lanes': 'yes|yes' }, true).bus_lanes).toBeUndefined();
  });

  test('bridges, and junk widths', () => {
    expect(streetProperties({ bridge: 'viaduct' }, true).bridge).toBe(true);
    expect(streetProperties({ bridge: 'no' }, true).bridge).toBeUndefined();
    const refused: Refusals = {};
    expect(streetProperties({ width: '400' }, true, refused).width).toBeUndefined();
    expect(refused).toEqual({ width: 1 });
  });

  test('a footway crossing keeps its crossing and markings', () => {
    expect(
      streetProperties(
        { footway: 'crossing', crossing: 'traffic_signals', 'crossing:markings': 'zebra' },
        false,
      ),
    ).toEqual({ crossing: 'traffic_signals', crossing_markings: 'zebra' });
  });
});

describe('a node', () => {
  test('crossing markings and reference, a signal’s direction', () => {
    expect(
      streetNodeProperties({
        highway: 'crossing',
        'crossing:markings': 'dots',
        crossing_ref: 'zebra',
      }),
    ).toEqual({ crossing_markings: 'dots', crossing_ref: 'zebra' });
    expect(
      streetNodeProperties({ highway: 'traffic_signals', 'traffic_signals:direction': 'forward' }),
    ).toEqual({
      direction: 'forward',
    });
    expect(streetNodeProperties({ highway: 'stop', direction: 'both' })).toEqual({});
  });
});

describe('change:lanes', () => {
  test('per lane: yes, no, not_right (left only), not_left (right only); junk refuses the tag', () => {
    expect(normaliseChangeLanes('no|not_right|yes|not_left')).toBe('nlyr');
    expect(normaliseChangeLanes('no|maybe')).toBeNull();
    const refused: Refusals = {};
    const props = streetProperties(
      { 'change:lanes:forward': 'not_left|no', 'change:lanes:backward': 'nope' },
      true,
      refused,
    );
    expect(props.change_lanes_forward).toBe('rn');
    expect(props.change_lanes_backward).toBeUndefined();
    expect(refused).toEqual({ 'change:lanes:backward': 1 });
  });

  test('a cycleway keeps its width (a footway its own)', () => {
    expect(streetProperties({ highway: 'cycleway', width: '2.5' }, false).width).toBe(2.5);
  });
});
