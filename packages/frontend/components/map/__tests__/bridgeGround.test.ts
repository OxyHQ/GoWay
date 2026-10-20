import { expect, test } from 'bun:test';
import { polyline } from '../engine/roads/roadGraph';
import { bridgeGround, terrainBridges } from '../engine/terrain/bridgeGround';
import type { RoadPiece } from '../engine/roads/roadTiles';

const bridge = {
  line: polyline([
    [0, 0],
    [100, 0],
  ]),
  halfWidth: 10,
};
const retainedDeck = (x: number, y: number) => (Math.abs(y) <= 10 && x >= 0 && x <= 100 ? 14 : 7);

test('a recorded bridge is excluded from bare earth while its abutments remain', () => {
  expect(bridgeGround(50, 0, [bridge], retainedDeck)).toBe(7);
  expect(bridgeGround(0, 0, [bridge], retainedDeck)).toBe(14);
  expect(bridgeGround(100, 0, [bridge], retainedDeck)).toBe(14);
  expect(bridgeGround(50, 11, [bridge], retainedDeck)).toBe(7);
  expect(bridgeGround(50, 0, [], retainedDeck)).toBe(14);
});

test('terrain reconstruction never fills a depression or cuts a natural side slope', () => {
  const valley = (_x: number, y: number) => (Math.abs(y) < 10 ? 4 : 7);
  const slope = (_x: number, y: number) => 10 + y * 0.2;
  for (let x = 0; x <= 100; x += 5)
    for (let y = -15; y <= 15; y++) {
      expect(bridgeGround(x, y, [bridge], valley)).toBe(valley(x, y));
      expect(bridgeGround(x, y, [bridge], slope)).toBe(slope(x, y));
    }
});

test('adjacent bridge carriageways find exterior ground beyond the other deck', () => {
  const adjacent = {
    line: polyline([
      [0, 18],
      [100, 18],
    ]),
    halfWidth: 10,
  };
  const dem = (_x: number, y: number) => (y >= -10 && y <= 28 ? 14 : 7);
  expect(bridgeGround(50, 0, [bridge, adjacent], dem)).toBe(7);
  expect(bridgeGround(50, 18, [bridge, adjacent], dem)).toBe(7);
});

test('the same span reconstructed in neighbouring tiles has no ownership seam', () => {
  const shifted = {
    line: polyline([
      [-50, 0],
      [50, 0],
    ]),
    halfWidth: 10,
  };
  const right = (x: number, y: number) => retainedDeck(x + 50, y);
  for (let y = -10; y <= 10; y++)
    expect(bridgeGround(50, y, [bridge], retainedDeck)).toBe(bridgeGround(0, y, [shifted], right));
});

test('missing exterior elevations retain the measured surface', () => {
  const dem = (_x: number, y: number) => (Math.abs(y) <= 10 ? 14 : NaN);
  expect(bridgeGround(50, 0, [bridge], dem)).toBe(14);
});

test('a separately mapped sidewalk bounds the same deck without mirroring its width to the other bank', () => {
  const x = 16582 * 4096,
    y = 12237 * 4096;
  const road: RoadPiece = {
    way: 1,
    highway: 'primary',
    car: true,
    foot: false,
    roundabout: false,
    tunnel: false,
    bridge: true,
    width: 8,
    points: [
      [x + 100, y + 100],
      [x + 900, y + 100],
    ],
  };
  const sidewalk: RoadPiece = {
    ...road,
    way: 2,
    highway: 'footway',
    car: false,
    foot: true,
    width: 2,
    points: [
      [x + 100, y + 140],
      [x + 900, y + 140],
    ],
  };
  const [deck] = terrainBridges([road, sidewalk], { z: 15, x: 16582, y: 12237 }, 512);
  expect(deck.left).toBeLessThan(0);
  expect(deck.right).toBeGreaterThan(5);
  expect(Math.abs(deck.left ?? 0)).toBeLessThan(3);
  // The gap between the two mapped ways is deck too; the opposite bank is not.
  const dem = (_x: number, y: number) =>
    y < deck.line.ys[0] - 3 || y > deck.line.ys[0] + 6 ? 7 : 14;
  expect(bridgeGround(60, deck.line.ys[0] + 4, [deck], dem)).toBeLessThan(14);
  expect(bridgeGround(60, deck.line.ys[0] - 4, [deck], () => 14)).toBe(14);
});
