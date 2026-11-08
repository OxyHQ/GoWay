import { describe, expect, test } from 'bun:test';
import { canvasChromeInsets } from '../canvas-policy';

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
