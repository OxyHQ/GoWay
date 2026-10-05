# Merchant discovery with `@goway.to/sdk`

How an application that is **not** GoWay finds nearby places that assert an
ecosystem capability, renders them on a map, lets the user pick one, and hands
them to the canonical `goway.to` page.

FairCoin is the worked example throughout: a FairCoin wallet showing "shops near
me that take FairCoin" (OxyHQ/GoWay#8). **Nothing in the mechanism is
FairCoin-specific.** A capability is a namespaced string in an open key space,
so a Moovo pickup-point map, a Mercaria storefront layer or a Homiio listings
map is this same guide with one string changed — see
[Generalizing to other products](#generalizing-to-other-products). There is no
`/faircoin-merchants` endpoint and there will not be one.

## What you are not integrating

- **No map renderer.** GoWay currently draws with MapLibre. Your app does not
  install it, configure it or name it. Installing `@goway.to/sdk` pulls in no
  renderer and no provider client; its one runtime dependency is `zod` 4,
  because the contract *is* zod schemas.
- **No provider knowledge.** Tiles come from OpenFreeMap today, geocoding from
  Photon and Nominatim, routing from Valhalla. All four are replaceable adapters
  behind the GoWay API. A result tells you which provider answered
  (`SearchResult.source`) because provenance is never discarded — that is
  information to display, not an interface to program against.
- **No PostGIS, no SQL, no schema.** GoWay's Drizzle/PostGIS tables are
  deliberately unpublished. You get `Place`, not a row. A GoWay migration cannot
  break your build.
- **No merchant-location database of your own.** A merchant that has a GoWay
  Place identity already has coordinates, an address, opening hours, categories,
  provenance and a stable ID. Persist the **GoWay Place ID** and nothing else.

## Status of the pieces

Documentation that describes unbuilt things as if they shipped is worse than no
documentation, so, as of this writing (API paths below are relative to
`https://api.goway.to/api/v1`):

| Piece | State |
| --- | --- |
| `@goway.to/sdk` client, types, errors, links | Built (`packages/sdk`). This guide is written against **`0.3.0`, which is not on npm yet**; npm still carries `0.1.0`, which predates pages, the claim and capability-write methods and the typed `gone` error. See the [changelog](../../packages/sdk/CHANGELOG.md). |
| The contracts | Built. `packages/contracts` (`@goway/contracts`, private, bundled into the SDK) holds the zod schema of every request, response and error — the same schemas the API validates with and the SDK parses with. Published as OpenAPI at `https://api.goway.to/api/v1/openapi.json`. |
| `GET /places/nearby`, `/places/bounds`, `/places/{placeId}` | Built. Lists are pages, `{ items, nextCursor }`, and every place on them carries its current hours exceptions. A place moderation removed answers `410`; a merged one answers `410` with `details.mergedInto`. |
| `GET /places?ids=` (`places.getMany`) | Built. Up to 50 places by id in one request, each as `/places/{placeId}` answers it, or listed as `gone` (with `mergedInto`) or `missing`. |
| `POST /places`, `PATCH /places/{placeId}` with server-derived verification | Built. `PATCH` is a merge patch: absent leaves a field alone, `null` clears it. |
| `PUT` / `DELETE /places/{placeId}/capabilities/{key}` | Built. One capability per request; the tier is derived from the caller. |
| `POST` / `GET /places/{placeId}/claims`, `GET /claims` | Built. A claim is always created `pending`, usually for the business's Oxy organization (`oxyAccountId`). `GET /claims?placeId=` narrows an account's claims to one place. |
| Approving or rejecting a claim | Built, for GoWay operators only: `POST /moderation/claims/{claimId}/decision`. Until a claim is approved, its holder's assertions are `community_reported`; approval re-tiers the claimant's own pending statements to `business_asserted`. |
| `oxy_verified` capabilities | Built, for GoWay operators only: `PUT` / `DELETE /moderation/places/{placeId}/capabilities/{key}`. No public request can produce or remove the tier. |
| `GET /places/{placeId}/revisions`, `POST /places/{placeId}/reports` | Built. The public history says what changed and when, never who; reports go to the moderation queue. |
| Search, geocoding, directions | Built. |
| A deployed public API at `https://api.goway.to` | Deployed; `goway.to` itself runs against it. What is and is not populated yet is in the [README](../../README.md#deploying-the-web-app). |
| "Products at this store" on goway.to | Built (`packages/frontend/features/explore/PlaceProducts.tsx`), reading Mercaria through `@mercaria.co/sdk` `0.2.0`. See [GoWay renders the shelf](#goway-renders-the-shelf). |
| Map rendering primitives inside the SDK | **Not yet.** The SDK is headless; the map seam lives in `packages/frontend/components/map`. See [Render the merchants](#render-the-merchants). |

## Install

```bash
bun add @goway.to/sdk    # npm i @goway.to/sdk
```

Until `0.3.0` is published, consumers inside the Oxy workspace depend on the
built package from this repo. Either way the import is the same, and it is the
only GoWay package you ever import: the domain types, value sets, limits and
helpers are re-exported from it, so you never reach into a private GoWay package
and never keep your own copy of `Place`. `zod` comes in as a dependency; an app
that already uses zod 4 shares the one copy.

## Create one client

```ts
import { createGoWayClient } from '@goway.to/sdk';

// Anonymous: the map, Places, search and routing all work signed out.
const goway = createGoWayClient();
```

Discovery needs no account. Supply a token only for the identity-bound calls —
creating a place, asserting a capability, claiming one:

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient({
  // Only needed for writes; every read in this guide works signed out.
  getAccessToken: () => oxy.getAccessToken(),
  locale: 'ca',
});
```

`getAccessToken` is called before **every** request and the SDK never caches,
stores or logs the result: your Oxy session package stays the single authority,
and a copy held here would go stale exactly when it mattered. Options are
validated at construction, so a typo throws a `TypeError` at start-up rather
than a confusing failure on the first request.

Create the client **once** for the app. It is stateless and frozen.

## Decide which area to search — before you ask for anything

Discovery is driven by an area, and which area you use is a privacy decision,
not an implementation detail. Two supported inputs, in preference order:

1. **An explicitly supplied viewport.** The box the user is already looking at,
   or a city they chose. No permission, no prompt, no coordinate that belongs to
   the person.
2. **A user-approved location fix**, obtained at the moment the user invokes a
   location-dependent action ("Merchants near me") and **never** on app start.

```ts
// 1 — the area the user is already looking at.
const { items: merchants } = await goway.places.inBounds({
  west: view.west,
  south: view.south,
  east: view.east,
  north: view.north,
  capabilities: ['payments.faircoin.accepted'],
  limit: 200,
});
```

```ts
// 2 — a fix the user just asked for. Use it, do not keep it.
const { items: merchants } = await goway.places.nearby({
  latitude: center.latitude,
  longitude: center.longitude,
  radiusMeters: 2_000,
  capabilities: ['payments.faircoin.accepted'],
  limit: 50,
});
```

The rules a wallet must hold to, which are GoWay's own
(`AGENTS.md` → Privacy) and are an acceptance criterion of OxyHQ/GoWay#8:

- **Opening the map never asks for location.** If your wallet requests the
  permission at launch "so the map is ready", you have built the thing this
  design exists to avoid.
- **A coordinate is transient request data.** It may live in component state for
  the life of the screen. It does not go into a cache key you persist, a
  "last known location" store, an analytics event or a wallet-side table.
  The cheapest way not to have a location history is not to have a writer.
- **GoWay holds itself to the same rule.** Precise coordinates are transient
  request data on the server too, and user location stays out of the Places
  tables — a nearby query is a question GoWay answers, not a row it keeps.
- If your wallet refetches on every frame of a pan, you have re-created a
  location trail out of request logs. Refetch on a *committed* area instead —
  the opening view, or an explicit "Search this area" — which is what GoWay's
  own map does.

## Ask for merchants: the capability filter

One call, one generic mechanism:

```ts
import type { GeoCoordinate, PlaceWithDistancePage } from '@goway.to/sdk';

export async function nearbyMerchants(center: GeoCoordinate): Promise<PlaceWithDistancePage> {
  return goway.places.nearby({
    latitude: center.latitude,
    longitude: center.longitude,
    radiusMeters: 2_000,
    capabilities: ['payments.faircoin.accepted'],
    limit: 50,
  });
}
```

The answer is one **page**, `{ items, nextCursor }`. Items come back nearest
first, each one a `PlaceWithDistance` — a full `Place` plus `distanceMeters` from
the query point, computed server-side so every client agrees on the number.
`nextCursor` is `null` on the last page; otherwise pass it back as `cursor`,
with the **same** filters, for the next one. A cursor is opaque and bound to the
query that issued it: never build or parse one, and never replay it with other
filters (GoWay refuses that as `bad_request`). There are no totals.

A map wants one page of the committed area — past a few hundred pins the extra
ones are not information. A list view ("every merchant within 2 km") can walk
all of them with `iterateGoWayPages`, which follows the cursors for you and
stops rather than looping if the server ever repeats one:

```ts
import { iterateGoWayPages, type GeoCoordinate, type PlaceWithDistance } from '@goway.to/sdk';

export async function allNearbyMerchants(center: GeoCoordinate): Promise<PlaceWithDistance[]> {
  const query = {
    latitude: center.latitude,
    longitude: center.longitude,
    radiusMeters: 2_000,
    capabilities: ['payments.faircoin.accepted'],
  };
  const merchants: PlaceWithDistance[] = [];
  for await (const merchant of iterateGoWayPages((cursor) => goway.places.nearby({ ...query, cursor }))) {
    merchants.push(merchant);
    if (merchants.length >= 500) break; // stop early; nothing further is requested
  }
  return merchants;
}
```

What the filter means, precisely:

- **A key is `<namespace>.<capability>`**, split at the last dot.
  `payments.faircoin` + `accepted` gives `payments.faircoin.accepted`.
- **A place matches only when it HAS the capability:** its *strongest*
  assertion of the key — highest verification tier, then freshest — holds,
  meaning its value is not `false`, `0`, `''` or `[]`. A business that stopped taking
  FairCoin and says so (`business_asserted`, `false`) drops out of the filter
  even though a customer once reported `true`. Merely *mentioning* the key is
  not enough. `placeHasCapability(place, key)` asks the same question, by the
  same rule, of a `Place` you already hold — one from `places.get`, or from a
  search that did not filter.
- **A list is a conjunction.** `capabilities: ['payments.faircoin.accepted',
  'commerce.mercaria.store']` returns places that have *both*, not either.
- **The key space is a closed, typed registry.** `CAPABILITY_KEYS` lists every
  key (`payments.faircoin.accepted`, `commerce.mercaria.store`,
  `mobility.moovo.pickup`, `housing.homiio.listings`,
  `social.mention.location`, and the accessibility, payment, amenity, food,
  price, social and brand keys), and each declares the kind of value it holds.
  A new key is a GoWay release — see `docs/PLACE_DATA.md`.
- **A filter can ask for a value.** An enum, enum-set, price or text key
  filters by value as well: `'food.cuisine:italian'`,
  `'accessibility.wheelchair:limited'`, `'commerce.mercaria.store:<locationId>'`.
  The value is matched against the STRONGEST assertion, like the bare key — a
  community report naming a location does not match when the business's own
  assertion names another — and a text value matches exactly, after the key's
  own normalization, and may not contain a comma (a filter list is
  comma-joined).
- **An unknown or malformed key is rejected before the request leaves.**
  `capabilities: ['faircoin']`, `['Payments.FairCoin.Accepted']` or an
  unregistered key throws `GoWayValidationError` client-side (`status: null`,
  nothing sent): it would match nothing, and it is far more likely a typo than an
  intent.
- **Nothing about the capability table leaks into the call.** No join, no table
  name, no internal id. The filter is served by an indexed pass GoWay owns, and
  the shape of that index is free to change.

The same `capabilities` option is available on `places.inBounds` (the viewport
read) and on `search.query`, where it filters the candidates that reconcile to a
GoWay place, by the same strongest-assertion rule.

### Narrowing by category

`categories` combines with `capabilities` — "cafés that take FairCoin":

```ts
const { items: cafes } = await goway.places.nearby({
  latitude: center.latitude,
  longitude: center.longitude,
  radiusMeters: 2_000,
  capabilities: ['payments.faircoin.accepted'],
  categories: ['food.cafe'],
});
```

Unlike `capabilities`, a `categories` list is a **disjunction**: a place
carrying *any* listed key matches. `Place.categories` holds keys of GoWay's
category taxonomy, which GoWay's moderators keep in its database: dotted keys
such as `food.cafe`, `shop.books` or `transport.rail_station`, most specific
first, each under a root that is a browsing group (`food`, `shop`, `lodging`,
`leisure`, `culture`, `transport`, …). Fetch the taxonomy with
`categories.list({ locale })` and index it with `categoryTaxonomy` (cache it;
it changes rarely). A filter on a root asks for everything below it, so
`categories: ['food']` is every restaurant, café and bar without enumerating
them. A key that is not a category is refused by the API (`validation_failed`).
Label one with `taxonomy.label(key, locale)`; a key newer than the list you
hold still arrives as a key, so give it a generic pin
rather than dropping the place. The design is in `docs/PLACE_DATA.md`.

## Read the evidence, and say only what it supports

This is the part a wallet gets wrong by default, and it is an explicit
acceptance criterion: *anonymous/community assertions cannot masquerade as
verified acceptance.*

Every claim carries `verification` and `observedAt`. The four tiers, weakest to
strongest (`CAPABILITY_VERIFICATIONS`):

| `verification` | Who said it | What a wallet may say |
| --- | --- | --- |
| `community_reported` | Any signed-in Oxy account, unreviewed | "Reported by the community" |
| `external_source` | An outside dataset the claim names | "From an external source" |
| `business_asserted` | An account holding an **approved claim** on the place | "Stated by the business" |
| `oxy_verified` | An Oxy/FairCoin verification act | "Verified by Oxy" |

A place may carry **several rows for the same key** at different tiers, and all
of them are published: `(place, namespace, capability, verification)` is the
uniqueness key, so a fresh community report never overwrites — or silently
demotes — an Oxy-verified fact, and an Oxy verification never erases the
community history that justified checking. Never assume there is only one.

The one that decides is the **strongest**: highest tier, then the freshest
within a tier. The SDK publishes that rule rather than leaving every wallet to
re-derive it — `strongestCapability(place, key)` returns the deciding assertion,
`capabilityHolds(key, value)` says whether a value counts (anything but `false`,
`0`, `''` or `[]`, nor a value the key names as an absence), and
`placeHasCapability(place, key)` is the two together. They are
the same rule the server's `capabilities` filter applies, so a badge and a
filter cannot disagree about one place.

Choose the strongest **before** looking at the value. Filtering out `false`
rows first and then ranking what is left is the tempting reducer and the wrong
one: it lets a community report of `true` win over the business saying `false`,
which is exactly the merchant who stopped accepting FairCoin.

Then turn that one assertion into something you are willing to put on screen:

```ts
import {
  capabilityHolds,
  strongestCapability,
  type CapabilityVerification,
  type Place,
} from '@goway.to/sdk';

const FAIRCOIN = 'payments.faircoin.accepted';
/** Past a year, a claim is historic rather than current. */
const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

const EVIDENCE: Record<CapabilityVerification, string> = {
  community_reported: 'Reported by the community',
  external_source: 'From an external source',
  business_asserted: 'Stated by the business',
  oxy_verified: 'Verified by Oxy',
};

export interface Acceptance {
  /** What the wallet may say as the headline. `none`: show no badge at all. */
  headline: 'accepts' | 'reported' | 'none';
  /** Who said so. Always rendered as TEXT, never as colour alone. */
  evidence: string | null;
  observedAt: string | null;
  /** `true` when the claim is too old to present as current. */
  stale: boolean;
}

export function faircoinAcceptance(place: Place, now: number = Date.now()): Acceptance {
  // The deciding assertion: strongest tier, then freshest — the server's rule.
  const claim = strongestCapability(place, FAIRCOIN);
  // Nobody has said so, or the strongest voice says it stopped.
  if (!claim || !capabilityHolds(FAIRCOIN, claim.value)) {
    return { headline: 'none', evidence: null, observedAt: null, stale: false };
  }

  const observed = Date.parse(claim.observedAt);
  const stale = Number.isNaN(observed) || now - observed > STALE_AFTER_MS;
  const firm = claim.verification === 'oxy_verified' || claim.verification === 'business_asserted';

  return {
    headline: firm && !stale ? 'accepts' : 'reported',
    evidence: EVIDENCE[claim.verification],
    observedAt: claim.observedAt,
    stale,
  };
}
```

The rules that function encodes, all of which you should keep however you write
it yourself:

- **A stale claim is demoted whatever its tier.** An Oxy verification from two
  years ago is evidence about the past. Presenting it as a current guarantee is
  the single failure the whole provenance contract exists to prevent.
- **Freshness is shown, not implied.** "Checked 3 days ago" and "last checked
  over 2 years ago" are different facts to someone deciding whether to walk
  there. Keep the phrasing coarse — `observedAt` does not carry the precision a
  timestamp implies.
- **Provenance is text, never colour alone.** A green pill is not a sentence,
  and it is invisible to a screen reader and to a colour-blind user. Name *who*
  said it: "Verified" on its own is exactly the word that lets a community
  report pass for an audited fact.
- **A strongest assertion that does not hold is not a badge.** Drop it. "Does
  not accept FairCoin" is not a feature, and a row of crossed-out pills is noise
  on every place nobody has asked about. A *weaker* `false` under a stronger
  `true` changes nothing: the strongest assertion decides.
- **An unknown key is shown by its key, not dropped.** A wallet that renders
  only the capabilities it was compiled against will silently hide the next
  product's.
- Never tell the user a payment *will* be accepted. The strongest thing GoWay
  knows is who said it and when; the merchant's till is not in scope
  (OxyHQ/GoWay#8 → Non-goals).

GoWay's own app implements the presentation half of these rules — provenance
text, coarse freshness, stale demotion — in
`packages/frontend/lib/goway/capabilities.ts` (`presentCapability`), and it is
worth reading before writing your own. For *which* assertion to present, use the
SDK helpers above rather than a reducer of your own.

## Render the merchants

**A caveat first, because it changes what you can do today.** `@goway.to/sdk`
ships the data client, not the renderer: map primitives are **not part of the
package yet**. GoWay's map seam lives in `packages/frontend/components/map` and
is provider-neutral by construction — nothing in it mentions MapLibre and
nothing that imports it may. Until those primitives are published, a consumer
has three honest options:

1. **Inside the Oxy Expo/Bloom ecosystem**, reuse the seam itself
   (`MapCanvas`, `MapApi`, `MapMarker`, `MapViewport`, `DefaultMapMarker`). Do
   **not** pull in GoWay's navigation shell, its explore screen or its sheet
   layout: importing the app to get the map is how a wallet inherits a back
   stack, a search box and a route group it does not want. Compose the canvas
   yourself; it is one component. (`@/components/map` below is GoWay's own path
   alias — from another repo it is wherever you vendor the seam to. The props
   and the types are the part that matters.)
2. **Outside it**, feed `Place.location` to whatever renderer your app already
   has. The contract you keep is GoWay's coordinate spelling — `{ latitude,
   longitude }` objects, never positional pairs. Most engines take
   `[longitude, latitude]` arrays, and a transposed pair is a plausible point in
   the wrong hemisphere rather than an error, so convert in exactly one place.
3. **Hand off entirely** with `links.map()` / `links.place()` and let
   `goway.to` render. Zero integration, no marker code, no permission prompt.

Option 1, end to end:

```tsx
import { useCallback, useMemo, useState } from 'react';
import { placeDisplayName, type Place, type PlaceWithDistance } from '@goway.to/sdk';

import { DefaultMapMarker, MapCanvas, type MapMarker, type MapViewport } from '@/components/map';

function toMarkers(merchants: readonly Place[], selectedId: string | null): MapMarker[] {
  return merchants.map((merchant) => {
    // The client's `locale` resolved server-side, falling back to the default name.
    const name = placeDisplayName(merchant);
    return {
      id: merchant.id,
      coordinate: merchant.location,
      kind: 'payments.faircoin.accepted',
      label: name,
      selected: merchant.id === selectedId,
      accessibilityLabel: `${name} — accepts FairCoin`,
    };
  });
}

export function MerchantMap({
  viewport,
  merchants,
}: {
  viewport: MapViewport;
  /** `page.items` from `places.nearby`. */
  merchants: readonly PlaceWithDistance[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const markers = useMemo(() => toMarkers(merchants, selectedId), [merchants, selectedId]);

  const renderMarker = useCallback(
    (marker: MapMarker) => <DefaultMapMarker marker={marker} onPress={() => setSelectedId(marker.id)} />,
    [],
  );

  return (
    <MapCanvas
      initialViewport={viewport}
      markers={markers}
      renderMarker={renderMarker}
      onMarkerPress={(marker) => setSelectedId(marker.id)}
      // Never `true` speculatively: the canvas draws the dot only when
      // permission is already GRANTED, and asking is a user-initiated act.
      showUserLocation={false}
      style={{ flex: 1 }}
    />
  );
}
```

Notes that save debugging time:

- `marker.id` should be the **GoWay Place ID**. That is what a press hands back,
  what you fetch details with, and what the deep link is built from.
- `kind` is an open string the renderer does not interpret; it is handed back to
  `renderMarker`. Using the capability key makes "this is a FairCoin merchant"
  the marker's own vocabulary.
- `renderMarker` is optional. Omit it for Bloom's default pill and cluster
  bubble; `DefaultMapMarker` is that default made explicit, and it is the same
  component on web, iOS and Android.
- Give every marker an `accessibilityLabel` that names the capability. A screen
  reader then gets the fact in words before it ever reaches the badge.
- The camera is uncontrolled after the first render: move it through the
  `MapApi` ref (`moveTo`, `fitCoordinates`), not by re-rendering with a new
  viewport prop.
- At city zoom a few hundred merchants is not information. GoWay clusters in
  screen space and caps the marker count
  (`packages/frontend/lib/goway/markers.ts`) rather than drawing everything.

## Selection, detail and directions

A press gives you a place id. Fetch the full record when you need more than the
list carried, and offer directions from a point the user supplied:

```ts
const merchant = await goway.places.get(placeId);
```

A single-place read also carries `names`, every language GoWay holds one in; the
list reads carry only `localizedName`. Render either with `placeDisplayName`,
never `place.name` alone, or the locale you asked for is silently ignored.

Holding several ids — the merchants a user saved, the places your records point
at — read them in one request instead of one each:

```ts
const { items, gone, missing } = await goway.places.getMany(savedPlaceIds); // at most 50
```

`items` are exactly what `places.get` answers for each; `gone` is every id `get`
would reject with `GoWayGoneError`, as `{ id, mergedInto? }`; `missing` every id
it would reject with `GoWayNotFoundError`. All three come back in the order you
named the ids, and every id is in exactly one of them.

```ts
import { GoWayNoRouteError, GoWayUnsupportedModeError } from '@goway.to/sdk';

try {
  const { routes } = await goway.routes.directions({
    origin: { coordinate: origin },
    // A place id, not a coordinate: GoWay resolves the routable point.
    destination: { placeId: merchant.id, name: merchant.name },
    mode: 'walk',
  });
  const [best] = routes;
  if (!best) return show('No walking route found');
  show(`${Math.round(best.distanceMeters)} m`);
} catch (error) {
  if (error instanceof GoWayNoRouteError) return show('No walking route found');
  if (error instanceof GoWayUnsupportedModeError) return show('Try another travel mode');
  throw error;
}
```

Passing `placeId` rather than a coordinate lets GoWay aim at the *reachable*
point: a building centroid is not necessarily on a walkable network, and which
entrance a router should use is GoWay's knowledge, not the wallet's. "No route"
is a normal domain answer that arrives either as an empty `routes` array or as
`GoWayNoRouteError` — handle both, and render neither as a failure.

For a straight-line "230 m away" in a list, use `distanceMeters` from
`places.nearby`; it needs no routing call.

## Open the canonical GoWay link

```ts
goway.links.place(merchant);        // https://goway.to/place/gw_place_01H8
goway.links.place('gw_place_01H8'); // the id alone works too
goway.links.map({ latitude: 41.3874, longitude: 2.1686, zoom: 15 });
```

`https://goway.to/place/<placeId>` is the canonical, stable deep link.

- It is built from the **GoWay Place ID and never from a provider id.** An OSM
  node can be renumbered, deleted or replaced without GoWay losing the identity
  of the real place, and a GoWay-created merchant has an ID before it matches
  anything external. A link built from an OSM id is a link that breaks silently.
- **Persist the place ID; rebuild the link.** A link is presentation. Storing
  the URL freezes today's origin into your database.
- `links.place` accepts a `Place`, a `SearchResult`-shaped `{ placeId }`, or the
  bare id, and percent-encodes the segment for you. Do not concatenate the URL
  by hand.

## Errors worth handling

Every failure is one class from one hierarchy, carrying `code`, `status`,
`retryable`, `details` and `toJSON()`. Branch on the class or the `code`, never
on `message`. The full table is in the
[SDK README](../../packages/sdk/README.md#errors); the ones a discovery screen
actually meets:

```ts
import { GoWayRateLimitError, isGoWayError, type GeoCoordinate, type PlaceWithDistance } from '@goway.to/sdk';

export async function merchantsOrNothing(center: GeoCoordinate): Promise<PlaceWithDistance[]> {
  try {
    return (await nearbyMerchants(center)).items;
  } catch (error) {
    if (error instanceof GoWayRateLimitError) {
      show(`Too many requests; retry in ${error.retryAfterSeconds ?? 5}s`);
      return [];
    }
    if (isGoWayError(error) && error.retryable) return [];   // network, timeout, provider down
    throw error;
  }
}
```

A persisted place id is the one piece of GoWay state a wallet keeps, so know
exactly which answers retire it:

```ts
import { GoWayGoneError, GoWayNotFoundError, type Place } from '@goway.to/sdk';

export async function savedMerchant(placeId: string): Promise<Place | null> {
  try {
    return await goway.places.get(placeId);
  } catch (error) {
    // 410: GoWay withdrew the place. 404: it never existed. Either way the id is dead.
    if (error instanceof GoWayGoneError || error instanceof GoWayNotFoundError) {
      forgetPlaceId(placeId);
      return null;
    }
    throw error;
  }
}
```

- `GoWayValidationError` with `status: null` means the SDK refused the request
  before sending it — a malformed capability key, a latitude out of range, a
  `limit` above the contract maximum, an unknown query key. Its message names
  the field (`query.latitude: …`) and never quotes the value, which may be a
  user's location. It is a bug in your call, not a server condition.
- `GoWayGoneError` (`gone`, 410) means the place is retired: moderation removed
  it, or merged it into another place. Either way it is absent from every list
  and answers `410` by id. When `error.mergedInto` is set, replace the persisted
  id with it; when it is `null`, the place was removed, and with
  `GoWayNotFoundError` that is the signal that justifies dropping the id.
- `GoWayUnknownRouteError` (`unknown_route`, 404) is **not** a missing place:
  the API has no such route — the SDK is newer than the deployment, or
  `apiBaseUrl` points somewhere else. Never drop a saved id on the strength of
  it.
- `GoWayForbiddenError` (403) on a write means the place is claimed and the
  caller does not act for an approved claim on it (a `PATCH`), or the caller may
  not withdraw that assertion (a capability `DELETE`).
- `GoWayUnavailableError` (`provider_unavailable`, or `service_unavailable` when
  Oxy could not confirm who belongs to the claiming organization) is retryable;
  the SDK never retries by itself, so the backoff policy stays yours.
- Cancel in-flight discovery when the user moves on:
  `goway.places.nearby(query, { signal: controller.signal })` rejects with
  `GoWayAbortError`.
- Zero results and a degraded upstream are different answers. `search.query`
  reports `degradedProviders` precisely so "nothing matched" and "a source was
  down" do not render identically.

## How a merchant comes to be marked as accepting FairCoin

Discovery is only as good as the write path, and the write path is **API and
authorization based**. A wallet never touches the database, and no client can
label its own assertion as verified.

### The three authoritative paths

1. **Verified business self-assertion.** Somebody who acts for an **approved
   claim** on the place (`PlaceClaim`, roles `owner` / `operator` / `manager` /
   `brand`) asserts the capability: the claiming Oxy account itself, a session
   switched into that organization, or a member Oxy reports as its `owner`,
   `admin` or `editor`. The server records it as `business_asserted`.
2. **Oxy/FairCoin verification.** A GoWay operator records `oxy_verified`
   through the moderation surface. No client can ask for this tier; the routes
   that write it refuse everybody off GoWay's operator allow-list.
3. **Community reports pending verification.** Any signed-in Oxy account can
   report acceptance. It is recorded as `community_reported` and it stays that
   way until something stronger arrives. It does not overwrite or demote a
   stronger claim, and it is not presented as current acceptance.

An assertion that names an outside dataset in `source` is recorded as
`external_source` regardless of who sent it — the dataset is the authority, not
the messenger.

### Becoming the business: claims

A business is an **Oxy organization**, and it earns path 1 by claiming the
place in the organization's name. GoWay keeps no member list: it asks Oxy, with
the caller's own session, who may act for the organization. Filing a claim for
it needs the caller to be its `owner` or `admin`; running the claimed place —
editing it, asserting at the business tier, reading its claims — is open to its
`owner`, `admin` and `editor`, and to any session switched into the
organization. A chain is one organization claiming each location in the
`brand` role. All three claim calls need a signed-in session:

```ts
import { GoWayConflictError, iterateGoWayPages } from '@goway.to/sdk';

// Ask to be recognised as running the place. Always created `pending`:
// `state` is not a field the caller can send.
try {
  const claim = await goway.places.claims.create(placeId, { role: 'owner', oxyAccountId: organizationId });
  show(`Claim ${claim.id} is ${claim.state}`);
} catch (error) {
  // 409: the organization already holds a claim in that role on this place.
  // 403: Oxy says you do not own or administer that organization.
  if (error instanceof GoWayConflictError) return show('Your claim is already on file');
  throw error;
}

// Follow it: every claim the organization holds, on every place, in every state.
const byOrganization = (cursor?: string) => goway.claims.list({ oxyAccountId: organizationId, cursor });
for await (const claim of iterateGoWayPages(byOrganization)) {
  if (claim.state === 'approved') show(`You can now speak for ${claim.placeId}`);
}

// The claims on one place — visible only to somebody who acts for an account
// holding one there, pending included. Anyone else gets GoWayForbiddenError
// rather than an empty list.
const { items: competing } = await goway.places.claims.list(placeId);
```

There is **no public approve or reject call**. A GoWay operator decides every
claim through the moderation surface, and nothing a client sends can move a
claim out of `pending`. Until it is approved, the claimant is a community
reporter like everyone else — their assertions land as `community_reported`,
and their UI must say so. Approval then makes the claimant's own pending
statements `business_asserted` (the exact rule is under
[the Mercaria integration](#claiming-and-what-happens-to-what-was-said-while-pending)).
Every write a business makes is recorded in the
place's history (`goway.places.revisions`), which publishes what changed and
when and never who. The design is in
[`BUSINESS_OWNERSHIP.md`](../BUSINESS_OWNERSHIP.md).

### What a client actually writes

A capability is written one key at a time, and the caller never chooses the
tier:

```ts
// Assert or refresh. Recorded as business_asserted for an approved claimant,
// community_reported for anyone else. Resolves with the whole Place, so you see
// the evidence your write now sits beside.
const updated = await goway.places.capabilities.put(placeId, 'payments.faircoin.accepted', { value: true });

// "They stopped taking it." A reporter retracts by asserting false, which is
// better evidence than a deletion: an absent row only means nobody has said.
await goway.places.capabilities.put(placeId, 'payments.faircoin.accepted', { value: false });

// An approved claimant may withdraw the business's own assertion — that tier
// only. Resolves with nothing (204).
await goway.places.capabilities.delete(placeId, 'payments.faircoin.accepted');
```

`value` is required rather than defaulted to `true`: the same endpoint writes
valued capabilities, where a default would silently mean the wrong thing.

```ts
// A merchant GoWay has never heard of. Created unverified, with
// community_reported capabilities.
const created = await goway.places.create({
  name: 'Cafè de la Plaça',
  location: { latitude: 41.3874, longitude: 2.1686 },
  categories: ['food.cafe'],
  capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
});
```

`places.update` accepts the same `capabilities` array alongside the place's other
fields, under the stricter `PATCH` rule below.

### The rules the server enforces

- **Writes require a verified Oxy session.** A contribution without an identity
  cannot be reviewed, attributed or reverted. Reads stay public.
- **The client never sends `verification` or `observedAt`.** Neither the
  capability input nor the assertion body has such fields; the SDK parses every
  body with the contract schema and sends only what it names, so an invented
  field never leaves the client. The server derives the tier from the caller's
  approved claims and the instant from its own clock. That is the mechanism —
  not a convention — that stops a community report from arriving labelled
  `oxy_verified`.
- **An unclaimed place is community-editable; a claimed place is not.** Once an
  approved claim exists, only somebody acting for one may `PATCH` it; everyone
  else gets `403` (`GoWayForbiddenError`) rather than a silent no-op.
- **A capability assertion stays open on a claimed place.** A passer-by's
  `community_reported` row lands *beside* the business's `business_asserted`
  one, outranked by it, and neither can overwrite the other — so a customer who
  sees a FairCoin sticker in a claimed shop can still say so.
- **Only an approved claimant may withdraw, and only their own tier.** A
  capability `DELETE` from anyone else is `403`; one with no business-asserted
  row to remove is `404`. `oxy_verified` has no public path in or out; only
  GoWay's moderation surface writes or withdraws it.
- **A new place's capabilities are `community_reported`, whatever the body
  says.** A place that did not exist a moment ago can carry no approved claim,
  so its creator is a community reporter by construction. Claiming it is a
  separate, reviewed act.
- **A claim is always `pending` when created**, and a second claim by the same
  account in the same role is `409`.
- **A removed or merged place takes no writes.** Every write to it answers
  `410`, as a read does; a merged one's carries `mergedInto`, the id to use
  instead.
- **Nothing is destroyed by omission.** Rows are keyed by tier, so the history
  of who said what, when, survives. An update is a merge patch: it touches only
  the fields — and the `address` and `contact` parts — you pass, because GoWay
  layers enrichment *over* source data. Clearing is explicit: `null` clears a
  field that may be empty (`contact: { phone: null }`), and the revision records
  what it held. A value cleared that OpenStreetMap supplied stays cleared on the
  next import until OpenStreetMap's own value changes.

In wallet UX terms: a "Report that this shop takes FairCoin" affordance is
welcome; wording it as "Mark as verified" is not. The user's own report comes
back as `community_reported` on the next read, and your UI must show it as
exactly that — including to the person who submitted it.

## The Mercaria integration: a store and its place

Mercaria is the first consumer to use this surface end to end, and its shape
is the one any product that lets a business attach its own records to a GoWay
place should copy (Mercaria ADR 0013, "place facts live in GoWay").

### A bidirectional link

A Mercaria **location** (a shop a store sells or hands orders over from) and a
GoWay **place** (the shop on the map) point at each other:

1. the location stores the **GoWay Place ID** (`goWayPlaceId`) — an opaque id,
   no foreign key, and nothing else about the place: name, address, position,
   timezone, weekly hours, exceptions, contact and accessibility are read from
   GoWay every time;
2. the place asserts **`commerce.mercaria.store` = the location id** — a `text`
   capability, written by the merchant's dashboard with the merchant's own Oxy
   session.

Either half alone proves nothing. A location can name any place; anybody
signed in can report `commerce.mercaria.store` on any place. What makes the
pair trustworthy is the TIER of the second half.

### The trust tiers

| Strongest `commerce.mercaria.store` | Who could have written it | Mercaria trades from the place? |
| --- | --- | --- |
| `oxy_verified` | A GoWay operator | Yes |
| `business_asserted` | Whoever acts for an APPROVED claim on the place — the store's Oxy organization, a session switched into it, or its `owner`/`admin`/`editor` | Yes |
| `external_source`, `community_reported` | Anybody, or an imported dataset | No: `store_link_unverified` |

The claim is filed for the store's owning Oxy account, so a business-tier
back-reference proves that whoever controls the place controls the store. The
rule is read off the place on every read (`strongestCapability(place,
'commerce.mercaria.store')`), never stored, so a revoked claim or a withdrawn
assertion unlinks the location at the next read. A merged place answers `410`
with `mergedInto`, and Mercaria's verify act follows it and rewrites the
stored id.

### Claiming, and what happens to what was said while pending

The dashboard files the claim in the organization's name (filing needs `owner`
or `admin` in it) and then reads the organization's claim on that one place:

```ts
await goway.places.claims.create(placeId, { role: 'owner', oxyAccountId: store.oxyAccountId });
const { items } = await goway.claims.list({ oxyAccountId: store.oxyAccountId, placeId });
```

A pending claim is not ownership: while it waits, the merchant's store link,
accessibility flags and holiday closures are recorded at `community_reported`.
When an operator APPROVES the claim, those statements become the business's
own in the same transaction — every `community_reported` capability or hours
exception whose latest statement was made after the claim was filed, by the
claimant organization (its own or a switched session) or by the person who
filed the claim, is re-tiered to `business_asserted`, unless the business tier
already holds that key or those dates. Each re-tier is a public
`capability_retiered` / `hours_exception_retiered` revision attributed,
privately, to whoever made the statement. A member other than the filer who
asserted as themselves is NOT re-tiered — GoWay cannot ask Oxy about somebody
else's role with an operator's session — and re-asserts after approval; the
dashboard re-checks the link with a fresh read either way.

### Reading many places at once

Mercaria holds a place id per location and reads them in bulk — a store's
locations for its dashboard, the candidates of a nearby search, a checkout's
collection points. That is `places.getMany`, at most `MAX_PLACE_BATCH_SIZE`
(50) ids a request:

```ts
const { items, gone, missing } = await goway.places.getMany(placeIds, { locale });
// items: full places — hours exceptions included, for open-now
// gone: [{ id, mergedInto? }] — removed, or merged (follow it on verify)
// missing: ids no place has ever had
```

Each place in `items` is exactly what `places.get` answers, so the cache entry
for one id is the same whichever read produced it.

### Finding the stores near a shopper

The nearby read filters on the key and returns every place that HAS a store
link, nearest first. Each carries its current `hoursExceptions`, so
`openingStatusAt(place)` answers open-now per candidate without a second read,
and the tier rule above is applied to the list it already has:

```ts
const page = await goway.places.nearby({
  latitude, longitude, radiusMeters,
  capabilities: ['commerce.mercaria.store'],
});
```

To ask about ONE location — "which place names this location, and how
strongly?" — filter on the value. A text key filters by exact value through the
strongest assertion, so a community report naming the location never matches a
place whose business names another:

```ts
const { items } = await goway.places.inBounds({ ...box, capabilities: [`commerce.mercaria.store:${locationId}`] });
```

### GoWay renders the shelf

The link is also read the other way: GoWay's own place sheet shows what a
Mercaria shop trading from the place has in stock, through Mercaria's public
SDK, exactly as any other consumer of Mercaria would. GoWay stores none of it.

```ts
// packages/frontend/lib/mercaria — GoWay's adapter; feature code never imports @mercaria.co/sdk
const { items } = await mercaria.locations.list({ goWayPlaceId: place.id });
for (const location of items) {
  const page = await mercaria.locations.products(location.ref, { inStock: true, limit: 12 });
  // location.store.name / .logoUrl, location.url (the store page on mercaria.co, opened on this shop front)
  // page.items[i]: { product, availability, exactQuantity?, stockConfirmedAt }
}
```

- **The capability asks; Mercaria answers.** The sheet asks Mercaria only when
  the place carries `commerce.mercaria.store`, and renders only what Mercaria
  returns. Mercaria applies the [trust tiers](#the-trust-tiers) on every read,
  so a community report draws nothing, and GoWay does not restate the rule.
- **A list, not a location.** Mercaria's place list is a page; a market or a
  mall can hold several shop fronts, and each renders as its own store with its
  own strip, dropping out alone if its read fails.
- **What a tile says.** Image, title and the price in the listing's own
  currency (FAIR at its eight decimals), the availability AT THIS LOCATION as
  words — in stock, low stock, out of stock — with `exactQuantity` only where
  the merchant discloses it, and "stock confirmed … ago" from
  `stockConfirmedAt`. Each tile, and "See all at <store>", opens mercaria.co.
- **Words.** Every string the section shows is a message in
  `packages/frontend/lib/messages/products.ts` (`en`, `es`), read through
  `useTranslation`, whose table is picked by `matchLanguageTag` on the whole
  locale. Store names and product titles are Mercaria's, asked for in the
  reader's locale (the client's `locale` is `deviceLocale()`).
- **Errors.** An empty page, `MercariaGoneError` and `MercariaNotFoundError`
  hide the store; `MercariaUnavailableError` — usually Mercaria unable to ask
  GoWay — and an offline read show a quiet "Try again" instead, because they
  say nothing about the store.
- **Anonymous.** Every read works signed out, and the sheet sends no Oxy token
  to Mercaria.
- **Configuration.** `EXPO_PUBLIC_MERCARIA_API_URL`, defaulting to the SDK's
  own `https://api.mercaria.co`. Under `EXPO_PUBLIC_GOWAY_FIXTURES` the client
  is served by `lib/mercaria/mockTransport.ts` through the real SDK, and
  `EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS=mercaria` exercises the retry.

### Editing the place, and clearing a field

The merchant edits the place's facts in GoWay, never in Mercaria. A `PATCH` is
a merge patch: the contact form sends the parts that changed and `null` for a
part the merchant emptied — `{ contact: { phone: null } }` clears the phone and
keeps the email and website. Mercaria's backend only ever reads; every write is
the merchant's dashboard, with the merchant's session, against GoWay's own
authorization.

## Generalizing to other products

The reason none of this is a FairCoin feature: the only FairCoin-specific thing
in the whole integration is a string.

| Product | Capability key | Same guide, changed how |
| --- | --- | --- |
| FairCoin wallet | `payments.faircoin.accepted` | — |
| Mercaria | `commerce.mercaria.store` | a text value — the location id — read through the [bidirectional link](#the-mercaria-integration-a-store-and-its-place) |
| Moovo | `mobility.moovo.pickup` | marker label, evidence copy |
| Homiio | `housing.homiio.listings` | marker label, evidence copy |
| Mention | `social.mention.location` | marker label, evidence copy |
| Yours | `<domain>.<product>.<capability>` | nothing else; no GoWay release needed |

```ts
// The identical call, one product over.
const { items: pickupPoints } = await goway.places.nearby({
  latitude: center.latitude,
  longitude: center.longitude,
  radiusMeters: 1_000,
  capabilities: ['mobility.moovo.pickup'],
});
```

If you find yourself wanting a product-specific endpoint, a product-specific
table or a product-specific marker type, the design has drifted: capabilities
are rows in one open key space precisely so a new Oxy product adds neither
columns, nor tables, nor a schema fork.

## Reference

- [`packages/sdk/README.md`](../../packages/sdk/README.md) — the full client
  surface, options, namespaces and the error table;
  [`CHANGELOG.md`](../../packages/sdk/CHANGELOG.md) for what changed in `0.3.0`.
- `packages/contracts/src/place.ts` — `Place`, `PlaceCapability`,
  `NearbyPlacesQuery`, `PlaceClaim`, and the helpers `strongestCapability`,
  `placeHasCapability`, `placeMatchesCapabilityFilter` and `placeDisplayName`;
  `packages/contracts/src/capability-registry.ts` — `CAPABILITY_KEYS`,
  `CapabilityVerification` and every key's value type;
  `packages/contracts/src/category.ts` — the category taxonomy.
- `packages/contracts/src/pagination.ts` — pages and cursors;
  `packages/contracts/src/errors.ts` — every error code, its status and whether
  it is retryable; `packages/contracts/src/operations.ts` — the route registry.
- `https://api.goway.to/api/v1/openapi.json` (committed as
  `packages/contracts/openapi.json`) — the same contract, for a non-TypeScript
  client.
- `docs/PLACE_DATA.md` — the taxonomy, the capability registry and hours;
  `packages/frontend/lib/goway/categories.ts` — how GoWay's app draws them.
- `packages/frontend/components/map/` — the provider-neutral map seam
  (`MapCanvas`, `MapApi`, `MapMarker`, `MapViewport`, `DefaultMapMarker`).
- `packages/frontend/lib/goway/capabilities.ts` — the evidence-presentation
  rules above, implemented.
- [`docs/SDK_VISION.md`](../SDK_VISION.md) — what the SDK is for, and who it is
  for.
- OxyHQ/GoWay#8 — this integration, including the capability write path.
