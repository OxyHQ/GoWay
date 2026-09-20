/**
 * `https://goway.to/frame?center=LAT,LON&span=A,B` — the embeddable map.
 *
 * The shape is Apple's, deliberately and verbatim:
 * `https://maps.apple.com/frame?center=LAT%2CLON&span=A%2CB`. Somebody wanting
 * to put a map on their page has already met that URL, or Google's equivalent,
 * and the cheapest thing GoWay can do for them is accept the parameters they
 * already know rather than making them learn ours.
 *
 * ## Why an embed route exists at all
 *
 * Because "GoWay is a map platform" is a claim about who can use it, and until
 * this route the answer was "us". A partner could call the API and build their
 * own map, which is a week of work and a MapLibre dependency; or they could
 * iframe `goway.to`, and get the search field, the results sheet, the location
 * controls and the sign-in affordance embedded in their contact page. Every
 * mapping product that is actually embedded anywhere has a third answer, and
 * this is it: the same map, none of the app.
 *
 * ## What "none of the app" means concretely
 *
 * This route renders `MapCanvas` and nothing else — no `MapTopBar`, no
 * `MapSheet`, no `SidePanel`, no search, no "Search this area", no location
 * control. That is not a trimmed-down `ExploreScreen`; it deliberately does
 * not mount `ExploreScreen` at all, because every piece of chrome that screen
 * grows would otherwise appear in strangers' pages the day it lands.
 *
 * Two things ARE rendered and both are non-negotiable:
 *
 *  - The attribution. `MapCanvas` renders it itself and feature code cannot
 *    turn it off, which is the property that makes the licence obligation
 *    survive a route like this one. An embed is precisely where a credit would
 *    get dropped if dropping it were possible.
 *  - A link back to the full map. Apple and Google both do this, and not out
 *    of generosity: an embed that is a dead end is a screenshot, and an embed
 *    someone can click into is how a map platform acquires the users who have
 *    only ever seen it inside somebody else's page.
 *
 * ## Viewport parsing is NOT here
 *
 * It is in `lib/map/embed.ts`, shared with the app route, because `?lat&lng&zoom`
 * on `/` and `?center&span` on `/frame` are one question with two spellings
 * and two parsers would eventually disagree about what `zoom=abc` means. That
 * module's contract is the load-bearing one for this route: **a malformed
 * parameter is ignored, never fatal.** These parameters arrive from a
 * third-party page, in a frame the user cannot reload, assembled by somebody
 * who has never read our documentation — `?center=undefined,undefined` is what
 * a templating bug produces, and it must render the default view rather than a
 * blank frame and a stack trace in someone else's console.
 *
 * ## Framing, and the honest limit of it
 *
 * Nothing here sets `X-Frame-Options` or a `frame-ancestors` CSP, and
 * `public/_headers` deliberately sets neither globally — see the note at the
 * bottom of that file for why a global deny plus a carve-out for this path
 * would not actually be a carve-out. The residual exposure is stated rather
 * than hidden: `/frame` and `/` are the same SPA document, so a page that
 * frames this one has framed the bundle. What makes that acceptable is that
 * this route renders no sign-in affordance and nothing an embedder can aim a
 * user's click at; clickjacking needs a target, and an embed of a map that
 * only pans has none. If a future version of this route grows a button that
 * does something on the user's behalf, that calculation changes and this
 * comment is where to start.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@oxy.so/bloom/typography';

import { MapCanvas, type MapApi, type MapMarker } from '@/components/map';
import { isDegenerateBounds } from '@/lib/map/geo';
import {
  initialViewportFrom,
  parseEmbedParams,
  shouldCentreOnPlace,
  shouldFitBounds,
} from '@/lib/map/embed';
import { usePlace } from '@/lib/goway/queries';
import type { PlaceId } from '@goway.to/sdk';

/** Room left between a fitted `span` and the edge of the frame, in px. */
const FIT_PADDING_PX = 24;

/**
 * Where "View larger map" goes.
 *
 * Written against the canonical origin rather than `window.location`, on
 * purpose: the point of the link is to leave the iframe for the real product,
 * and a preview deployment's own hostname is not the real product.
 */
const GOWAY_ORIGIN = 'https://goway.to';

export default function FrameRoute() {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const parsed = parseEmbedParams(params);
  const mapRef = useRef<MapApi>(null);

  // Only ever enabled when the embedder asked for a place by id, so the normal
  // embed makes no API call at all and renders as fast as the tiles arrive.
  const place = usePlace((parsed.placeId ?? null) as PlaceId | null);

  /**
   * Markers: the explicit `marker=` coordinates, plus the resolved `place=`.
   *
   * The place marker is appended rather than replacing the list, because
   * `?place=…&marker=…` is a legitimate thing to ask for — "our shop, and the
   * two car parks near it" — and silently dropping one of the two would be a
   * parameter that works alone and not together.
   */
  const markers: MapMarker[] = parsed.markers.map((coordinate, index) => ({
    id: `embed-${index}`,
    coordinate,
    kind: 'embed',
  }));
  if (place.data) {
    markers.push({
      id: place.data.id,
      coordinate: place.data.location,
      // `categories` is most-specific-first, so the head is the one a marker
      // should be drawn as.
      kind: place.data.categories[0] ?? 'place',
      label: place.data.name,
      selected: true,
      accessibilityLabel: place.data.name,
    });
  }

  /**
   * How many times the canvas has reported itself ready.
   *
   * A counter rather than a flag because `onReady` fires again after a retry
   * rebuilds the engine, and the camera an embedder asked for has to be
   * re-applied to the new one — the same reason `span=` is applied on ready
   * rather than on mount.
   */
  const [readyCount, setReadyCount] = useState(0);

  /**
   * Apply `span=` once the canvas is ready.
   *
   * On `onReady` rather than on mount because `fitBounds` before the engine
   * has a viewport is a no-op on web and a bridge call into nothing on native
   * — in both cases silently, which is how a `span` parameter comes to look
   * like it is ignored.
   */
  const handleReady = useCallback(() => {
    setReadyCount((count) => count + 1);
    if (!shouldFitBounds(parsed) || !parsed.bounds) return;
    // A zero-area box makes both engines jump to maximum zoom, which is a
    // street-level view of a region the embedder asked to see whole.
    if (isDegenerateBounds(parsed.bounds)) return;
    mapRef.current?.fitBounds(parsed.bounds, { padding: FIT_PADDING_PX, duration: 0 });
  }, [parsed]);

  /**
   * Centre on a resolved `place=`.
   *
   * Only when the embedder gave no camera of their own: `?place=X&center=Y`
   * means "show the area around Y, and mark X", and moving the camera to X
   * would be overruling an explicit instruction with an inferred one.
   *
   * ## Why `readyCount` is a dependency
   *
   * Two things resolve here in an order nothing controls: the place query and
   * the engine. Both `MapCanvas` forks expose the imperative handle from the
   * first render — before their engine exists — and both `moveTo`s return
   * silently when it does not, so a `moveTo` made too early is not deferred,
   * it is DISCARDED. A cached `place=` resolves on the first render and loses
   * its camera move exactly that way, leaving the embed at `DEFAULT_VIEWPORT`
   * with the marker it was asked to show possibly off screen; the `span=`
   * handler above only ever retried `fitBounds`, never this.
   *
   * Depending on the ready counter makes the effect run on whichever of the
   * two arrives second, so the move lands in either order — and re-lands after
   * a retry, which resets the camera.
   */
  const placeCoordinate = place.data ? place.data.location : null;
  const centreOnPlace = shouldCentreOnPlace(parsed, {
    placeResolved: placeCoordinate !== null,
    canvasReady: readyCount > 0,
  });
  useEffect(() => {
    if (!centreOnPlace || !placeCoordinate) return;
    mapRef.current?.moveTo(placeCoordinate, { zoom: parsed.zoom ?? 16, duration: 0 });
    // Coordinates are compared by value: the object identity changes on every
    // render of a successful query, and depending on it would re-centre the
    // map continuously and make it impossible to pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    readyCount,
    centreOnPlace,
    placeCoordinate?.latitude,
    placeCoordinate?.longitude,
    parsed.zoom,
  ]);

  const openFullMap = useCallback(() => {
    const target = parsed.placeId
      ? `${GOWAY_ORIGIN}/place/${encodeURIComponent(parsed.placeId)}`
      : `${GOWAY_ORIGIN}/`;
    void Linking.openURL(target).catch(() => {
      // A blocked popup must not take the embed down with it.
    });
  }, [parsed.placeId]);

  return (
    <View className="flex-1 bg-background">
      <MapCanvas
        ref={mapRef}
        initialViewport={initialViewportFrom(parsed)}
        {...(parsed.appearance ? { appearance: parsed.appearance } : {})}
        markers={markers}
        interaction={
          parsed.interactive
            ? undefined
            : // Every gesture off, not just pan. A map that zooms but does not
              // pan is more confusing than one that does nothing, and an
              // embedder who said `interactive=0` wants a picture.
              { pan: false, zoom: false, rotate: false, pitch: false }
        }
        onReady={handleReady}
        testID="goway-frame-map"
      />

      <Pressable
        onPress={openFullMap}
        accessibilityRole="link"
        accessibilityLabel="View this area on the full GoWay map"
        className="absolute right-space-8 top-space-8 rounded-radius-8 bg-card/90 px-space-8 py-space-4 shadow-s"
      >
        <Text className="text-caption text-foreground">View larger map</Text>
      </Pressable>
    </View>
  );
}
