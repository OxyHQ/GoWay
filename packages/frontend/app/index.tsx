/**
 * The GoWay entry route: the map, open to everyone.
 *
 * Thin on purpose. Everything about the discovery experience lives in
 * `features/explore` so it can be mounted by more than one route — the place
 * deep link (`app/place/[placeId].tsx`) renders the SAME screen with a
 * selection already made, rather than a second, poorer place page. That is what
 * makes `https://goway.to/place/<id>` open the map with the place on it instead
 * of a detail view with a "back to map" button that has nothing to go back to.
 */
import ExploreScreen from '@/features/explore/ExploreScreen';

export default function MapRoute() {
  return <ExploreScreen />;
}
