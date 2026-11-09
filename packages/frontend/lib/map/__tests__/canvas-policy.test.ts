import { describe, expect, test } from 'bun:test';
import { canvasBottomClearance, canvasChromeInsets } from '../canvas-policy';

describe('canvas-local chrome insets', () => {
  test('combines clipping and safe-area intrusion without adding overlapping distances', () => {
    expect(
      canvasChromeInsets({
        bounds: { x: 0, y: 0, width: 500, height: 600 },
        viewport: { x: 40, y: 25, width: 300, height: 400 },
        safeArea: { left: 20, right: 180, top: 50, bottom: 120 },
      }),
    ).toEqual({ left: 40, right: 180, top: 50, bottom: 175 });
  });
  test('does not reintroduce window insets already removed by an inset host', () => {
    expect(
      canvasChromeInsets({
        bounds: { x: 0, y: 0, width: 300, height: 400 },
        viewport: { x: 0, y: 0, width: 300, height: 400 },
        safeArea: { left: 0, right: 0, top: 0, bottom: 0 },
      }),
    ).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});

describe('live panel bottom clearance', () => {
  test('includes the keyboard-excluded local region even though the map remains full height', () => {
    const clearance = canvasBottomClearance({
      bounds: { x: 0, y: 0, width: 411.4286, height: 914.2857 },
      viewport: { x: 0, y: 0, width: 411.4286, height: 572.1905 },
    });
    expect(clearance).toBeCloseTo(342.0952, 4);
  });

  test('uses local visible bottom, ignoring the embedded host origin', () => {
    expect(
      canvasBottomClearance({
        bounds: { x: 80, y: 120, width: 500, height: 700 },
        viewport: { x: 30, y: 90, width: 400, height: 380 },
      }),
    ).toBe(230);
  });

  test('does not compensate twice when the host already resizes around the keyboard', () => {
    expect(
      canvasBottomClearance({
        bounds: { x: 80, y: 120, width: 400, height: 572 },
        viewport: { x: 0, y: 0, width: 400, height: 572 },
      }),
    ).toBe(0);
  });
});
