/**
 * The GoWay logo as a component — one implementation, web and native.
 *
 * It draws {@link artwork} through `react-native-svg`, which resolves to a real
 * `<svg>` on web and to the native SVG views on iOS and Android, so there is no
 * `.web.tsx`/`.native.tsx` fork to drift and no platform where the brand is a
 * different drawing.
 *
 * **Nothing here loads a file.** A logo fetched over the network is a logo that
 * can fail to arrive — a slow link, a bad deploy, a 404 on a path that moved —
 * and it fails by being *absent*, which is the one failure a brand mark must
 * not have. Inlining the geometry makes the logo part of the bundle: if the app
 * rendered, the logo rendered. `public/brand/*.svg` exists for the cases that
 * genuinely need a URL (the favicon, an `<img>` in somebody else's page) and is
 * generated from the same data by `scripts/build-brand.ts`.
 *
 * ## Size is given as a width, never as a height and never as both
 *
 * The two variants have very different aspect ratios — 1.582:1 for the wordmark
 * and 0.98:1 for the mark — so a caller that sets both will letterbox one of
 * them. `width` is the single input and the height follows from the artwork's
 * own `viewBox`, which also means a future artwork revision re-proportions
 * every call site instead of cropping in some of them.
 */
import { memo } from 'react';
import Svg, { Path } from 'react-native-svg';

import { GOWAY_INK, GOWAY_MARK, GOWAY_WORDMARK, aspectRatio, type GowayArtwork } from './artwork';

/**
 * Which drawing to render.
 *
 *  - `wordmark` — "GO" over "WAY", the full lockup. Unreadable below ~48px.
 *  - `mark` — the "G" bubble alone. The one to use below that; see the note on
 *    {@link GOWAY_MARK} for where even it stops reading.
 */
export type GowayLogoVariant = 'wordmark' | 'mark';

const ARTWORK: Record<GowayLogoVariant, GowayArtwork> = {
  wordmark: GOWAY_WORDMARK,
  mark: GOWAY_MARK,
};

export interface GowayLogoProps {
  /** Rendered width in px. The height follows the artwork's aspect ratio. */
  width: number;
  /** Defaults to the full lockup. */
  variant?: GowayLogoVariant;
  /**
   * Accessible name.
   *
   * Defaults to `GoWay` because that is what the image says; pass something
   * else only where the logo means more than itself (a link, a button), and
   * pass `''` where it sits beside a label that already reads "GoWay".
   */
  label?: string;
  testID?: string;
}

/** The height that {@link GowayLogo} will render at a given width. */
export function gowayLogoHeight(width: number, variant: GowayLogoVariant = 'wordmark'): number {
  return width / aspectRatio(ARTWORK[variant]);
}

function GowayLogoComponent({
  width,
  variant = 'wordmark',
  label = 'GoWay',
  testID,
}: GowayLogoProps) {
  const artwork = ARTWORK[variant];
  const height = gowayLogoHeight(width, variant);

  return (
    <Svg
      width={width}
      height={height}
      viewBox={artwork.viewBox}
      // A decorative logo beside its own name is noise in a screen reader, so
      // an empty label hides it rather than forcing callers to wrap it.
      accessible={label !== ''}
      accessibilityRole="image"
      accessibilityLabel={label || undefined}
      testID={testID}
    >
      {artwork.paths.map((path, index) => (
        // Index keys: the array is a fixed, ordered drawing, never reordered
        // and never filtered by anything but `part`. Draw order is the artwork
        // (see `artwork.ts`), so a key that survived a reorder would be a bug.
        <Path key={`${path.part}-${path.layer}-${index}`} fill={GOWAY_INK[path.ink]} d={path.d} />
      ))}
    </Svg>
  );
}

export const GowayLogo = memo(GowayLogoComponent);
