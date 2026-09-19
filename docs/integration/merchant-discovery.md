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
  renderer and, in fact, no runtime dependency at all.
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
documentation, so, as of this writing:

| Piece | State |
| --- | --- |
| `@goway.to/sdk` client, types, errors, links | Built (`packages/sdk`, OxyHQ/GoWay#3). Version `0.1.0` is **unreleased** — not on npm yet. |
| `GET /places/nearby`, `/places/bounds`, `/places/:id` | Built (`packages/backend`, OxyHQ/GoWay#24). |
| `POST /places`, `PATCH /places/:id` with server-derived verification | Built (OxyHQ/GoWay#24); the capability write path is being extended under OxyHQ/GoWay#8. |
| Search, geocoding, directions | Built (OxyHQ/GoWay#25, OxyHQ/GoWay#26). |
| A deployed public API at `https://api.goway.to` | **Not yet.** GoWay's own app runs against a fixture transport injected into the real client (`EXPO_PUBLIC_GOWAY_FIXTURES`), so every request still goes through real serialization, parsing and error classification. |
| Map rendering primitives inside the SDK | **Not yet.** The SDK is headless; the map seam lives in `packages/frontend/components/map`. See [Render the merchants](#render-the-merchants). |
| Place claims (`PlaceClaim`) | The contract exists and an approved claim already governs who may edit a place. There is **no public claim-submission or moderation endpoint** yet. |
| `oxy_verified` capabilities | Represented in the contract and readable; setting one is an Oxy moderation act with no client-facing endpoint. |

Build against the contracts anyway: they are what the fixtures, the backend and
the SDK all already agree on.

## Install

```bash
bun add @goway.to/sdk    # npm i @goway.to/sdk
```

Until `0.1.0` is published, consumers inside the Oxy workspace depend on the
built package from this repo. Either way the import is the same, and it is the
only GoWay package you ever import: the domain types are re-exported from it, so
you never reach into a private GoWay package and never keep your own copy of
`Place`.

## Create one client

```ts
import { createGoWayClient } from '@goway.to/sdk';

// Anonymous: the map, Places, search and routing all work signed out.
const goway = createGoWayClient();
```

Discovery needs no account. Supply a token only for the identity-bound calls —
creating a place, asserting a capability:

```ts
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
const merchants = await goway.places.inBounds({
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
const merchants = await goway.places.nearby({
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
import type { GeoCoordinate, PlaceWithDistance } from '@goway.to/sdk';

export async function nearbyMerchants(center: GeoCoordinate): Promise<PlaceWithDistance[]> {
  return goway.places.nearby({
    latitude: center.latitude,
    longitude: center.longitude,
    radiusMeters: 2_000,
    capabilities: ['payments.faircoin.accepted'],
    limit: 50,
  });
}
```

Results come back nearest first, each one a `PlaceWithDistance` — a full `Place`
plus `distanceMeters` from the query point, computed server-side so every client
agrees on the number.

What the filter means, precisely:

- **The key grammar is `<domain>.<product>.<capability>`** — `namespace` +
  `capability`, joined with a dot. `payments.faircoin` + `accepted` gives
  `payments.faircoin.accepted`.
- **A list is a conjunction.** `capabilities: ['payments.faircoin.accepted',
  'commerce.mercaria.store']` returns places asserting *both*, not either.
- **The namespace is open.** `WELL_KNOWN_CAPABILITIES` is exported and
  autocompletes (`payments.faircoin.accepted`, `commerce.mercaria.store`,
  `mobility.moovo.pickup`, `housing.homiio.listings`,
  `social.mention.location`), but any dotted key is valid and an unrecognised one
  is carried through rather than dropped. A third party can define its own
  capability without waiting for a GoWay release.
- **A bare key is rejected before the request leaves.** `capabilities:
  ['faircoin']` throws `GoWayValidationError` client-side: it would match
  nothing, and it is far more likely a typo than an intent.
- **Nothing about the capability table leaks into the call.** No join, no table
  name, no internal id. The filter is served by an indexed pass GoWay owns, and
  the shape of that index is free to change.

The same `capabilities` option is available on `places.inBounds` (the viewport
read) and on `search.query`, where it filters the candidates that reconcile to a
GoWay place.

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

A place may carry **several rows for the same key** at different tiers, and both
are published: `(place, namespace, capability, verification)` is the uniqueness
key, so a fresh community report never overwrites — or silently demotes — an
Oxy-verified fact, and an Oxy verification never erases the community history
that justified checking. Pick the strongest; never assume there is only one.

```ts
import type { CapabilityVerification, Place, PlaceCapability } from '@goway.to/sdk';

const FAIRCOIN = 'payments.faircoin.accepted';
/** Past a year, a claim is historic rather than current. */
const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

/** Strongest first, then freshest — the order the API already publishes. */
const TIER: Record<CapabilityVerification, number> = {
  oxy_verified: 0,
  business_asserted: 1,
  external_source: 2,
  community_reported: 3,
};

export function strongestClaim(place: Place, key: string): PlaceCapability | null {
  const claims = place.capabilities.filter((entry) => entry.key === key && entry.value !== false);
  if (claims.length === 0) return null;
  return claims.reduce((best, claim) => {
    const byTier = TIER[claim.verification] - TIER[best.verification];
    if (byTier !== 0) return byTier < 0 ? claim : best;
    return Date.parse(claim.observedAt) > Date.parse(best.observedAt) ? claim : best;
  });
}
```

Then turn one claim into something you are willing to put on screen:

```ts
const EVIDENCE: Record<CapabilityVerification, string> = {
  community_reported: 'Reported by the community',
  external_source: 'From an external source',
  business_asserted: 'Stated by the business',
  oxy_verified: 'Verified by Oxy',
};

export interface Acceptance {
  /** What the wallet may say as the headline. */
  headline: 'accepts' | 'reported' | 'unknown';
  /** Who said so. Always rendered as TEXT, never as colour alone. */
  evidence: string | null;
  observedAt: string | null;
  /** `true` when the claim is too old to present as current. */
  stale: boolean;
}

export function faircoinAcceptance(place: Place, now: number = Date.now()): Acceptance {
  const claim = strongestClaim(place, FAIRCOIN);
  if (!claim) return { headline: 'unknown', evidence: null, observedAt: null, stale: false };

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
- **A `false` value is not a badge.** Drop it. "Does not accept FairCoin" is not
  a feature, and a row of crossed-out pills is noise on every place nobody has
  asked about.
- **An unknown key is shown by its key, not dropped.** A wallet that renders
  only the capabilities it was compiled against will silently hide the next
  product's.
- Never tell the user a payment *will* be accepted. The strongest thing GoWay
  knows is who said it and when; the merchant's till is not in scope
  (OxyHQ/GoWay#8 → Non-goals).

GoWay's own app implements these rules in
`packages/frontend/lib/goway/capabilities.ts` (`presentCapability`,
`visibleCapabilities`, `capabilitySummary`) — the closest thing to a reference
implementation, and it is worth reading before writing your own.

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
import type { Place, PlaceWithDistance } from '@goway.to/sdk';

import { DefaultMapMarker, MapCanvas, type MapMarker, type MapViewport } from '@/components/map';

function toMarkers(merchants: readonly Place[], selectedId: string | null): MapMarker[] {
  return merchants.map((merchant) => ({
    id: merchant.id,
    coordinate: merchant.location,
    kind: 'payments.faircoin.accepted',
    label: merchant.name,
    selected: merchant.id === selectedId,
    accessibilityLabel: `${merchant.name} — accepts FairCoin`,
  }));
}

export function MerchantMap({
  viewport,
  merchants,
}: {
  viewport: MapViewport;
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

```ts
import { GoWayNoRouteError, GoWayUnsupportedModeError } from '@goway.to/sdk';

try {
  const { routes } = await goway.routes.directions({
    origin: { coordinate: origin },
    // A place id, not a coordinate: GoWay resolves the routable point.
    destination: { placeId: merchant.id, name: merchant.name },
    mode: 'walk',
  });
  if (routes.length === 0) return show('No walking route found');
  show(`${Math.round(routes[0].distanceMeters)} m`);
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
import { GoWayRateLimitError, isGoWayError } from '@goway.to/sdk';

try {
  return await nearbyMerchants(center);
} catch (error) {
  if (error instanceof GoWayRateLimitError) {
    show(`Too many requests; retry in ${error.retryAfterSeconds ?? 5}s`);
    return [];
  }
  if (isGoWayError(error) && error.retryable) return [];   // network, timeout, provider down
  throw error;
}
```

- `GoWayValidationError` with `status: null` means the SDK refused the request
  before sending it — a malformed capability key, a latitude out of range. It is
  a bug in your call, not a server condition.
- `GoWayNotFoundError` on `places.get` means the id is dead. It is the one
  signal that justifies dropping a persisted place id.
- `GoWayUnavailableError` (`provider_unavailable`) is retryable; the SDK never
  retries by itself, so the backoff policy stays yours.
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

> The capability write endpoints are being finished under OxyHQ/GoWay#8
> alongside this guide. The model and the authorization rules below are settled
> and already enforced by `POST /places` and `PATCH /places/:id`; the exact
> request shape of any *new* endpoint is not documented here rather than guessed
> at. Check the SDK's `places` namespace and OxyHQ/GoWay#8 for the current
> surface before building against it.

### The three authoritative paths

1. **Verified business self-assertion.** An Oxy account with an **approved
   claim** on the place (`PlaceClaim`, roles `owner` / `operator` / `manager` /
   `brand`) asserts the capability. The server records it as
   `business_asserted`.
2. **Oxy/FairCoin verification.** A verification act by Oxy or FairCoin records
   `oxy_verified`. No client can ask for this tier; it is a moderation
   capability, and there is no public endpoint for it today.
3. **Community reports pending verification.** Any signed-in Oxy account can
   report acceptance. It is recorded as `community_reported` and it stays that
   way until something stronger arrives. It does not overwrite or demote a
   stronger claim, and it is not presented as current acceptance.

An assertion that names an outside dataset in `source` is recorded as
`external_source` regardless of who sent it — the dataset is the authority, not
the messenger.

### The rules the server enforces

- **Writes require a verified Oxy session.** A contribution without an identity
  cannot be reviewed, attributed or reverted. Reads stay public.
- **The client never sends `verification` or `observedAt`.** `PlaceCapabilityInput`
  has no such fields, and the SDK strips them if a caller invents them. The
  server derives the tier from the caller's authorization and the instant from
  its own clock. That is the mechanism — not a convention — that stops a
  community report from arriving labelled `oxy_verified`.
- **An unclaimed place is community-editable; a claimed place is not.** Once an
  approved claim exists, only an account holding one may edit it; everyone else
  gets `403` (`GoWayForbiddenError`) rather than a silent no-op.
- **A new place's capabilities are `community_reported`, whatever the body
  says.** A place that did not exist a moment ago can carry no approved claim,
  so its creator is a community reporter by construction. Claiming it is a
  separate, reviewed act.
- **Nothing is destroyed.** Rows are keyed by tier, so the history of who said
  what, when, survives. Updates touch only the fields you pass: GoWay layers
  enrichment *over* source data and never destructively overwrites a source
  fact.

### What a client actually writes

```ts
// A report — or a business assertion, depending on the caller's claims. The
// caller does not choose; the server derives the tier from authorization.
await goway.places.update(placeId, {
  capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
});
```

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

In wallet UX terms: a "Report that this shop takes FairCoin" affordance is
welcome; wording it as "Mark as verified" is not. The user's own report comes
back as `community_reported` on the next read, and your UI must show it as
exactly that — including to the person who submitted it.

## Generalizing to other products

The reason none of this is a FairCoin feature: the only FairCoin-specific thing
in the whole integration is a string.

| Product | Capability key | Same guide, changed how |
| --- | --- | --- |
| FairCoin wallet | `payments.faircoin.accepted` | — |
| Mercaria | `commerce.mercaria.store` | marker label, evidence copy |
| Moovo | `mobility.moovo.pickup` | marker label, evidence copy |
| Homiio | `housing.homiio.listings` | marker label, evidence copy |
| Mention | `social.mention.location` | marker label, evidence copy |
| Yours | `<domain>.<product>.<capability>` | nothing else; no GoWay release needed |

```ts
// The identical call, one product over.
const pickupPoints = await goway.places.nearby({
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
  surface, options, namespaces and the error table.
- `packages/shared-types/src/place.ts` — `Place`, `PlaceCapability`,
  `CapabilityVerification`, `WELL_KNOWN_CAPABILITIES`, `NearbyPlacesQuery`.
- `packages/frontend/components/map/` — the provider-neutral map seam
  (`MapCanvas`, `MapApi`, `MapMarker`, `MapViewport`, `DefaultMapMarker`).
- `packages/frontend/lib/goway/capabilities.ts` — the evidence-presentation
  rules above, implemented.
- [`docs/SDK_VISION.md`](../SDK_VISION.md) — what the SDK is for, and who it is
  for.
- OxyHQ/GoWay#8 — this integration, including the capability write path.
