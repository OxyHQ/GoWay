/**
 * Turning "the sheet covers the bottom 45%" into a padding a map can be fitted
 * inside.
 *
 * `ExploreScreen`'s `useMapPadding` decides WHAT the chrome covers — that needs
 * the layout mode, the sheet's detent and Bloom's edge registry, all of which
 * are React. This file decides what is SAFE to hand an engine, which is pure
 * arithmetic and therefore lives on its own, with no import that reaches
 * `react-native`, so it can be run directly in a test.
 *
 * ## Why it has to exist
 *
 * `MapApi.fitBounds` ends up in MapLibre's `cameraForBoxAndBearing`, which
 * divides the FREE viewport by the size of the box being framed:
 *
 * ```
 * availableWidth = canvasWidth - (padding.left + padding.right)
 * scaleX         = availableWidth / boxWidth
 * zoom           = log2(scale * min(scaleX, scaleY))
 * centre         = <box centre> - <padding offset> * (scale / 2 ** zoom)
 * ```
 *
 * Three outcomes, only one of which is survivable by accident:
 *
 *  - **Negative free space** (padding larger than the canvas) — MapLibre warns
 *    "Map cannot fit within canvas with the given bounds, padding, and/or
 *    offset" and DECLINES the fit. No crash, but the route is not framed, which
 *    is the failure this padding exists to prevent.
 *  - **Exactly zero free space** — `zoom` is `-Infinity`, the padding offset is
 *    multiplied by `Infinity`, and `0 * Infinity` is `NaN`. The centre becomes
 *    `(NaN, NaN)` and constructing a `LngLat` from it THROWS.
 *  - **Non-finite padding** — `NaN` survives every comparison in MapLibre's
 *    own guard (`scaleX < 0` is false for `NaN`), propagates to the centre, and
 *    throws the same way.
 *
 * So the contract here is: four finite, non-negative sides whose sum per axis
 * is at most {@link MAX_PADDING_SHARE} of that axis — which leaves at least 35%
 * of each axis free, and never exactly zero.
 */

/**
 * The largest share of the canvas the padding may claim on one axis, counting
 * BOTH of that axis' sides together.
 *
 * "Both sides together" is the point of the number, and it used to be applied
 * per SIDE: a fully-open sheet could ask for 65% at the top AND 65% at the
 * bottom, i.e. 130% of the height, which MapLibre answers by declining the fit
 * entirely. Capping the pair keeps the promise the constant was making.
 */
export const MAX_PADDING_SHARE = 0.65;

export interface FitPaddingSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The padding the chrome WANTS, clamped to one a map can be fitted inside.
 *
 * `fallback` is used whole when the viewport has no usable size — the first
 * render before layout, a background tab, a collapsed container. That is a real
 * state rather than a rounding error, so it is stated rather than left to
 * arithmetic that happens to survive it: with no canvas there is no chrome to
 * fit around, and a uniform gap is the honest answer until there is.
 */
export function clampFitPadding(
  desired: FitPaddingSides,
  viewport: { width: number; height: number },
  fallback: number,
): FitPaddingSides | number {
  if (!isPositiveSize(viewport.width) || !isPositiveSize(viewport.height)) {
    return Number.isFinite(fallback) ? Math.max(0, fallback) : 0;
  }

  const [top, bottom] = fitAxis(desired.top, desired.bottom, viewport.height);
  const [left, right] = fitAxis(desired.left, desired.right, viewport.width);
  return { top, right, bottom, left };
}

/** A dimension we can divide by. `0`, `NaN` and `Infinity` are all "not yet". */
export function isPositiveSize(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The two paddings on one axis, shrunk until together they claim no more than
 * {@link MAX_PADDING_SHARE} of it — and never less than zero, never NaN.
 *
 * Shrinking PROPORTIONALLY rather than capping each side keeps the asymmetry
 * that is the whole reason this padding exists (the sheet really is at the
 * bottom) while guaranteeing the map is left something to draw in.
 */
export function fitAxis(near: number, far: number, axis: number): [number, number] {
  // A non-finite side is dropped to zero rather than carried: it is the one
  // input that turns the whole fit into a thrown `Invalid LngLat object`.
  const a = Number.isFinite(near) ? Math.max(0, near) : 0;
  const b = Number.isFinite(far) ? Math.max(0, far) : 0;
  const budget = Math.max(0, Math.floor(axis * MAX_PADDING_SHARE));
  const total = a + b;
  if (total <= budget) return [Math.round(a), Math.round(b)];
  // `total > budget >= 0` implies `total > 0`, so the ratio is finite.
  const scale = budget / total;
  return [Math.floor(a * scale), Math.floor(b * scale)];
}
