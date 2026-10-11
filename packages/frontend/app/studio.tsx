/**
 * `/studio` — Camera Studio: author a camera tour, preview it, share it as a
 * link (`?tour=1.…`, `lib/map/tourLink.ts`), export it as a video on the web.
 * See `docs/MAP_CAMERA_STUDIO.md`.
 *
 * Thin on purpose, because expo-router puts every route file in the entry
 * bundle: this file is the feature check and one `lazy()`. The screen and
 * everything it uses load from `features/flyover/lazy.ts` only when the flag
 * is on, so with it off a visitor downloads nothing of the Studio.
 *
 * With the flag off a shared tour link still lands somewhere truthful: the
 * map, at the tour's first camera (`lat`/`lng`/`zoom`, which every tour link
 * carries), through the same viewport parser every map link goes through.
 */
import { lazy, Suspense } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

import { useMapFeatures } from '@/lib/map/useMapFeatures';

const StudioScreen = lazy(() =>
  import('@/features/flyover/lazy').then((chunk) => ({ default: chunk.StudioScreen })),
);

export default function StudioRoute() {
  const params = useLocalSearchParams<{ lat?: string; lng?: string; zoom?: string }>();
  // The map-feature registry's `flyover` (`lib/map/mapFeatures.ts`): the
  // build, the person's choice in the settings modal's Labs, and `?flyover=1` in
  // development. Native reads the stored choice asynchronously, so this waits
  // for it rather than redirecting somebody who did turn the Studio on.
  const { features, hydrated } = useMapFeatures();
  if (!hydrated) return null;
  if (!features.on('flyover')) {
    const { lat, lng, zoom } = params;
    return (
      <Redirect
        href={
          lat && lng && zoom ? { pathname: '/', params: { lat, lng, zoom } } : { pathname: '/' }
        }
      />
    );
  }
  return (
    <Suspense fallback={null}>
      <StudioScreen />
    </Suspense>
  );
}
