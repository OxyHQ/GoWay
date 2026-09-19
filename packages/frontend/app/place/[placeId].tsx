/**
 * `https://goway.to/place/<placeId>` — the canonical place link.
 *
 * It renders the map screen with the place already selected rather than a
 * standalone detail page: a shared link should land somebody in the product,
 * with the surroundings they need to make sense of the pin, not on a leaf node.
 *
 * The parameter is a GoWay Place ID and never a provider id, so the link
 * survives an OpenStreetMap renumbering and resolves for a GoWay-created place
 * that matches nothing external (AGENTS.md → Product boundaries).
 */
import { useLocalSearchParams } from 'expo-router';

import ExploreScreen from '@/features/explore/ExploreScreen';

export default function PlaceRoute() {
  const { placeId } = useLocalSearchParams<{ placeId?: string | string[] }>();
  const id = Array.isArray(placeId) ? placeId[0] : placeId;
  return <ExploreScreen initialPlaceId={id ?? null} />;
}
