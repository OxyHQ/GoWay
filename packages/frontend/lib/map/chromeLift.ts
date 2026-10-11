/**
 * How far the map's bottom chrome — the "My location" column and the data
 * credit — rises to stay ABOVE a bottom sheet's live top edge on a phone, and
 * when it fades because the sheet has taken the screen.
 *
 * The chrome is laid out against the sheet's RESTING claim on Bloom's bottom
 * edge (its peek height); this is the extra lift to its CURRENT top edge, so at
 * half the credit is visible from the first frame (the OSMF guidelines want it
 * visible at load), and while dragging it rides the sheet. Past half the
 * chrome stops rising, so it never climbs into the top bar, and fades out as
 * the sheet approaches full screen — there is little map left to credit or
 * locate on, and the sheet is what the reader is looking at.
 *
 * A worklet (`'worklet'` is only a string to anything but Reanimated), so the
 * UI thread runs exactly what `__tests__/chromeLift.test.ts` checks.
 */

/** The chrome rises with the sheet up to this share of the window height. */
export const CHROME_MAX_RISE_RATIO = 0.5;
/** ...and is gone by this one. */
export const CHROME_HIDDEN_RATIO = 0.65;

export interface ChromeLift {
  /** px to translate UP from the position laid out against the claim. */
  lift: number;
  /** 0 … 1. */
  opacity: number;
}

export function chromeLift(input: {
  /** The sheet's on-screen height, px from the window's bottom. */
  sheetHeight: number;
  /** What the sheet claims on the bottom edge (its resting peek), px. */
  claimed: number;
  windowHeight: number;
}): ChromeLift {
  'worklet';
  const { sheetHeight, claimed, windowHeight } = input;
  if (!(windowHeight > 0) || !(sheetHeight > 0)) return { lift: 0, opacity: 1 };
  const rise = Math.min(sheetHeight, windowHeight * CHROME_MAX_RISE_RATIO);
  const lift = Math.max(0, rise - Math.max(0, claimed));
  const fadeStart = windowHeight * CHROME_MAX_RISE_RATIO;
  const fadeEnd = windowHeight * CHROME_HIDDEN_RATIO;
  const opacity =
    sheetHeight <= fadeStart
      ? 1
      : sheetHeight >= fadeEnd
        ? 0
        : 1 - (sheetHeight - fadeStart) / (fadeEnd - fadeStart);
  return { lift, opacity };
}
