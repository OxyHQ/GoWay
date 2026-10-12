/**
 * The street cross-section (`engine/cityStreets/lanes.ts`): lane geometry from
 * the tags, and which line is painted where — recorded tags drawn as
 * recorded, missing tags drawn as the class's generic minimum, junk never.
 */
import { describe, expect, test } from 'bun:test';

import {
  type RoadPiece,
  parseBusLanes,
  parseTurnLanes,
} from '@/components/map/engine/roads/roadTiles';
import {
  CYCLE_LANE_WIDTH_M,
  crossSection,
  LANE_WIDTH_M,
  PARKING_WIDTH_M,
  paintRulesAt,
  reverseSection,
  sameSection,
} from '@/components/map/engine/cityStreets/lanes';

const RHT = { drivingSide: 'right', yellowCentre: false } as const;
const LHT = { drivingSide: 'left', yellowCentre: false } as const;
const US = { drivingSide: 'right', yellowCentre: true } as const;

const piece = (tags: Partial<RoadPiece>): RoadPiece => ({
  way: 0,
  highway: 'secondary',
  car: true,
  foot: false,
  roundabout: false,
  tunnel: false,
  points: [
    [0, 0],
    [100, 0],
  ],
  ...tags,
});

describe('lane geometry', () => {
  test('a one-way four-lane avenue: four lanes the class width, centred, all forward', () => {
    const s = crossSection(piece({ oneway: 1, lanes: 4 }), RHT);
    const w = LANE_WIDTH_M.secondary;
    expect(s.width).toBeCloseTo(4 * w);
    expect(s.bands.map((b) => [b.kind, b.dir])).toEqual(Array(4).fill(['lane', 1]));
    expect(s.bands[0].left).toBeCloseTo(2 * w);
    expect(s.bands[3].right).toBeCloseTo(-2 * w);
    expect(s.recorded).toBe(true);
    // Three same-direction dividers, dashed; no centre line on a one-way road.
    expect(s.dividers.map((d) => d.style)).toEqual(['dashed', 'dashed', 'dashed']);
  });

  test('a two-way road keeps right: backward lanes on the left half, forward on the right', () => {
    const s = crossSection(piece({ lanes: 4, lanesForward: 3 }), RHT);
    expect(s.forward).toBe(3);
    expect(s.backward).toBe(1);
    expect(s.bands.map((b) => b.dir)).toEqual([-1, 1, 1, 1]);
    // Where traffic keeps left the halves swap.
    const l = crossSection(piece({ lanes: 4, lanesForward: 3 }), LHT);
    expect(l.bands.map((b) => b.dir)).toEqual([1, 1, 1, -1]);
  });

  test('an unsplit odd count draws the larger half forward', () => {
    const s = crossSection(piece({ lanes: 3 }), RHT);
    expect([s.forward, s.backward]).toEqual([2, 1]);
  });

  test('inconsistent counts are not drawn as recorded', () => {
    const s = crossSection(piece({ lanes: 2, lanesForward: 2 }), RHT);
    expect(s.recorded).toBe(false);
    expect(s.dividers.every((d) => d.role === 'centre')).toBe(true);
  });

  test('oneway=-1 runs against the drawn direction', () => {
    const s = crossSection(piece({ oneway: -1, lanes: 2 }), RHT);
    expect(s.bands.map((b) => b.dir)).toEqual([-1, -1]);
    expect([s.forward, s.backward]).toEqual([0, 2]);
  });

  test('parking and cycle lanes sit at the kerb and widen the carriageway', () => {
    const s = crossSection(piece({ oneway: 1, lanes: 2, parking: 'both', cycleLane: 'left' }), RHT);
    expect(s.bands.map((b) => b.kind)).toEqual(['parking', 'cycle', 'lane', 'lane', 'parking']);
    expect(s.width).toBeCloseTo(
      2 * LANE_WIDTH_M.secondary + 2 * PARKING_WIDTH_M + CYCLE_LANE_WIDTH_M,
    );
    // A solid line beside the cycle lane; none beside parking.
    expect(s.dividers.find((d) => d.role === 'cycle')?.style).toBe('solid');
  });

  test('a recorded width is used when it leaves each lane a plausible width, refused when not', () => {
    expect(crossSection(piece({ oneway: 1, lanes: 3, width: 12 }), RHT).width).toBeCloseTo(12);
    expect(crossSection(piece({ oneway: 1, lanes: 3, width: 12 }), RHT).widthRecorded).toBe(true);
    // 3 m for 3 lanes: junk for a carriageway, the class default drawn instead.
    const junk = crossSection(piece({ oneway: 1, lanes: 3, width: 3 }), RHT);
    expect(junk.widthRecorded).toBe(false);
    expect(junk.width).toBeCloseTo(3 * LANE_WIDTH_M.secondary);
  });

  test('turn lanes go to their lanes in the traveller’s order, both directions', () => {
    const s = crossSection(
      piece({
        lanesForward: 2,
        lanesBackward: 2,
        turnLanesForward: parseTurnLanes('left|through;right'),
        turnLanesBackward: parseTurnLanes('left|through'),
      }),
      RHT,
    );
    // Drawn left → right: backward right-to-left (its kerb lane first), then forward.
    expect(s.bands.map((b) => b.turns)).toEqual([
      ['through'],
      ['left'],
      ['left'],
      ['through', 'right'],
    ]);
  });

  test('a turn list with the wrong number of lanes draws no arrows at all', () => {
    const s = crossSection(
      piece({ oneway: 1, lanes: 3, turnLanes: parseTurnLanes('left|through') }),
      RHT,
    );
    expect(s.bands.every((b) => b.turns === null)).toBe(true);
  });
});

describe('bus lanes', () => {
  test('from a per-lane pattern', () => {
    const s = crossSection(piece({ oneway: 1, lanes: 3, busLanes: parseBusLanes('--b') }), RHT);
    expect(s.bands.map((b) => b.kind)).toEqual(['lane', 'lane', 'bus']);
    expect(s.dividers.map((d) => d.role)).toEqual(['lanes', 'bus']);
  });

  test('from a count: the kerb lane, on the side traffic keeps to', () => {
    expect(crossSection(piece({ oneway: 1, lanes: 4, lanesBus: 1 }), RHT).bands.at(-1)?.kind).toBe(
      'bus',
    );
    expect(crossSection(piece({ oneway: 1, lanes: 4, lanesBus: 1 }), LHT).bands[0].kind).toBe(
      'bus',
    );
  });

  test('from busway:left on a one-way road: the leftmost lane', () => {
    const s = crossSection(piece({ oneway: 1, lanes: 3, busway: 'left' }), RHT);
    expect(s.bands.map((b) => b.kind)).toEqual(['bus', 'lane', 'lane']);
  });

  test('never every lane: an all-bus pattern is drawn as plain lanes', () => {
    const s = crossSection(piece({ oneway: 1, lanes: 2, busLanes: parseBusLanes('bb') }), RHT);
    expect(s.bands.every((b) => b.kind === 'lane')).toBe(true);
  });

  test('a single-lane road never becomes a bus lane from a count', () => {
    const s = crossSection(piece({ oneway: 1, lanes: 1, lanesBus: 1 }), RHT);
    expect(s.bands.map((b) => b.kind)).toEqual(['lane']);
  });
});

describe('which line is painted', () => {
  test('unrecorded lanes: a dashed centre line on a through road, nothing on a residential one', () => {
    const tertiary = crossSection(piece({ highway: 'tertiary' }), RHT);
    expect(tertiary.recorded).toBe(false);
    expect(tertiary.dividers).toEqual([
      expect.objectContaining({ role: 'centre', style: 'dashed' }),
    ]);
    expect(crossSection(piece({ highway: 'residential' }), RHT).dividers).toEqual([]);
    expect(crossSection(piece({ highway: 'residential', oneway: 1 }), RHT).dividers).toEqual([]);
  });

  test('a recorded major road gets a double centre line, yellow where centre lines are', () => {
    const s = crossSection(piece({ highway: 'primary', lanes: 4 }), US);
    const centre = s.dividers.find((d) => d.role === 'centre');
    expect(centre?.style).toBe('double');
    expect(centre?.colour).toBe('yellow');
    expect(
      crossSection(piece({ highway: 'primary', lanes: 4 }), RHT).dividers.find(
        (d) => d.role === 'centre',
      )?.colour,
    ).toBe('white');
  });

  test('motorways get solid edge lines', () => {
    const s = crossSection(piece({ highway: 'motorway', oneway: 1 }), RHT);
    expect(s.dividers.filter((d) => d.role === 'edge')).toHaveLength(2);
  });

  test('the paint rules by place', () => {
    expect(paintRulesAt(-73.98, 40.76, 'right').yellowCentre).toBe(true);
    expect(paintRulesAt(2.16, 41.39, 'right').yellowCentre).toBe(false);
  });
});

describe('junk', () => {
  test('a garbled turn or bus pattern does not parse, so it draws nothing', () => {
    // The compiler writes an empty lane as `none` (`streetTags.ts`); anything else is junk here.
    expect(parseTurnLanes('left|none|none')).toEqual([['left'], [], []]);
    for (const junk of ['left|straight', 'l|r', '', 'left||', 3, null]) {
      expect(parseTurnLanes(junk)).toBeUndefined();
    }
    for (const junk of ['--x', 'b|b', '', 'bbbbbbbbbbbbb', 7])
      expect(parseBusLanes(junk)).toBeUndefined();
  });
});

describe('sections compare and reverse', () => {
  test('reversing twice is the identity, and swaps the directions once', () => {
    const s = crossSection(piece({ lanes: 3, lanesForward: 2, parking: 'right' }), RHT);
    const r = reverseSection(s);
    expect([r.forward, r.backward]).toEqual([s.backward, s.forward]);
    expect(r.bands[0].kind).toBe('parking');
    expect(sameSection(reverseSection(r), s)).toBe(true);
    expect(sameSection(r, s)).toBe(false);
  });
});
