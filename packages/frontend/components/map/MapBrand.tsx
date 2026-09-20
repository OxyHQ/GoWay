/**
 * The GoWay mark on the map — bottom-left, on every map GoWay draws.
 *
 * Google's logo is in the bottom-left corner of every Google map, in their app,
 * in a `<GoogleMap>` in somebody's React page and in a bare `<iframe>` of
 * maps.google.com; Apple's wordmark is in the bottom-left corner of every Apple
 * map. Neither is a decoration and neither is optional, because a map platform
 * that is invisible inside other people's pages is a map platform nobody has
 * heard of. This is GoWay's.
 *
 * ## Why `MapCanvas` renders it and no screen can
 *
 * Exactly the reasoning in `MapAttribution` — a thing that must be on every map
 * cannot be something a screen remembers to add. `MapCanvas` renders both, both
 * are bare components with no `enabled` prop, and there is deliberately no way
 * to turn either off. That is what makes `app/frame.tsx` — the embed — carry
 * the brand without asking for it, and what stops the next route that renders a
 * map from shipping without it.
 *
 * ## Why there is no plate behind it
 *
 * Because the artwork already is one. GoWay's logo is a sticker: every letter
 * carries a heavy `#004aad` outline, and that outline is what separates it from
 * whatever it is standing on. It was checked rather than assumed — rendered at
 * 90px over the eight colours that actually cover a GoWay map, sampled from
 * `lib/map/style/palette.ts`: light land `#f6f4eb`, built-up `#fef4df`, roads
 * `#fefefe`, light water `#8ddbf6`, dark land `#34445b`, dark built-up
 * `#45476e`, dark water `#1c347a`, and black. It reads on all eight, and it
 * reads for two different reasons: on the light four the blue outline carries
 * it, and on the dark four the outline recedes into the basemap and the bright
 * `#acd0ff` and `#ffffff` counters carry it instead. A card behind it would add
 * a rectangle to the map and buy nothing.
 *
 * Which also means it needs no light/dark variant. One drawing, both
 * appearances — and no dependence on the map's appearance, which matters
 * because the map's appearance and the app's theme are separate settings and
 * this component can see only one of them.
 *
 * ## It is not a link, on purpose
 *
 * In the app, tapping the logo would go where the user already is. In the
 * embed, it would be a click target inside somebody else's page, and the whole
 * reason `app/frame.tsx` can live without a `frame-ancestors` rule is that it
 * offers nothing to aim a user's click at. The embed's way back to the full map
 * is the explicit "View larger map" affordance, which says what it does.
 */
import { memo } from 'react';
import { View } from 'react-native';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';

import { GowayLogo, gowayLogoHeight } from '@/components/brand';

/**
 * How wide the logo draws on the map.
 *
 * 76px puts the lockup at 48px tall, which is the smallest it stays legible at
 * — the wordmark's two rows mean its cap height is roughly a fifth of its
 * width, so it dies much earlier than a single-line logo would. Google's
 * bottom-left badge is 66px wide and one row tall; this is the two-row
 * equivalent, not a bigger claim on the canvas.
 */
export const MAP_BRAND_WIDTH = 76;

/** Breathing room between the mark and whatever is below it. */
const BRAND_GAP = 4;

/**
 * Where the credit has to start so it cannot run under the mark.
 *
 * Exported because `MapAttribution` is the one that has to respect it, and the
 * two must not each hold a private copy of the other's geometry.
 */
export const MAP_BRAND_CLEARANCE = MAP_BRAND_WIDTH + 16;

/** How tall the mark draws. Layout that has to clear it reads this. */
export const MAP_BRAND_HEIGHT = gowayLogoHeight(MAP_BRAND_WIDTH);

function MapBrandComponent() {
  const bottomEdge = useBottomEdgeInset();

  return (
    <View
      pointerEvents="none"
      className="absolute left-space-8"
      // Same rule as the credit: a claim on the bottom edge already folds in
      // the safe area, so the plain gap is added to it and not to the
      // safe-area-aware one.
      style={{ bottom: bottomEdge > 0 ? bottomEdge + BRAND_GAP : BRAND_GAP }}
      testID="goway-map-brand"
    >
      <GowayLogo width={MAP_BRAND_WIDTH} />
    </View>
  );
}

export const MapBrand = memo(MapBrandComponent);
