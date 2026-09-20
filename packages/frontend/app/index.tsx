/**
 * The GoWay entry route: the map, open to everyone.
 *
 * Thin on purpose. Everything about the discovery experience lives in
 * `features/explore` so it can be mounted by more than one route — the place
 * deep link (`app/place/[placeId].tsx`) renders the SAME screen with a
 * selection already made, rather than a second, poorer place page. That is what
 * makes `https://goway.to/place/<id>` open the map with the place on it instead
 * of a detail view with a "back to map" button that has nothing to go back to.
 *
 * The one thing this route does interpret is `?lat=&lng=&zoom=`, the viewport
 * deep link `@goway.to/sdk`'s `links.map(viewport)` has always produced. Until
 * now the app dropped it, so every link built through the published SDK opened
 * on the default camera — the frame the sender chose was thrown away without a
 * word. `parseViewportFromParams` answers with a viewport or with `null`, and
 * `null` simply means the default camera, so a mangled link still opens a map.
 */
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import ExploreScreen from '@/features/explore/ExploreScreen';
import { parseViewportFromParams } from '@/lib/map/viewportLink';

export default function MapRoute() {
  // No generic: `useLocalSearchParams`'s type parameter is a ROUTE, and this
  // route's parameters are whatever the query string carried. The parser takes
  // `unknown`-ish input by design — that is the whole point of it.
  const params = useLocalSearchParams();
  // The camera is INITIAL by contract (`MapCanvasProps.initialViewport`), so
  // this is memoised against the parameter values rather than recomputed into
  // a fresh object every render — a new object identity on a prop the canvas
  // reads once is harmless today and a re-mount waiting to happen tomorrow.
  const initialViewport = useMemo(
    () => parseViewportFromParams(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.lat, params.lng, params.zoom, params.bearing, params.pitch],
  );

  return <ExploreScreen initialViewport={initialViewport} />;
}
