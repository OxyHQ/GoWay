/**
 * EXTENSION POINT — "Products at this store", from `@mercaria.co/sdk`.
 *
 * Renders nothing today, and is mounted in `PlaceDetails` exactly where the
 * section will go, so the later phase that fills it changes this file and no
 * other.
 *
 * What it will do (the place-data plan, phase 4), so nobody fills it any other
 * way:
 *
 *  - read the place's `commerce.mercaria.store` capability — a Mercaria
 *    location id — and ask Mercaria's public API which location points back at
 *    THIS GoWay place (`/public/v1/locations?goWayPlaceId=`). Products show only
 *    when both sides agree; a capability alone is a claim, not a link;
 *  - list that location's products with Mercaria's coarse availability
 *    (`in_stock | low_stock | out_of_stock`), never exact quantities, plus the
 *    merchant's rating — Mercaria's purchase reviews, kept apart from this
 *    place's reviews;
 *  - deep-link to mercaria.co for everything else. GoWay stores none of it.
 */
import type { Place } from '@goway.to/sdk';

export interface PlaceProductsProps {
  place: Place;
}

export function PlaceProducts(_props: PlaceProductsProps): null {
  return null;
}
