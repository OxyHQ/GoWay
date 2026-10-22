# @goway.to/sdk

The root entry point of the SDK: the HTTP client, its namespaces, the typed errors, pagination, and every contract type and value set the client reads and writes. Everything a consumer may rely on is exported from here; nothing else in the package is part of the contract.

Import from it like this: `import { createGoWayClient, GoWayNotFoundError, iterateGoWayPages, type Place } from '@goway.to/sdk';`

Other entry points: [`@goway.to/sdk/live`](./live.md), [`@goway.to/sdk/geo`](./geo.md), [`@goway.to/sdk/road-access`](./road-access.md), [`@goway.to/sdk/map`](./map.md).

On this page:

- [Client](#client)
- [Namespaces](#namespaces)
- [Errors](#errors)
- [Pagination](#pagination)
- [Functions](#functions)
- [Constants](#constants)
- [Types](#types)

Conventions used below:

- Every method takes an optional last argument, `options?: GoWayRequestOptions` (or `GoWayPlaceReadOptions` for single-place reads), to pass an `AbortSignal`. It is left out of the signatures for brevity.
- **Route** is the HTTP route below `GOWAY_API_BASE_PATH` (`/api/v1`).
- **Auth** is what the route needs: `public` reads no session, `optional` answers signed out (a session may widen what is shown), `required` needs an Oxy access token from `getAccessToken` and rejects with `GoWayUnauthorizedError` without one.
- Every method can reject with `GoWayValidationError` (input refused before sending, `status: null`, or refused by the API), `GoWayResponseError`, `GoWayNetworkError`, `GoWayTimeoutError`, `GoWayAbortError`, `GoWayRateLimitError` and `GoWayUnavailableError`. The **Errors** column lists only the answers specific to that method.

## Client

### `createGoWayClient`

Signature: `createGoWayClient(options?: GoWayClientOptions): GoWayClient`.

Creates a client. Every option is optional; with none, the client reads anonymously from `https://api.goway.to`. Throws `TypeError` at construction for an invalid option (a `fetch` or `getAccessToken` that is not a function, a `timeoutMs` that is not a positive integer, a base URL that is not an absolute `http(s)` URL without query or fragment, a `headers` entry that sets `Authorization` or `Accept`, or a `locale` that is not a language tag).

### `GoWayClientOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiBaseUrl` | `string` | `DEFAULT_GOWAY_API_BASE_URL` | The API origin. A trailing slash is removed. |
| `webBaseUrl` | `string` | `DEFAULT_GOWAY_WEB_BASE_URL` | The web origin `client.links` builds URLs on. |
| `fetch` | `GoWayFetch` | the global `fetch`, looked up per request | A `fetch` implementation. |
| `getAccessToken` | `GoWayAccessTokenGetter` | none | Returns the current Oxy access token. Called before every request; never cached. Return `null`, `undefined` or `''` for an anonymous request. |
| `locale` | `string` | none | BCP 47 tag applied to every call that accepts a `locale` and names none. Normalized once (`ES` becomes `es`). |
| `timeoutMs` | `number` | `DEFAULT_GOWAY_TIMEOUT_MS` | Per-request timeout, token acquisition and body included. |
| `headers` | `Readonly<Record<string, string>>` | none | Extra non-auth headers sent with every request. `Authorization` and `Accept` are refused. |

### `GoWayClient`

| Property | Type |
| --- | --- |
| `places` | `GoWayPlacesApi` |
| `categories` | `GoWayCategoriesApi` |
| `claims` | `GoWayClaimsApi` |
| `search` | `GoWaySearchApi` |
| `geocode` | `GoWayGeocodeApi` |
| `routes` | `GoWayRoutesApi` |
| `links` | `GoWayLinks` |
| `live` | `GoWayLiveApi` |
| `cameras` | `GoWayCamerasApi` |
| `roads` | `GoWayRoadsApi` |
| `captures` | `GoWayCapturesApi` |
| `street3d` | `GoWayStreet3dApi` |
| `organizationLists` | `GoWayOrganizationListsApi` |
| `lists` | `GoWayListsApi` |
| `transit` | `GoWayTransitApi` |
| `moderation` | `GoWayModerationApi` |

The client and every namespace object are frozen.

### Client constants

| Name | Value | Description |
| --- | --- | --- |
| `DEFAULT_GOWAY_API_BASE_URL` | `'https://api.goway.to'` | The API origin a client talks to unless told otherwise. |
| `DEFAULT_GOWAY_TIMEOUT_MS` | `15000` | How long one request may take, token acquisition and body included. |
| `DEFAULT_GOWAY_WEB_BASE_URL` | `'https://goway.to'` | The web origin links and style documents are built on. Also exported from `@goway.to/sdk/map`. |
| `GOWAY_API_BASE_PATH` | `'/api/v1'` | The path every API route hangs off. |

### Request options

| Type | Description |
| --- | --- |
| `GoWayRequestOptions` | `{ signal?: GoWayAbortSignal }`. Aborting the signal rejects the call with `GoWayAbortError`. |
| `GoWayPlaceReadOptions` | `GoWayRequestOptions` plus `locale?: string`, which overrides the client's `locale` for one single-place or batch read. |
| `GoWayAccessTokenGetter` | `() => string \| null \| undefined \| Promise<string \| null \| undefined>`. An error it throws is passed through unchanged. |

### Runtime types

The SDK compiles without the DOM library, so it describes `fetch` structurally. The global `fetch` of Node 18+, Bun, browsers and React Native satisfies these.

| Type | Description |
| --- | --- |
| `GoWayFetch` | `(url: string, init: GoWayFetchInit) => Promise<GoWayFetchResponse>`. |
| `GoWayFetchInit` | What the SDK passes to `fetch`: `method`, `headers`, `body?` (serialised JSON, never on a GET), `signal?`, `credentials: 'omit'`, `redirect: 'follow'`. |
| `GoWayFetchResponse` | The subset of a `Response` the SDK reads: `status`, `headers`, `text()`. |
| `GoWayHeadersLike` | The subset of `Headers` the SDK reads: `get(name)`. |
| `GoWayAbortSignal` | The subset of `AbortSignal` the SDK reads: `aborted`, `addEventListener('abort')`, `removeEventListener('abort')`. |
| `GoWayHttpMethod` | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'`. |

## Namespaces

### `client.places` (`GoWayPlacesApi`)

| Method | Returns | Route | Auth | Errors |
| --- | --- | --- | --- | --- |
| `get` | `Promise<Place>` | `GET /places/{placeId}` | optional | `get(placeId: PlaceId)`: `GoWayNotFoundError`, `GoWayGoneError` |
| `getMany` | `Promise<PlaceBatch>` | `GET /places?ids=` | optional | `getMany(placeIds: readonly PlaceId[])`: `GoWayValidationError` for an empty list or more than `MAX_PLACE_BATCH_SIZE` distinct ids |
| `nearby` | `Promise<PlaceWithDistancePage>` | `GET /places/nearby` | optional | `nearby(query: NearbyPlacesQuery)`.  |
| `inBounds` | `Promise<PlacePage>` | `GET /places/bounds` | optional | `inBounds(query: PlacesInBoundsQuery)`.  |
| `create` | `Promise<Place>` | `POST /places` | required | `create(input: PlaceCreateInput)`: `GoWayConflictError` |
| `update` | `Promise<Place>` | `PATCH /places/{placeId}` | required | `update(placeId: PlaceId, input: PlaceUpdateInput)`: `GoWayForbiddenError`, `GoWayNotFoundError`, `GoWayGoneError`, `GoWayConflictError` |
| `revisions` | `Promise<PlaceRevisionPage>` | `GET /places/{placeId}/revisions` | public | `revisions(placeId: PlaceId, query?: RevisionListQuery)`: `GoWayNotFoundError`, `GoWayGoneError` |
| `report` | `Promise<PlaceReport>` | `POST /places/{placeId}/reports` | required | `report(placeId: PlaceId, input: PlaceReportInput)`. Repeating while your report is open resolves with that report. |

- `get` and `getMany` take `GoWayPlaceReadOptions` (`locale`, `signal`). A single-place read carries `names`, `descriptions` and `localizedDescription`; list reads carry `localizedName` only.
- `getMany` collapses repeated ids and answers in the order you named them: `items` (published places), `gone` (`PlaceBatchGone`, with `mergedInto` for a merged place) and `missing` (ids no place has had).
- `nearby` returns places nearest first, each with `distanceMeters`. `capabilities` is a conjunction (`key` or `key:value`), `categories` a disjunction that includes descendants.
- `update` is a merge patch: an absent field is untouched, `null` clears a field that may be empty.

Sub-namespaces:

#### `client.places.capabilities` (`GoWayPlaceCapabilitiesApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `put` | `Promise<Place>` | `PUT /places/{placeId}/capabilities/{key}` | `put(placeId: PlaceId, key: CapabilityKey, assertion: PlaceCapabilityAssertion)`. required |
| `delete` | `Promise<void>` | `DELETE /places/{placeId}/capabilities/{key}` | `delete(placeId: PlaceId, key: CapabilityKey)`. required |

`key` must be in `CAPABILITY_KEYS` and `assertion.value` must be the kind the key declares; both are checked before sending. The verification tier is derived by the server.

#### `client.places.hoursExceptions` (`GoWayPlaceHoursExceptionsApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<PlaceHoursExceptionPage>` | `GET /places/{placeId}/hours-exceptions` | `list(placeId: PlaceId, query?: HoursExceptionListQuery)`. optional |
| `create` | `Promise<PlaceHoursException>` | `POST /places/{placeId}/hours-exceptions` | `create(placeId: PlaceId, input: PlaceHoursExceptionInput)`. required |
| `replace` | `Promise<PlaceHoursException>` | `PUT /places/{placeId}/hours-exceptions/{exceptionId}` | `replace(placeId: PlaceId, exceptionId: string, input: PlaceHoursExceptionInput)`. required |
| `delete` | `Promise<void>` | `DELETE /places/{placeId}/hours-exceptions/{exceptionId}` | `delete(placeId: PlaceId, exceptionId: string)`. required |

#### `client.places.media` (`GoWayPlaceMediaApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<PlaceMediaPage>` | `GET /places/{placeId}/media` | `list(placeId: PlaceId, query?: MediaListQuery)`. optional |
| `add` | `Promise<PlaceMedia>` | `POST /places/{placeId}/media` | `add(placeId: PlaceId, input: PlaceMediaInput)`. required |
| `remove` | `Promise<void>` | `DELETE /places/{placeId}/media/{mediaId}` | `remove(placeId: PlaceId, mediaId: string)`. required |
| `reorder` | `Promise<void>` | `PUT /places/{placeId}/media/order` | `reorder(placeId: PlaceId, input: PlaceMediaOrderInput)`. required |
| `report` | `Promise<PlaceReport>` | `POST /places/{placeId}/media/{mediaId}/reports` | `report(placeId: PlaceId, mediaId: string, input: ContentReportInput)`. required |

`add` rejects with `GoWayForbiddenError` for a file that is not yours (or a `logo`/`cover` on a place whose business is not you), `GoWayValidationError` for a file that is not a public, active image, `GoWayConflictError` when the gallery already holds it, and `GoWayUnavailableError` when Oxy cannot be asked.

#### `client.places.reviews` (`GoWayPlaceReviewsApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<PlaceReviewPage>` | `GET /places/{placeId}/reviews` | `list(placeId: PlaceId, query?: ReviewListQuery)`. public |
| `mine` | `Promise<PlaceReviewWithStatus>` | `GET /places/{placeId}/reviews/mine` | `mine(placeId: PlaceId)`. required |
| `put` | `Promise<PlaceReviewWithStatus>` | `PUT /places/{placeId}/reviews/mine` | `put(placeId: PlaceId, input: PlaceReviewInput)`. required |
| `delete` | `Promise<void>` | `DELETE /places/{placeId}/reviews/mine` | `delete(placeId: PlaceId)`. required |
| `reply` | `Promise<PlaceReview>` | `PUT /places/{placeId}/reviews/{reviewId}/reply` | `reply(placeId: PlaceId, reviewId: string, input: PlaceReviewReplyInput)`. required |
| `deleteReply` | `Promise<void>` | `DELETE /places/{placeId}/reviews/{reviewId}/reply` | `deleteReply(placeId: PlaceId, reviewId: string)`. required |
| `report` | `Promise<PlaceReport>` | `POST /places/{placeId}/reviews/{reviewId}/reports` | `report(placeId: PlaceId, reviewId: string, input: ContentReportInput)`. required |

`mine` rejects with `GoWayNotFoundError` when you have no review. `reply` and `deleteReply` are for the business that holds an approved claim.

#### `client.places.claims` (`GoWayPlaceClaimsApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `create` | `Promise<PlaceClaim>` | `POST /places/{placeId}/claims` | `create(placeId: PlaceId, input: PlaceClaimInput)`. required |
| `list` | `Promise<PlaceClaimPage>` | `GET /places/{placeId}/claims` | `list(placeId: PlaceId, query?: ClaimListQuery)`. required |

A claim is always created `pending`. Pass `oxyAccountId` to claim for an Oxy organization you own or administer.

### `client.categories` (`GoWayCategoriesApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<CategoryPage>` | `GET /categories` | `list(query?: CategoryListQuery)`. public |

Every category in one page, depth-first, each `label` resolved for `query.locale` (English when absent or unmatched). Index the result with `categoryTaxonomy`.

### `client.claims` (`GoWayClaimsApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<PlaceClaimPage>` | `GET /claims` | `list(query?: AccountClaimListQuery)`. required |

Every claim one account holds, oldest first. The signed-in account by default; `oxyAccountId` for an organization you act for, `placeId` to narrow to one place.

### `client.search` (`GoWaySearchApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `query` | `Promise<SearchResults>` | `GET /search` | `query(query: SearchQuery)`. optional |

Free-text search across GoWay places and the active geocoders. `near` and `viewport` only re-rank; `near` wins when both are given.

### `client.geocode` (`GoWayGeocodeApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `forward` | `Promise<SearchResults>` | `GET /geocode` | `forward(query: SearchQuery)`. optional |
| `reverse` | `Promise<SearchResults>` | `GET /geocode/reverse` | `reverse(query: ReverseGeocodeQuery)`. optional |
| `structured` | `Promise<SearchResults>` | `GET /geocode/structured` | `structured(query: StructuredGeocodeQuery)`. optional |

`structured` needs at least one of `STRUCTURED_GEOCODE_FIELDS`.

### `client.routes` (`GoWayRoutesApi`)

| Method | Returns | Route | Auth | Errors |
| --- | --- | --- | --- | --- |
| `directions` | `Promise<RouteResponse>` | `POST /routes` | optional | `directions(routeRequest: RouteRequest)`: `GoWayNoRouteError`, `GoWayUnsupportedModeError`, `GoWayNotFoundError` (unknown `placeId`) |

"No route" arrives either as `GoWayNoRouteError` or as an empty `routes` array; handle both. A `mode` outside `TRAVEL_MODES` is a `GoWayValidationError` before sending.

### `client.links` (`GoWayLinks`)

Pure URL builders. Nothing is fetched.

| Method | Returns | Description |
| --- | --- | --- |
| `place` | `string` | `place(place: PlaceLinkTarget)`: `https://goway.to/place/<placeId>`. Accepts an id, a `Place`, a `SearchResult` (its `placeId` wins over `id`) or `{ id }`. |
| `map` | `string` | `map(viewport: MapViewport)`: `https://goway.to/?lat=…&lng=…&zoom=…` (plus `bearing`, `pitch` when given). |
| `mapStyle` | `string` | `mapStyle(style: MapStyleId, light?: MapLightPreset)`: `https://goway.to/map/styles/<style>/<light>.json`, in the nearest light the style is published in. |
| `mapStyleIndex` | `string` | `mapStyleIndex()`: `https://goway.to/map/styles/index.json`. Read it with `parseMapStyleIndex`. |
| `styleUrl` | `string` | `styleUrl(url: string, light?: MapLightPreset)`. The document a `goway://styles/<id>` name stands for; any other URL unchanged. |
| `embed` | `string` | `embed(viewport: MapViewport, options?: { style?: MapStyleId; light?: MapLightPreset })`: `https://goway.to/frame?lat=…&lng=…&zoom=…`, with `style` and `light` when either option is given. |

Each throws `GoWayValidationError` for an empty place id, a coordinate out of range, a non-finite `zoom`/`bearing`/`pitch`, or a style or light GoWay does not publish. `PlaceLinkTarget` is `PlaceId | { id: PlaceId } | { placeId: PlaceId }`.

### `client.live` (`GoWayLiveApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `sources` | `Promise<LiveSourcePage>` | `GET /live/sources` | `sources()`. public |
| `shape` | `Promise<LiveShape>` | `GET /live/sources/{sourceId}/shapes/{shapeId}` | `shape(sourceId: string, shapeId: string)`. public |

A deployment with live switched off answers `sources` with `GoWayUnavailableError`. The socket protocol is in [`@goway.to/sdk/live`](./live.md).

### `client.cameras` (`GoWayCamerasApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<CameraPage>` | `GET /cameras` | `list(query: CameraListQuery)`. public |
| `get` | `Promise<Camera>` | `GET /cameras/{cameraId}` | `get(cameraId: string)`. public |
| `observations` | `Promise<CameraObservationPage>` | `GET /cameras/{cameraId}/observations` | `observations(cameraId: string, query?: CameraObservationsQuery)`. public |
| `providers` | `Promise<CameraProviderPage>` | `GET /camera-providers` | `providers()`. public |
| `snapshotUrl` | `string` | `GET /cameras/{cameraId}/snapshot` | `snapshotUrl(cameraId: string)`. Builds the URL of GoWay's copy of the picture, for an image tag; makes no request. |

A picture is always GoWay's own copy, never the operator's. Every camera carries its provider's credit in `attribution` and its `licence`: show them wherever the camera is drawn, and show `status` and `lastFrameAt` with a still, which is as old as the camera's last frame. Observations are aggregates counted off the pictures (vehicles and people by class, flow, congestion); a frame, a face or a plate is never part of one.

### `client.roads` (`GoWayRoadsApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `ruleSets` | `Promise<RoadRuleSetPage>` | `GET /roads/rule-sets` | `ruleSets(query?: RoadRuleSetListQuery)`. public |
| `rules` | `Promise<RoadRules>` | `GET /roads/rules` | `rules(query: RoadRulesQuery)`. public |
| `zones` | `Promise<RoadZonePage>` | `GET /roads/zones` | `zones(query: RoadZoneListQuery)`. public |
| `access` | `Promise<RoadAccessDecision>` | `POST /roads/access` | `access(input: RoadAccessInput)`. public |

The vehicle you describe in `access` is used for one answer and not stored. A `decision` of `unknown` means the vehicle was not described well enough for a zone's rules.

### `client.captures` (`GoWayCapturesApi`)

Street 3D contributions: the signed-in contributor's own sessions and assets.

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `policy` | `Promise<CaptureUploadPolicy>` | `GET /captures/policy` | `policy()`. optional |
| `sessions` | `Promise<CaptureSessionPage>` | `GET /captures/sessions` | `sessions(query?: CaptureListQuery)`. required |
| `createSession` | `Promise<CaptureSession>` | `POST /captures/sessions` | `createSession(input: CaptureSessionInput)`. required |
| `session` | `Promise<CaptureSession>` | `GET /captures/sessions/{sessionId}` | `session(sessionId: string)`. required |
| `assets` | `Promise<CaptureAssetPage>` | `GET /captures/sessions/{sessionId}/assets` | `assets(sessionId: string, query?: CaptureListQuery)`. required |
| `register` | `Promise<CaptureUploadTicket>` | `POST /captures/sessions/{sessionId}/assets` | `register(sessionId: string, input: CaptureAssetInput)`. required |
| `asset` | `Promise<CaptureAsset>` | `GET /captures/assets/{assetId}` | `asset(assetId: string)`. required |
| `finalize` | `Promise<CaptureAsset>` | `POST /captures/assets/{assetId}/finalize` | `finalize(assetId: string)`. required |
| `remove` | `Promise<void>` | `DELETE /captures/assets/{assetId}` | `remove(assetId: string)`. required |

### `client.street3d` (`GoWayStreet3dApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `coverage` | `Promise<StreetCoverage>` | `GET /street3d/coverage` | `coverage(query: StreetCoverageQuery)`. public |
| `scene` | `Promise<StreetSceneManifest>` | `GET /street3d/scenes/{sceneId}` | `scene(id: string)`. public |
| `report` | `Promise<StreetSceneReport>` | `POST /street3d/scenes/{sceneId}/reports` | `report(id: string, input: StreetSceneReportInput)`. required |

A deployment with Street 3D switched off answers `coverage` with `GoWayUnavailableError` and `scene` with `GoWayNotFoundError`.

### `client.organizationLists` (`GoWayOrganizationListsApi`)

Ordered lists of places an Oxy organization publishes, each entry with an activity and a time window.

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<{ items: OrganizationList[]; nextCursor: string \| null }>` | `GET /organization-lists` | `list(query?: OrganizationListQuery)`. public |
| `get` | `Promise<OrganizationList>` | `GET /organization-lists/{listId}` | `get(listId: string)`. public |
| `create` | `Promise<OrganizationList>` | `POST /organization-lists` | `create(input: OrganizationListInput)`. required |
| `update` | `Promise<OrganizationList>` | `PUT /organization-lists/{listId}` | `update(listId: string, input: OrganizationListUpdate)`. required |
| `delete` | `Promise<void>` | `DELETE /organization-lists/{listId}` | `delete(listId: string)`. required |
| `entries` | `Promise<{ items: OrganizationListEntry[]; nextCursor: string \| null }>` | `GET /organization-lists/{listId}/entries` | `entries(listId: string, query?: OrganizationListEntryQuery)`. public |
| `addEntry` | `Promise<OrganizationListEntry>` | `POST /organization-lists/{listId}/entries` | `addEntry(listId: string, input: OrganizationListEntryInput)`. required |
| `updateEntry` | `Promise<OrganizationListEntry>` | `PUT /organization-lists/{listId}/entries/{entryId}` | `updateEntry(listId: string, entryId: string, input: OrganizationListEntryInput)`. required |
| `completeEntry` | `Promise<OrganizationListEntry>` | `POST /organization-lists/{listId}/entries/{entryId}/complete` | `completeEntry(listId: string, entryId: string)`. required |
| `deleteEntry` | `Promise<void>` | `DELETE /organization-lists/{listId}/entries/{entryId}` | `deleteEntry(listId: string, entryId: string)`. required |
| `order` | `Promise<OrganizationList>` | `PUT /organization-lists/{listId}/order` | `order(listId: string, input: OrganizationListOrderInput)`. required |
| `iterate` | `AsyncGenerator<OrganizationList>` | pages of `list` | `iterate(query?: Omit<OrganizationListQuery, 'cursor'>)`. public |
| `iterateEntries` | `AsyncGenerator<OrganizationListEntry>` | pages of `entries` | `iterateEntries(listId: string, query?: Omit<OrganizationListEntryQuery, 'cursor'>)`. public |

`GoWayOrganizationListsApi` is the type of this object.

### `client.lists` (`GoWayListsApi`)

Your own saved place lists ("Saved", "Want to go"): private, personal, never shared or published. A list holds place IDs and your note about each, never a copy of a place; read the place itself for its name, photos and hours. Every call is identity-bound as yourself.

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<SavedListPage>` | `GET /lists` | `list(query?: SavedListQuery)`. required |
| `create` | `Promise<SavedList>` | `POST /lists` | `create(input: SavedListInput)`. required |
| `ensureDefault` | `Promise<SavedList>` | `PUT /lists/default` | `ensureDefault(input: SavedDefaultListInput)`. required |
| `get` | `Promise<SavedList>` | `GET /lists/{listId}` | `get(listId: string)`. required |
| `rename` | `Promise<SavedList>` | `PATCH /lists/{listId}` | `rename(listId: string, input: SavedListUpdateInput)`. required |
| `delete` | `Promise<void>` | `DELETE /lists/{listId}` | `delete(listId: string)`. required |
| `saved` | `Promise<SavedPlaces>` | `GET /saved-places` | `saved(placeIds: readonly string[])`. required |

- `list` answers your lists oldest first.
- A list name is 1 to `MAX_SAVED_LIST_NAME_LENGTH` characters after trimming. A write that conflicts rejects with `GoWayConflictError` whose `details[SAVED_LIST_CONFLICT_DETAIL]` is one of `SAVED_LIST_CONFLICT_REASONS` (`name_taken`, `list_limit_reached`, `item_limit_reached`). Two of your lists never share a name (compared case-blind).
- `ensureDefault` returns your default "Saved" list, the one a one-tap save lands in, and creates it with `input.name` only when you have none; the name is ignored when you already have one. Several devices asking at once still get one list. It is an ordinary list afterwards: it may be renamed or deleted, and the next call makes a new one.
- `get`, `rename` and `delete` reject with `GoWayNotFoundError` for a list that is not yours, exactly as for one that does not exist. `delete` removes the places saved in it.
- `saved` names up to `MAX_SAVED_PLACES_LOOKUP` place IDs (repeats collapse) and answers which of your lists hold each. A place you have not saved is absent from `items`, and the answer is not a page.
- A session switched into an organization is refused with `GoWayForbiddenError`: saved lists are personal.

#### `client.lists.items` (`GoWayListItemsApi`)

The places inside one of your lists. Every call is yours alone: a list that is not yours rejects with `GoWayNotFoundError`.

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `list` | `Promise<SavedListItemPage>` | `GET /lists/{listId}/items` | `list(listId: string, query?: SavedListItemQuery)`. required |
| `add` | `Promise<SavedListItem>` | `POST /lists/{listId}/items` | `add(listId: string, input: SavedListItemInput)`. required |
| `order` | `Promise<void>` | `PUT /lists/{listId}/items/order` | `order(listId: string, input: SavedListItemOrderInput)`. required |
| `setNote` | `Promise<SavedListItem>` | `PATCH /lists/{listId}/items/{itemId}` | `setNote(listId: string, itemId: string, input: SavedListItemUpdateInput)`. required |
| `remove` | `Promise<void>` | `DELETE /lists/{listId}/items/{itemId}` | `remove(listId: string, itemId: string)`. required |

- `list` answers the places in your order.
- `add` saves a place at the end of a list. A place already in it resolves with its existing item, unchanged. It rejects with `GoWayGoneError` for a removed or merged place (`details.mergedInto` names the survivor), `GoWayNotFoundError` for one that never existed, and `GoWayConflictError` with `details.reason === 'item_limit_reached'` when the list holds `MAX_SAVED_LIST_ITEMS` places.
- `order` puts the named items first, in that order; the list's other items keep their relative order after them. An id that is not an item of the list is `GoWayValidationError`.
- `setNote` sets your note, or clears it with `{ note: null }`; the note is always named.

### `client.transit` (`GoWayTransitApi`)

| Method | Returns | Route | Auth |
| --- | --- | --- | --- |
| `nearby` | `Promise<NearbyTransit>` | `GET /transit/nearby` | `nearby(query: NearbyTransitQuery)`. public |

`nearby` answers the stops around a point, nearest first, and what leaves them next. Every departure's `basis` says whether its time is the operator's `scheduled` timetable or its `realtime` prediction (never draw a scheduled departure as live), and every operator that contributed comes with the credit and licence its data is re-served under: show them while the stops are shown. A point no served operator covers answers `{ stops: [], operators: [] }`, not an error. A deployment without the live layer answers `GoWayUnavailableError`. The position is used for the one answer and never stored by GoWay. A value outside a bound is refused with `GoWayValidationError`, not clamped. Design note: `docs/TRANSIT_NEARBY.md`.

### `client.moderation` (`GoWayModerationApi`)

For GoWay operators only. Every call needs an Oxy session on the deployment's operator allow-list; anybody else gets `GoWayForbiddenError`. No integration needs it.

| Method | Returns | Route |
| --- | --- | --- |
| `claims` | `Promise<PlaceClaimPage>` | `claims(query?: ModerationClaimListQuery)`: `GET /moderation/claims` |
| `decideClaim` | `Promise<PlaceClaim>` | `decideClaim(claimId: string, input: ClaimDecisionInput)`: `POST /moderation/claims/{claimId}/decision` |
| `updatePlace` | `Promise<void>` | `updatePlace(placeId: PlaceId, input: ModerationPlaceUpdateInput)`: `PATCH /moderation/places/{placeId}` |
| `verifyCapability` | `Promise<Place>` | `verifyCapability(placeId: PlaceId, key: CapabilityKey, input: ModerationCapabilityInput)`: `PUT /moderation/places/{placeId}/capabilities/{key}` |
| `withdrawVerifiedCapability` | `Promise<void>` | `withdrawVerifiedCapability(placeId: PlaceId, key: CapabilityKey)`: `DELETE /moderation/places/{placeId}/capabilities/{key}` |
| `revisions` | `Promise<ModerationPlaceRevisionPage>` | `revisions(placeId: PlaceId, query?: RevisionListQuery)`: `GET /moderation/places/{placeId}/revisions` |
| `duplicates` | `Promise<DuplicateCandidatePage>` | `duplicates(query?: DuplicateListQuery)`: `GET /moderation/duplicates` |
| `resolveDuplicate` | `Promise<DuplicateCandidate>` | `resolveDuplicate(candidateId: string, input: DuplicateResolutionInput)`: `POST /moderation/duplicates/{candidateId}/resolution` |
| `reports` | `Promise<ModerationPlaceReportPage>` | `reports(query?: ModerationReportListQuery)`: `GET /moderation/reports` |
| `resolveReport` | `Promise<ModerationPlaceReport>` | `resolveReport(reportId: string, input: PlaceReportResolutionInput)`: `POST /moderation/reports/{reportId}/resolution` |
| `media` | `Promise<ModerationPlaceMediaPage>` | `media(placeId: PlaceId, query?: ModerationMediaListQuery)`: `GET /moderation/places/{placeId}/media` |
| `moderateMedia` | `Promise<ModerationPlaceMedia>` | `moderateMedia(placeId: PlaceId, mediaId: string, input: ModerationMediaInput)`: `PATCH /moderation/places/{placeId}/media/{mediaId}` |
| `reviews` | `Promise<PlaceReviewWithStatusPage>` | `reviews(placeId: PlaceId, query?: ModerationReviewListQuery)`: `GET /moderation/places/{placeId}/reviews` |
| `moderateReview` | `Promise<PlaceReviewWithStatus>` | `moderateReview(placeId: PlaceId, reviewId: string, input: ModerationReviewInput)`: `PATCH /moderation/places/{placeId}/reviews/{reviewId}` |
| `removeReviewReply` | `Promise<void>` | `removeReviewReply(placeId: PlaceId, reviewId: string)`: `DELETE /moderation/places/{placeId}/reviews/{reviewId}/reply` |
| `categories` | `Promise<ModerationCategoryPage>` | `categories(query?: CategoryListQuery)`: `GET /moderation/categories` |
| `createCategory` | `Promise<ModerationCategory>` | `createCategory(input: CategoryCreateInput)`: `POST /moderation/categories` |
| `updateCategory` | `Promise<ModerationCategory>` | `updateCategory(key: string, input: CategoryUpdateInput)`: `PATCH /moderation/categories/{key}` |
| `setCategoryLabel` | `Promise<ModerationCategory>` | `setCategoryLabel(key: string, language: string, input: CategoryLabelInput)`: `PUT /moderation/categories/{key}/labels/{language}` |
| `removeCategoryLabel` | `Promise<void>` | `removeCategoryLabel(key: string, language: string)`: `DELETE /moderation/categories/{key}/labels/{language}` |

### Namespace interface types

| Type | Namespace |
| --- | --- |
| `GoWayPlacesApi` | `client.places` |
| `GoWayPlaceCapabilitiesApi` | `client.places.capabilities` |
| `GoWayPlaceHoursExceptionsApi` | `client.places.hoursExceptions` |
| `GoWayPlaceMediaApi` | `client.places.media` |
| `GoWayPlaceReviewsApi` | `client.places.reviews` |
| `GoWayPlaceClaimsApi` | `client.places.claims` |
| `GoWayCategoriesApi` | `client.categories` |
| `GoWayClaimsApi` | `client.claims` |
| `GoWaySearchApi` | `client.search` |
| `GoWayGeocodeApi` | `client.geocode` |
| `GoWayRoutesApi` | `client.routes` |
| `GoWayLinks` | `client.links` |
| `GoWayLiveApi` | `client.live` |
| `GoWayCamerasApi` | `client.cameras` |
| `GoWayRoadsApi` | `client.roads` |
| `GoWayCapturesApi` | `client.captures` |
| `GoWayStreet3dApi` | `client.street3d` |
| `GoWayOrganizationListsApi` | `client.organizationLists` |
| `GoWayListsApi` | `client.lists` |
| `GoWayListItemsApi` | `client.lists.items` |
| `GoWayTransitApi` | `client.transit` |
| `GoWayModerationApi` | `client.moderation` |

## Errors

Every error the SDK throws extends `GoWayError`. `instanceof` works across two copies of the package (an ESM and a CommonJS build side by side).

### `GoWayError`

| Member | Type | Description |
| --- | --- | --- |
| `code` | `GoWayErrorCode` | Stable, machine-readable code. Branch on this or on the class, never on `message`. |
| `status` | `number \| null` | HTTP status, or `null` when no response was received or the error is client-side. |
| `retryable` | `boolean` | Whether repeating the same request later may succeed. For an API error this is `API_ERROR_RETRYABLE[code]`. The SDK never retries by itself. |
| `details` | `Readonly<Record<string, unknown>> \| null` | The `error.details` of the API's error body. |
| `cause` | `unknown` | The underlying error, when there is one. Non-enumerable. |
| `toJSON` | `Record<string, unknown>` | `toJSON()`. A loggable shape with `name`, `code`, `status`, `retryable`, `message` and `details`. No cause, stack or token. |
| `GoWayError.errorName` | `string` (static) | The stable class name used for cross-copy `instanceof`. |

### Error classes

| Class | Extends | Default `code` | Retryable | Raised for |
| --- | --- | --- | --- | --- |
| `GoWayError` | `Error` | `http_error` | no | Base class. |
| `GoWayNetworkError` | `GoWayError` | `network_error` | yes | DNS, TLS, connection reset, offline; a body that could not be read. |
| `GoWayTimeoutError` | `GoWayNetworkError` | `timeout` | yes | The request outlived `timeoutMs`. |
| `GoWayAbortError` | `GoWayError` | `aborted` | no | The caller's `signal` was aborted. |
| `GoWayApiError` | `GoWayError` | `http_error` | no (yes for 408) | A non-2xx response with no more specific class, including a 404 or 410 without a GoWay error body. |
| `GoWayValidationError` | `GoWayError` | `validation_failed` | no | `bad_request`, `validation_failed`, `method_not_allowed`, `payload_too_large`; input refused before sending (`status: null`). |
| `GoWayUnauthorizedError` | `GoWayError` | `unauthorized` | no | 401. |
| `GoWayForbiddenError` | `GoWayError` | `forbidden` | no | 403. |
| `GoWayNotFoundError` | `GoWayError` | `not_found` | no | 404 with a GoWay error body. |
| `GoWayGoneError` | `GoWayError` | `gone` | no | 410: the place was removed, or merged. Adds `mergedInto: PlaceId \| null`. |
| `GoWayUnknownRouteError` | `GoWayApiError` | `unknown_route` | no | The API has no route at this path (SDK newer than the deployment, or the wrong origin). |
| `GoWayConflictError` | `GoWayError` | `conflict` | no | 409. |
| `GoWayNoRouteError` | `GoWayApiError` | `no_route` | no | No route exists between the points. |
| `GoWayUnsupportedModeError` | `GoWayApiError` | `unsupported_mode` | no | The travel mode is not covered here. |
| `GoWayRateLimitError` | `GoWayError` | `rate_limited` | yes | 429. Adds `retryAfterSeconds: number \| null`. |
| `GoWayUnavailableError` | `GoWayError` | `provider_unavailable` | per code | `provider_unavailable` and `service_unavailable` (retryable), `internal_error` (not retryable), and a 5xx other than 501 and 505 without a GoWay body. |
| `GoWayResponseError` | `GoWayError` | `malformed_response` | no | A 2xx body that is not the contract, or a repeated or malformed page cursor. |

Every constructor is `new (message: string, options?: GoWayErrorOptions)`; `GoWayRateLimitError` takes `GoWayRateLimitErrorOptions`.

| Name | Kind | Description |
| --- | --- | --- |
| `isGoWayError` | function | `isGoWayError(value: unknown): value is GoWayError`. Whether a value was thrown by any copy of this SDK. |
| `GoWayErrorCode` | type | `ApiErrorCode` plus `'network_error' \| 'timeout' \| 'aborted' \| 'malformed_response' \| 'http_error'`. |
| `GoWayErrorOptions` | type | `{ status?, code?, retryable?, details?, cause? }`, all optional. |
| `GoWayRateLimitErrorOptions` | type | `GoWayErrorOptions` plus `retryAfterSeconds?: number \| null`. |

### API error vocabulary

| Name | Kind | Description |
| --- | --- | --- |
| `API_ERROR_CODES` | value | Every code the API may return, in status order: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `unknown_route`, `method_not_allowed`, `conflict`, `gone`, `payload_too_large`, `validation_failed`, `no_route`, `unsupported_mode`, `rate_limited`, `internal_error`, `provider_unavailable`, `service_unavailable`. |
| `API_ERROR_STATUS` | value | The HTTP status of each code (`no_route` and `unsupported_mode` are 422; `provider_unavailable` and `service_unavailable` are 503). |
| `API_ERROR_RETRYABLE` | value | Whether each code is worth retrying: `true` only for `rate_limited`, `provider_unavailable` and `service_unavailable`. |
| `isApiErrorCode` | function | `isApiErrorCode(value: unknown): value is ApiErrorCode`. Narrows a string to `ApiErrorCode`. |
| `ApiErrorCode` | type | One of `API_ERROR_CODES`. |
| `ApiErrorBody` | type | `{ error: { code: ApiErrorCode; message: string; details?: ApiErrorDetails } }`. |
| `ApiErrorDetails` | type | `Record<string, string \| number \| boolean \| null>`. |
| `GONE_MERGED_INTO_DETAIL` | value | `'mergedInto'`: the `details` key of a `gone` answer that names where a merged place went. |

## Pagination

| Name | Kind | Description |
| --- | --- | --- |
| `iterateGoWayPages` | function | `iterateGoWayPages<T>(fetchPage: (cursor: string \| undefined) => Promise<GoWayPageLike<T>>): AsyncGenerator<T, void, undefined>`. Every item of a list, page after page. Calls `fetchPage(undefined)` first, then with each `nextCursor` until it is `null`. Throws `GoWayResponseError` if the server repeats a cursor or returns one that is neither a string nor `null`; `TypeError` if `fetchPage` is not a function. |
| `GoWayPageLike` | type | `GoWayPageLike<T>`: `{ readonly items: readonly T[]; readonly nextCursor: string \| null }`. |
| `Page` | type | `Page<T>`: `{ items: T[]; nextCursor: string \| null }`: the shape of every list response. |
| `MAX_CURSOR_LENGTH` | value | `512`. The longest cursor GoWay mints. |

## Functions

### Places and capabilities

| Function | Signature | Description |
| --- | --- | --- |
| `placeDisplayName` | `placeDisplayName(place: Pick<Place, 'name' \| 'localizedName'>): string` | The name to show: `localizedName` when GoWay resolved one, else the default `name`. |
| `placeHasCapability` | `placeHasCapability(place: { capabilities }, key: string): boolean` | Whether the place's strongest assertion of `key` holds. The rule the `capabilities` filter applies. |
| `placeMatchesCapabilityFilter` | `placeMatchesCapabilityFilter(place: { capabilities }, filter: string): boolean` | Whether a place matches one filter entry, `key` or `key:value`. |
| `strongestCapability` | `strongestCapability(place: { capabilities }, key: string): PlaceCapability \| undefined` | The strongest assertion for a key, by `CAPABILITY_VERIFICATIONS` order, then freshest. |
| `splitCapabilityKey` | `splitCapabilityKey(key: string): { namespace: string; capability: string }` | Splits at the last dot. |
| `isCapabilityKey` | `isCapabilityKey(value: string): value is CapabilityKey` | Whether a string is a registered key. |
| `capabilityHolds` | `capabilityHolds(key: string, value: CapabilityValue): boolean` | Whether a value says the place has the capability (`false`, `0`, `''`, `[]` and an enum's absent values never do). |
| `capabilityValueKind` | `capabilityValueKind(key: string): CapabilityValueKind \| undefined` | The kind of value a key holds. |
| `capabilityLabel` | `capabilityLabel(key: string, locale?: string \| null): string` | The key's label in a locale, or the key itself. |
| `capabilityValueLabel` | `capabilityValueLabel(key: string, value: string, locale?: string \| null): string` | The label of one enum value, or the value itself. |
| `capabilityGroupOf` | `capabilityGroupOf(key: string): CapabilityGroup \| undefined` | The group a key renders under. |
| `capabilityGroupLabel` | `capabilityGroupLabel(group: CapabilityGroup, locale?: string \| null): string` | The label of a group. |

### Categories

| Function | Signature | Description |
| --- | --- | --- |
| `categoryTaxonomy` | `categoryTaxonomy<C extends Category>(categories: readonly C[]): CategoryTaxonomy<C>` | Indexes a category list: `of(key)`, `label(key, locale?)`, `descendants(key)`. |
| `categoryParent` | `categoryParent(key: string): string \| null` | The parent key, or `null` for a root. |
| `categoryRoot` | `categoryRoot(key: string): string` | The root key: `food.cafe` gives `food`. |

### Hours

| Function | Signature | Description |
| --- | --- | --- |
| `openingStatusAt` | `openingStatusAt(facts: OpeningFacts, now?: Date): OpeningStatus` | Whether a place is open at `now` (default: the current time) and when that next changes, reading hours exceptions before the weekly schedule. Any `Place` is valid `facts`. |

### Language and labels

| Function | Signature | Description |
| --- | --- | --- |
| `localizedLabel` | `localizedLabel(entry: LocalizedLabels, locale?: string \| null): string` | The best label for a reader's locale, English when none serves. Also exported from `@goway.to/sdk/map`. |
| `matchLanguageTag` | `matchLanguageTag(offered: readonly string[], locale: string \| null \| undefined): string \| undefined` | The tag among `offered` that best serves `locale`. |
| `normalizeLanguageTag` | `normalizeLanguageTag(tag: string \| null \| undefined): string \| undefined` | A tag in canonical form, or `undefined`. |
| `baseLanguageTag` | `baseLanguageTag(tag: string \| null \| undefined): string \| undefined` | The base language: `es-419` gives `es`. |

### Geography

| Function | Signature | Description |
| --- | --- | --- |
| `toGeoCoordinate` | `toGeoCoordinate(position: GeoPosition): GeoCoordinate` | GeoJSON `[longitude, latitude]` to `{ latitude, longitude }`. |
| `toGeoPosition` | `toGeoPosition(coordinate: GeoCoordinate): GeoPosition` | `{ latitude, longitude }` to GeoJSON `[longitude, latitude]`. |
| `boundingBoxWidth` | `boundingBoxWidth(box: Pick<GeoBoundingBox, 'west' \| 'east'>): number` | East-west span in degrees, across the antimeridian. |
| `geoGeometryContains` | `geoGeometryContains(geometry: GeoGeometry, point: { latitude; longitude }): boolean` | Whether a point is inside a Polygon or MultiPolygon. |

More geographic arithmetic is in [`@goway.to/sdk/geo`](./geo.md).

### Road rules

| Function | Signature | Description |
| --- | --- | --- |
| `decideAccess` | `decideAccess(zones: readonly RoadZone[], position, vehicle: VehicleProfile, at: Date): RoadAccessDecision` | The decision for a position over the zones covering it. The same evaluation the server runs. |
| `evaluateZone` | `evaluateZone(zone: RoadZone, vehicle: VehicleProfile, at: Date): RoadZoneVerdict` | What one zone says to a vehicle at a time. |
| `zoneInForce` | `zoneInForce(zone: RoadZone, at: Date): boolean \| undefined` | Whether a zone is in force, in its own timezone. |
| `strictestDecision` | `strictestDecision(decisions: readonly (ZoneDecision \| 'unknown')[]): ZoneDecision \| 'unknown'` | `denied` over `permit` over `fee` over `allowed`. |
| `environmentalLabelOf` | `environmentalLabelOf(scheme: EnvironmentalLabelScheme, vehicle: VehicleProfile): string \| undefined` | A vehicle's label under a scheme, or `undefined` when it cannot be told. |
| `parseMaxspeedKmh` | `parseMaxspeedKmh(value: string \| undefined, ruleSets?: (countryCode: string) => RoadRuleSet \| undefined): number \| undefined` | An OSM `maxspeed` value in km/h, including implicit values such as `ES:urban`. |

Who may use a road (OSM access tags) is in [`@goway.to/sdk/road-access`](./road-access.md).

### Map styles

| Function | Signature | Description |
| --- | --- | --- |
| `styleDocumentUrl` | `styleDocumentUrl(url: string, light?: MapLightPreset, webBaseUrl?: string): string \| null` | The document a `goway://styles/<id>` name stands for; any other URL unchanged; `null` for an unpublished style or light. |
| `gowayStyleUrl` | `gowayStyleUrl(style: MapStyleId, light?: MapLightPreset): string` | The `goway://styles/<id>` name of a style. |
| `parseGoWayStyleUrl` | `parseGoWayStyleUrl(url: string): { style: MapStyleId; light?: MapLightPreset } \| null` | Reads a `goway://` style name. |
| `resolveMapStyle` | `resolveMapStyle(style: MapStyleId, wanted?: MapLightPreset, sunUp?: boolean): MapStyleSelection` | The light a style is actually drawn in. |
| `mapStylePath` | `mapStylePath(selection: MapStyleSelection): string` | Where a style document is served, relative to the web origin. |
| `mapStyleDefinition` | `mapStyleDefinition(id: MapStyleId): MapStyleDefinition` | One catalogue entry. |
| `isMapStyleId` | `isMapStyleId(value: unknown): value is MapStyleId` | Narrows to a style id. |
| `isMapLightPreset` | `isMapLightPreset(value: unknown): value is MapLightPreset` | Narrows to a light. |
| `parseMapStyleIndex` | `parseMapStyleIndex(value: unknown): MapStyleIndex` | Checks a fetched `index.json` catalogue. Throws `GoWayValidationError` when it is not one. Unknown styles are kept. |

These (except `parseMapStyleIndex`) are also exported from [`@goway.to/sdk/map`](./map.md).

### 3D models

| Function | Signature | Description |
| --- | --- | --- |
| `parseModelPlacement` | `parseModelPlacement(input: unknown): ModelPlacement \| null` | A placement a renderer can draw, with every default applied, or `null`. Never throws. |

## Constants

### Places

| Name | Value |
| --- | --- |
| `PLACE_STATUSES` | `['active', 'closed', 'proposed', 'removed', 'merged']` |
| `WRITABLE_PLACE_STATUSES` | `['active', 'closed', 'proposed']` |
| `PUBLISHED_PLACE_STATUSES` | `['active', 'closed', 'proposed']` |
| `MODERATED_PLACE_STATUSES` | `['active', 'closed', 'proposed', 'removed']` |
| `PLACE_VERIFICATION_STATES` | `['unverified', 'community_reviewed', 'oxy_verified', 'owner_verified']` |
| `PLACE_CLAIM_ROLES` | `['owner', 'operator', 'manager', 'brand']` |
| `PLACE_CLAIM_STATES` | `['pending', 'approved', 'rejected', 'revoked']` |
| `MAX_PLACE_LIST_LIMIT` | `200` |
| `DEFAULT_PLACE_LIST_LIMIT` | `50` |
| `MAX_PLACE_BATCH_SIZE` | `50` |
| `MAX_RADIUS_METERS` | `50000` |
| `MAX_BOUNDS_SPAN_DEGREES` | `90` |
| `MAX_CLAIM_LIST_LIMIT` | `200` |
| `DEFAULT_CLAIM_LIST_LIMIT` | `50` |
| `MAX_DESCRIPTION_LENGTH` | `2000` |

### Capabilities

| Name | Value |
| --- | --- |
| `CAPABILITY_KEYS` | Every registered key, in display order (`accessibility.wheelchair`, `payments.faircoin.accepted`, `mobility.moovo.pickup`, ...). |
| `CAPABILITY_GROUPS` | `['accessibility', 'payment', 'amenities', 'food', 'price', 'social', 'brand', 'ecosystem']` |
| `CAPABILITY_VALUE_KINDS` | `['boolean', 'enum', 'enum_set', 'integer', 'price_level', 'url', 'text']` |
| `CAPABILITY_VERIFICATIONS` | `['community_reported', 'external_source', 'business_asserted', 'oxy_verified']`, weakest to strongest. |

### Categories

| Name | Value |
| --- | --- |
| `CATEGORY_ICONS` | The provider-neutral glyph keys a category may use (`place`, `restaurant`, `cafe`, ...). |
| `CATEGORY_STATUSES` | `['active', 'deprecated']` |
| `CATEGORY_KEY_PATTERN` | `RegExp` for a dotted key of lower-case segments (`food.cafe`). |
| `OSM_TAG_PATTERN` | `RegExp` for one OpenStreetMap tag (`amenity=cafe`, `shop=*`). |
| `MAX_CATEGORY_KEY_LENGTH` | `64` |
| `MAX_CATEGORY_LABEL_LENGTH` | `80` |
| `MAX_CATEGORY_OSM_TAGS` | `64` |
| `MAX_CATEGORY_POSITION` | `1000000` |

### Hours

| Name | Value |
| --- | --- |
| `MAX_HOURS_EXCEPTION_DAYS` | `366` |
| `MAX_HOURS_EXCEPTION_INTERVALS` | `8` |
| `MAX_HOURS_EXCEPTION_LIST_LIMIT` | `100` |
| `DEFAULT_HOURS_EXCEPTION_LIST_LIMIT` | `50` |

### Media and reviews

| Name | Value |
| --- | --- |
| `PLACE_MEDIA_KINDS` | `['photo', 'logo', 'cover', 'menu', 'interior', 'exterior']` |
| `BUSINESS_MEDIA_KINDS` | `['logo', 'cover']`: kinds only a claimant may add to a claimed place. |
| `PLACE_MEDIA_STATES` | `['visible', 'hidden', 'removed']` |
| `MODERATED_PLACE_MEDIA_STATES` | `['visible', 'hidden']` |
| `PLACE_MEDIA_MIME_TYPES` | `['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']` |
| `MAX_MEDIA_CAPTION_LENGTH` | `280` |
| `MAX_MEDIA_ORDER_LENGTH` | `200` |
| `MAX_MEDIA_LIST_LIMIT` | `100` |
| `DEFAULT_MEDIA_LIST_LIMIT` | `30` |
| `PLACE_REVIEW_STATUSES` | `['published', 'hidden', 'removed']` |
| `MODERATED_PLACE_REVIEW_STATUSES` | `['published', 'hidden']` |
| `REVIEW_SORTS` | `['newest', 'highest', 'lowest']` |
| `MIN_REVIEW_RATING` | `1` |
| `MAX_REVIEW_RATING` | `5` |
| `MAX_REVIEW_TITLE_LENGTH` | `120` |
| `MAX_REVIEW_BODY_LENGTH` | `4000` |
| `MAX_REVIEW_REPLY_LENGTH` | `2000` |
| `MAX_REVIEW_LIST_LIMIT` | `50` |
| `DEFAULT_REVIEW_LIST_LIMIT` | `20` |
| `CONTENT_REPORT_REASONS` | `['spam', 'offensive', 'privacy', 'not_this_place', 'conflict_of_interest']` |

### Revisions, reports and moderation

| Name | Value |
| --- | --- |
| `PLACE_REVISION_ACTIONS` | Every kind of write a revision records (`place_created`, `place_updated`, `capability_asserted`, ...). |
| `PLACE_REVISION_VISIBILITY` | Each action classified `public` or `moderation`. |
| `PUBLIC_PLACE_REVISION_ACTIONS` | The actions the public history lists. |
| `PLACE_REVISION_SOURCES` | `['api', 'moderation']` |
| `MAX_REVISION_LIST_LIMIT` | `100` |
| `DEFAULT_REVISION_LIST_LIMIT` | `25` |
| `PLACE_REPORT_REASONS` | `['does_not_exist', 'permanently_closed', 'wrong_location', 'wrong_details', 'duplicate', 'spam', 'offensive', 'privacy', 'not_this_place', 'conflict_of_interest']` |
| `PLACE_REPORT_RESOLUTIONS` | `['actioned', 'dismissed']` |
| `PLACE_REPORT_STATES` | `['open', 'resolved']` |
| `CLAIM_DECISION_STATES` | `['approved', 'rejected', 'revoked']` |
| `CLAIM_DECISION_FROM` | The state a claim must be in for each decision. |
| `DUPLICATE_CANDIDATE_REASONS` | `['shared_source_id', 'proximity_and_name', 'proximity_and_translated_name', 'manual_report']` |
| `DUPLICATE_CANDIDATE_STATES` | `['open', 'confirmed', 'rejected']` |
| `MAX_MODERATION_LIST_LIMIT` | `100` |
| `DEFAULT_MODERATION_LIST_LIMIT` | `25` |

### Labels and language

| Name | Value |
| --- | --- |
| `LABEL_LANGUAGES` | `['en', 'ar', 'bn', 'ca', 'de', 'es', 'fr', 'hi', 'ja', 'pt-BR', 'ru', 'zh-Hans']`. The first is the fallback. |
| `LANGUAGE_TAG_PATTERN` | `RegExp` for a canonical tag (`es`, `zh-Hant`, `en-GB`, `es-419`). |
| `MAX_LANGUAGE_TAG_LENGTH` | `35` |

### Search and directions

| Name | Value |
| --- | --- |
| `SEARCH_RESULT_KINDS` | `['place', 'address', 'street', 'locality', 'region', 'country', 'poi']` |
| `SEARCH_SOURCES` | `['goway', 'photon', 'nominatim']`. Open-ended: other sources may appear. |
| `SEARCH_MAX_LIMIT` | `50` |
| `SEARCH_MAX_DEPTH` | `50`: the deepest result position across all pages. |
| `MAX_SEARCH_QUERY_LENGTH` | `256` |
| `STRUCTURED_GEOCODE_FIELDS` | `['street', 'houseNumber', 'city', 'region', 'postalCode', 'countryCode']` |
| `TRAVEL_MODES` | `['drive', 'walk', 'bike']` |
| `ROUTE_EXCLUDES` | `['toll', 'motorway', 'ferry']` |
| `MAX_WAYPOINTS` | `8` |
| `MANEUVER_TYPES` | `['depart', 'continue', 'turn-left', 'turn-right', 'turn-slight-left', 'turn-slight-right', 'turn-sharp-left', 'turn-sharp-right', 'uturn', 'merge', 'fork', 'roundabout-enter', 'roundabout-exit', 'ferry', 'arrive']`. Open-ended. |

### Cameras

| Name | Value |
| --- | --- |
| `CAMERA_KINDS` | `['traffic', 'city', 'harbour', 'mountain', 'weather']` |
| `CAMERA_MEDIA_KINDS` | `['snapshot', 'mjpeg', 'hls']` |
| `CAMERA_STATUSES` | `['live', 'stale', 'offline', 'unknown']` |
| `CAMERA_HEALTH` | `['ok', 'dark', 'obstructed', 'frozen']` |
| `CONGESTION_LEVELS` | `['free', 'busy', 'slow', 'stopped']` |
| `OBSERVED_CLASSES` | `['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'pedestrian']` |
| `DEFAULT_CAMERA_LIST_LIMIT` | `200` |
| `MAX_CAMERA_LIST_LIMIT` | `1000` |
| `DEFAULT_OBSERVATION_LIMIT` | `60` |
| `MAX_OBSERVATION_LIMIT` | `500` |

### Road rules

| Name | Value |
| --- | --- |
| `DRIVING_SIDES` | `['left', 'right']` |
| `IMPLICIT_SPEED_CLASSES` | `['urban', 'rural', 'trunk', 'motorway', 'living_street']` |
| `ROAD_ZONE_KINDS` | `['low_emission', 'congestion_charge', 'restricted_access']` |
| `ROAD_ZONE_KIND_LABELS` | Each zone kind's label in every `LABEL_LANGUAGES` language. |
| `ZONE_DECISIONS` | `['allowed', 'fee', 'permit', 'denied']`, most to least permissive. |
| `VEHICLE_USERS` | `['car', 'taxi', 'van', 'hgv', 'bus', 'motorcycle', 'moped']` |
| `VEHICLE_FUELS` | `['petrol', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'hydrogen', 'lpg', 'cng']` |
| `EMISSION_STANDARDS` | `['euro_1', 'euro_2', 'euro_3', 'euro_4', 'euro_5', 'euro_6']` |
| `ENVIRONMENTAL_LABEL_SCHEMES` | `['es_dgt', 'fr_critair', 'de_plakette', 'uk_ulez']` |
| `ENVIRONMENTAL_LABEL_SCHEME_LABELS` | Each scheme's name in every label language. |
| `ENVIRONMENTAL_LABEL_VALUES` | Each scheme's values (`es_dgt`: `0`, `eco`, `c`, `b`, `none`; ...). |
| `MAX_ROAD_LIST_LIMIT` | `200` |
| `DEFAULT_ROAD_LIST_LIMIT` | `50` |

### Saved lists

| Name | Value |
| --- | --- |
| `SAVED_LIST_VISIBILITIES` | `['private']`: only the owner reads a list. |
| `MAX_SAVED_LISTS_PER_USER` | `100` |
| `MAX_SAVED_LIST_ITEMS` | `500`: places in one list. |
| `MAX_SAVED_LIST_NAME_LENGTH` | `80` |
| `MAX_SAVED_ITEM_NOTE_LENGTH` | `500` |
| `SAVED_LIST_COVER_PLACES` | `4`: how many place ids a list's `coverPlaceIds` carries. |
| `MAX_SAVED_PLACES_LOOKUP` | `50`: place ids one `saved` lookup names. |
| `MAX_SAVED_LIST_PAGE_LIMIT` | `100` |
| `DEFAULT_SAVED_LIST_PAGE_LIMIT` | `50` |
| `MAX_SAVED_ITEM_PAGE_LIMIT` | `100` |
| `DEFAULT_SAVED_ITEM_PAGE_LIMIT` | `50` |
| `SAVED_LIST_CONFLICT_DETAIL` | `'reason'`: the `details` key of a saved-list `conflict`. |
| `SAVED_LIST_CONFLICT_REASONS` | `['name_taken', 'list_limit_reached', 'item_limit_reached']` |

### Captures

| Name | Value |
| --- | --- |
| `CAPTURE_ASSET_STATES` | `['expected', 'abandoned', 'uploaded', 'validating', 'accepted', 'rejected', 'waiting_for_overlap', 'reconstruction_candidate', 'integrated', 'expired', 'deleted']` |
| `CAPTURE_CONTENT_HASH_ALGORITHM` | `'sha256'` |
| `CAPTURE_LOCATION_ORIGINS` | `['device_capture', 'media_metadata', 'user_placed']`, best first. |
| `CAPTURE_LOCATION_ORIGIN_RANK` | Preference rank for each origin; higher wins. |
| `CAPTURE_LOCATION_WITNESSES` | `['client', 'goway_ingest']` |
| `CAPTURE_MEDIA_KINDS` | `['photo', 'video']` |
| `CAPTURE_MOTION_ORIENTATIONS` | `['portrait', 'portraitUpsideDown', 'landscapeLeft', 'landscapeRight']` |
| `CAPTURE_PRIVACY_STATES` | `['pending', 'in_progress', 'passed', 'failed', 'blocked']`. Only `passed` opens the gate. |
| `CAPTURE_PROJECTIONS` | `['perspective', 'equirectangular']` |
| `CAPTURE_RETENTION_CLASSES` | `['raw_photo', 'raw_video', 'extracted_keyframe', 'privacy_safe_proxy', 'thumbnail']` |
| `CAPTURE_SOURCES` | `['camera', 'library', 'guided_session']` |
| `RETENTION_CLASSES` | Every class of stored artifact (the capture classes plus derived ones). |
| `RETENTION_REASONS` | Why an object is being kept right now. |
| `DELETION_REASONS` | `['expired', 'contributor_request', 'moderation', 'duplicate', 'invalid_media', 'superseded_by_derivative']` |
| `MAX_CAPTURE_LIST_LIMIT` | `100` |
| `DEFAULT_CAPTURE_LIST_LIMIT` | `50` |
| `MAX_CAPTURE_MOTION_SAMPLES` | `14400` |

### Street 3D

| Name | Value |
| --- | --- |
| `STREET_COVERAGE_AREA_STATES` | `['seeded', 'partial', 'at_risk', 'reconstructable', 'reconstructing', 'needs_more_capture']` |
| `STREET_SCENE_ASSET_FORMATS` | `['spz', 'rad', 'jpeg']` |
| `STREET_SCENE_ASSET_ROLES` | `['splat', 'splat_preview', 'splat_environment', 'poster']` |
| `STREET_SCENE_ASSET_ROLE_FORMATS` | The formats each role may be published in. |
| `STREET_SCENE_PRIVACY_BASES` | `['licensor_redacted', 'goway_splat_review']` |
| `STREET_SCENE_PROFILES` | `['draft', 'standard']` |
| `STREET_SCENE_REPORT_REASONS` | `['privacy', 'inappropriate', 'inaccurate', 'other']` |

### 3D models

| Name | Value |
| --- | --- |
| `MODEL_ALTITUDE_REFERENCES` | `['ground']` |
| `MIN_MODEL_ALTITUDE_METERS` | `-500` |
| `MAX_MODEL_ALTITUDE_METERS` | `10000` |
| `MAX_MODEL_LATITUDE` | `85.051129` |
| `MAX_MODEL_SCALE` | `1000` |

### Map styles and tiles

| Name | Value |
| --- | --- |
| `MAP_STYLE_IDS` | `['standard', 'streets', 'outdoors', 'navigation', 'monochrome', 'satellite', 'hybrid', 'light', 'dark']` |
| `MAP_LIGHT_PRESETS` | `['day', 'dawn', 'dusk', 'night']` |
| `MAP_STYLE_LIGHT_KINDS` | `['follows', 'fixed']` |
| `MAP_STYLE_CATALOGUE` | One `MapStyleDefinition` per style: the lights each is published in. |
| `MAP_STYLE_INDEX_PATH` | `'/map/styles/index.json'` |
| `DEFAULT_MAP_STYLE` | `'standard'` |
| `GOWAY_STYLE_URL_PREFIX` | `'goway://styles/'` |
| `OPENMAPTILES_SOURCE_LAYERS` | Source-layer names in GoWay's vector tiles, by role. |
| `OPENMAPTILES_SOURCE_LAYER_NAMES` | Every source-layer name. |
| `TRANSPORTATION_CLASSES` | Observed values of `transportation.class`. |
| `LANDCOVER_CLASSES` | Observed values of `landcover.class`. |
| `LANDUSE_CLASSES` | Observed values of `landuse.class`. |
| `PLACE_CLASSES` | Observed values of `place.class`. |
| `WATER_CLASSES` | Observed values of `water.class`. |
| `POI_CLASSES` | Observed values of `poi.class`. |
| `AVAILABLE_FONTS` | `['Inter Regular', 'Inter Medium', 'Inter SemiBold', 'Inter Bold']` |
| `FONT_STACKS` | The font stacks as MapLibre wants them: `regular`, `medium`, `semibold`, `bold`. |

The map-style and tile constants are also exported from [`@goway.to/sdk/map`](./map.md).

## Types

### Geography

| Type | Description |
| --- | --- |
| `GeoCoordinate` | `{ latitude: number; longitude: number }`. |
| `GeoBoundingBox` | `{ west: number; south: number; east: number; north: number }`. `west > east` crosses the antimeridian. |
| `GeoPosition` | GeoJSON position, `[longitude, latitude]` or `[longitude, latitude, altitude]`. |
| `GeoJsonPoint` | GeoJSON Point. |
| `GeoJsonLineString` | GeoJSON LineString. A route's `geometry`. |
| `GeoJsonPolygon` | GeoJSON Polygon. |
| `GeoJsonMultiPolygon` | GeoJSON MultiPolygon. |
| `GeoGeometry` | Any of the four GeoJSON geometries above. |
| `MapViewport` | `{ latitude; longitude; zoom; bearing?; pitch? }`: map camera state. |
| `Meters` | A distance in metres (`number`). |
| `Seconds` | A duration in seconds (`number`). |

### Places

| Type | Description |
| --- | --- |
| `Place` | A GoWay place: `id`, default `name`, `location`, `categories`, `status`, `verification`, `sources`, `capabilities`, and optional `names`, `localizedName`, `geometry`, `address`, `contact`, `openingHours`, `timezone`, `hoursExceptions`, `description`, `descriptions`, `localizedDescription`, `logoFileId`, `coverFileId`, `rating`, `claims`, `createdAt`, `updatedAt`. |
| `PlaceWithDistance` | `Place` plus `distanceMeters`. |
| `PlaceId` | A stable GoWay place identifier (`string`), independent of provider ids. |
| `PlacePage` | `Page<Place>`. |
| `PlaceWithDistancePage` | `Page<PlaceWithDistance>`. |
| `PlaceBatch` | `{ items: Place[]; gone: PlaceBatchGone[]; missing: PlaceId[] }`. |
| `PlaceBatchGone` | `{ id; mergedInto? }`. |
| `PlaceBatchQuery` | `{ ids; locale? }`: the wire query of `getMany`. |
| `PlaceReadQuery` | `{ locale? }`: the wire query of `get`. |
| `NearbyPlacesQuery` | `{ latitude; longitude; radiusMeters; capabilities?; categories?; limit?; locale?; cursor? }`. |
| `PlacesInBoundsQuery` | `{ west; south; east; north; capabilities?; categories?; limit?; locale?; cursor? }`. |
| `PlaceCreateInput` | Body of `places.create`: `name`, `location`, and optional `names`, `geometry`, `categories`, `address`, `contact`, `openingHours`, `status`, `sources`, `capabilities`, `description`, `descriptions`. |
| `PlaceUpdateInput` | Body of `places.update`, a merge patch. Adds `openingHoursDays` to replace single days. |
| `PlaceStatus` | One of `PLACE_STATUSES`. |
| `WritablePlaceStatus` | One of `WRITABLE_PLACE_STATUSES`. |
| `ModeratedPlaceStatus` | One of `MODERATED_PLACE_STATUSES`. |
| `PlaceVerification` | `{ state: PlaceVerificationState; verifiedAt? }`. |
| `PlaceVerificationState` | One of `PLACE_VERIFICATION_STATES`. |
| `PlaceName` | `{ language; name; source }`. |
| `PlaceNameInput` | `{ language; name }`. |
| `PlaceDescription` | `{ language; description; source }`. |
| `PlaceDescriptionInput` | `{ language; description: string \| null }`. |
| `PlaceContact` | `{ phone?; email?; website? }`. |
| `PlaceContactPatch` | `PlaceContact` where `null` clears a field. |
| `StructuredAddress` | `{ houseNumber?; street?; locality?; city?; region?; postalCode?; countryCode?; country?; formatted? }`. |
| `StructuredAddressPatch` | `StructuredAddress` where `null` clears a field. |
| `PlaceSourceRef` | `{ source; sourceId; observedAt? }`: a record this place reconciles against. |
| `PlaceSourceRefInput` | `{ source; sourceId }`. |
| `PlaceRating` | `{ average; count }`. |
| `PlaceCapability` | One assertion: `namespace`, `capability`, `key`, `value`, `verification`, `observedAt`, `source?`. |
| `PlaceCapabilityAssertion` | `{ value; source? }`: body of `places.capabilities.put`. |
| `PlaceCapabilityInput` | A capability inside `PlaceCreateInput`/`PlaceUpdateInput`: `{ namespace; capability; value; source? }`. |
| `CapabilityKey` | A registered capability key. |
| `CapabilityValue` | `string \| number \| boolean \| string[]`. |
| `CapabilityValueKind` | One of `CAPABILITY_VALUE_KINDS`. |
| `CapabilityVerification` | One of `CAPABILITY_VERIFICATIONS`. |
| `CapabilityGroup` | One of `CAPABILITY_GROUPS`. |

### Claims

| Type | Description |
| --- | --- |
| `PlaceClaim` | `{ id; placeId; role; state; oxyAccountId; claimedAt; decidedAt? }`. |
| `PlaceClaimInput` | `{ role: PlaceClaimRole; oxyAccountId? }`. |
| `PlaceClaimPage` | `Page<PlaceClaim>`. |
| `PlaceClaimRole` | One of `PLACE_CLAIM_ROLES`. |
| `PlaceClaimState` | One of `PLACE_CLAIM_STATES`. |
| `ClaimListQuery` | `{ limit?; cursor? }`. |
| `AccountClaimListQuery` | `{ oxyAccountId?; placeId?; limit?; cursor? }`. |

### Hours

| Type | Description |
| --- | --- |
| `OpeningHours` | `{ intervals: OpeningHoursInterval[]; raw? }`: the weekly schedule. |
| `OpeningHoursInterval` | `{ day: 0..6; opens; closes }`. |
| `OpeningHoursDayPatch` | `{ day; intervals: TimeRange[] }`: one day replaced by `places.update`. |
| `TimeRange` | `{ opens; closes }`. |
| `PlaceHoursException` | A dated closure or special hours: `id`, `placeId`, `startsOn`, `endsOn`, `closed`, `intervals`, `source`, `verification`, `observedAt`, `note?`. |
| `PlaceHoursExceptionInput` | `{ startsOn; closed; endsOn?; intervals?; note? }`. |
| `PlaceHoursExceptionPage` | `Page<PlaceHoursException>`. |
| `HoursExceptionListQuery` | `{ limit?; cursor? }`. |
| `OpeningFacts` | What `openingStatusAt` reads: `openingHours?`, `timezone?`, `hoursExceptions?`. |
| `OpeningStatus` | `{ state: 'unknown' }` or `{ state: 'open' \| 'closed'; localDate; nextChange?; exception? }`. |
| `OpeningChange` | `{ at; localDate; localTime }`: when the state next changes. |

### Categories

| Type | Description |
| --- | --- |
| `Category` | `{ key; parent; icon; status; label; labels }`. |
| `CategoryPage` | `Page<Category>`. |
| `CategoryListQuery` | `{ locale? }`. |
| `CategoryTaxonomy` | The index `categoryTaxonomy` returns. |
| `CategoryIcon` | One of `CATEGORY_ICONS`. |
| `CategoryStatus` | One of `CATEGORY_STATUSES`. |
| `CategoryCreateInput` | Body of `moderation.createCategory`. |
| `CategoryUpdateInput` | Body of `moderation.updateCategory`. |
| `CategoryLabelInput` | `{ label }`. |
| `ModerationCategory` | `Category` plus `position`, `osmTags` and timestamps. |
| `ModerationCategoryPage` | `Page<ModerationCategory>`. |

### Labels

| Type | Description |
| --- | --- |
| `LabelLanguage` | One of `LABEL_LANGUAGES`. |
| `Labels` | One label in every `LABEL_LANGUAGES` language. |
| `LocalizedLabels` | Labels keyed by language tag: `en` always, others as they exist. |

### Media and reviews

| Type | Description |
| --- | --- |
| `PlaceMedia` | A gallery item: `id`, `placeId`, `fileId` (an Oxy file), `kind`, `verification`, and more. |
| `PlaceMediaInput` | `{ fileId; kind; caption? }`. |
| `PlaceMediaOrderInput` | `{ mediaIds }`. |
| `PlaceMediaPage` | `Page<PlaceMedia>`. |
| `PlaceMediaKind` | One of `PLACE_MEDIA_KINDS`. |
| `PlaceMediaState` | One of `PLACE_MEDIA_STATES`. |
| `MediaListQuery` | `{ kinds?; limit?; cursor? }`. |
| `ModeratedPlaceMediaState` | One of `MODERATED_PLACE_MEDIA_STATES`. |
| `ModerationMediaInput` | `{ state }`. |
| `ModerationMediaListQuery` | `{ state?; limit?; cursor? }`. |
| `ModerationPlaceMedia` | `PlaceMedia` with its state and who added it. |
| `ModerationPlaceMediaPage` | `Page<ModerationPlaceMedia>`. |
| `PlaceReview` | `{ id; placeId; rating; authorOxyUserId; createdAt; title?; body?; locale?; ... }`. |
| `PlaceReviewWithStatus` | `PlaceReview` plus `status`. |
| `PlaceReviewPage` | `Page<PlaceReview>`. |
| `PlaceReviewWithStatusPage` | `Page<PlaceReviewWithStatus>`. |
| `PlaceReviewInput` | `{ rating; title?; body?; locale? }`. |
| `PlaceReviewReply` | `{ body; repliedAt; editedAt? }`. |
| `PlaceReviewReplyInput` | `{ body }`. |
| `PlaceReviewStatus` | One of `PLACE_REVIEW_STATUSES`. |
| `ModeratedPlaceReviewStatus` | One of `MODERATED_PLACE_REVIEW_STATUSES`. |
| `ReviewListQuery` | `{ sort?; limit?; cursor? }`. |
| `ReviewSort` | One of `REVIEW_SORTS`. |
| `ModerationReviewInput` | `{ status }`. |
| `ModerationReviewListQuery` | `{ status?; limit?; cursor? }`. |
| `ContentReportInput` | `{ reason: ContentReportReason; note? }`. |
| `ContentReportReason` | One of `CONTENT_REPORT_REASONS`. |

### Revisions, reports and moderation

| Type | Description |
| --- | --- |
| `PlaceRevision` | One entry of a place's public history. |
| `PlaceRevisionPage` | `Page<PlaceRevision>`. |
| `PlaceRevisionAction` | One of `PLACE_REVISION_ACTIONS`. |
| `PlaceRevisionChange` | `{ field; before?; after? }`. |
| `PlaceRevisionSource` | One of `PLACE_REVISION_SOURCES`. |
| `PlaceRevisionVisibility` | `'public' \| 'moderation'`. |
| `RevisionValue` | A JSON value in a revision change. |
| `RevisionListQuery` | `{ limit?; cursor? }`. |
| `ModerationPlaceRevision` | A revision with the account and person behind it. |
| `ModerationPlaceRevisionPage` | `Page<ModerationPlaceRevision>`. |
| `PlaceReport` | A report of a place, gallery item or review. |
| `PlaceReportInput` | `{ reason: PlaceReportReason; note? }`. |
| `PlaceReportReason` | One of `PLACE_REPORT_REASONS`. |
| `PlaceReportState` | One of `PLACE_REPORT_STATES`. |
| `PlaceReportResolution` | One of `PLACE_REPORT_RESOLUTIONS`. |
| `PlaceReportResolutionInput` | `{ resolution }`. |
| `ModerationPlaceReport` | A report as an operator sees it. |
| `ModerationPlaceReportPage` | `Page<ModerationPlaceReport>`. |
| `ModerationReportListQuery` | `{ state?; limit?; cursor? }`. |
| `ModerationClaimListQuery` | `{ state?; limit?; cursor? }`. |
| `ModerationPlaceUpdateInput` | `{ status?; verificationState? }`. |
| `ModerationCapabilityInput` | `{ value }`. |
| `ClaimDecisionInput` | `{ state: ClaimDecisionState }`. |
| `ClaimDecisionState` | One of `CLAIM_DECISION_STATES`. |
| `DuplicateCandidate` | A pair of places that might be one. |
| `DuplicateCandidatePage` | `Page<DuplicateCandidate>`. |
| `DuplicateCandidateReason` | One of `DUPLICATE_CANDIDATE_REASONS`. |
| `DuplicateCandidateState` | One of `DUPLICATE_CANDIDATE_STATES`. |
| `DuplicateListQuery` | `{ state?; limit?; cursor? }`. |
| `DuplicateResolutionInput` | `{ decision: 'merge'; survivorPlaceId }` or `{ decision: 'reject' }`. |

### Search

| Type | Description |
| --- | --- |
| `SearchQuery` | `{ query; near?: GeoCoordinate; viewport?: GeoBoundingBox; capabilities?; categories?; limit?; locale?; cursor? }`. |
| `ReverseGeocodeQuery` | `{ latitude; longitude; radiusMeters?; limit?; locale?; cursor? }`. |
| `StructuredGeocodeQuery` | `{ street?; houseNumber?; city?; region?; postalCode?; countryCode?; limit?; locale?; cursor? }`. |
| `SearchResults` | `{ items: SearchResult[]; nextCursor; providers; degradedProviders? }`. |
| `SearchResult` | `{ id; displayName; kind; coordinate; source; boundingBox?; address?; context?; sourceId?; placeId?; place?; relevance? }`. |
| `SearchResultContext` | `{ city?; region?; country?; countryCode? }`. |
| `SearchResultKind` | One of `SEARCH_RESULT_KINDS`. |
| `SearchSource` | One of `SEARCH_SOURCES`, or another string. |

### Directions

| Type | Description |
| --- | --- |
| `RouteRequest` | `{ origin; destination; mode: TravelMode; waypoints?; alternatives?; locale?; vehicle?; exclude?; departureAt? }`. |
| `RouteLocation` | `{ coordinate?; placeId?; name? }`, with at least one of `coordinate` and `placeId`. |
| `RouteResponse` | `{ routes: Route[] }`, best first; may be empty. |
| `Route` | `{ id; mode; distanceMeters; durationSeconds; geometry: GeoJsonLineString; legs; zones }`. |
| `RouteLeg` | `{ distanceMeters; durationSeconds; maneuvers }`. |
| `RouteManeuver` | `{ type; instruction; distanceMeters; durationSeconds; coordinate; streetName?; geometryIndex? }`. |
| `ManeuverType` | One of `MANEUVER_TYPES`, or a newer string. |
| `TravelMode` | One of `TRAVEL_MODES`. |
| `RouteExclude` | One of `ROUTE_EXCLUDES`. |

### Cameras

| Type | Description |
| --- | --- |
| `Camera` | One camera: `id`, `providerId`, `name`, `kind`, `position`, `heading`, `roadName`, `media`, `status`, `lastFrameAt`, `attribution`, `licence`. |
| `CameraPage` | `Page<Camera>`. |
| `CameraListQuery` | `{ west; south; east; north; kind?; limit?; cursor? }`. |
| `CameraKind` | One of `CAMERA_KINDS`. |
| `CameraMedia` | What GoWay serves for the camera: `{ kind; refreshSeconds; width; height }`. |
| `CameraMediaKind` | One of `CAMERA_MEDIA_KINDS`. |
| `CameraStatus` | One of `CAMERA_STATUSES`; `unknown` means listed and no frame seen yet. |
| `CameraHealth` | One of `CAMERA_HEALTH`: whether the picture can be trusted. |
| `CameraObservation` | What the video worker counted in a window: `counts`, `present`, `flowPerMinute`, `congestion`, `health`. Aggregates only. |
| `CameraObservationPage` | `Page<CameraObservation>`. |
| `CameraObservationsQuery` | `{ since?; limit?; cursor? }`. |
| `CameraProvider` | A provider with its credit, licence, `redistribution` (`relay` or `catalogue-only`) and `cameraCount`. |
| `CameraProviderPage` | `Page<CameraProvider>`. |
| `CongestionLevel` | One of `CONGESTION_LEVELS`. |
| `ObservedClass` | One of `OBSERVED_CLASSES`. |

### Road rules

| Type | Description |
| --- | --- |
| `RoadRuleSet` | One country's rules: `countryCode`, `drivingSide`, `speedLimitsKmh`, `source`. |
| `RoadRuleSetPage` | `Page<RoadRuleSet>`. |
| `RoadRuleSetListQuery` | `{ limit?; cursor? }`. |
| `RoadRules` | `{ countryCode; ruleSet; zones }` at one position. |
| `RoadRulesQuery` | `{ latitude; longitude; country? }`. |
| `RoadZone` | A low emission, congestion charge or restricted access zone, with its `geometry`, `policy`, `schedule?` and `source`. |
| `RoadZonePage` | `Page<RoadZone>`. |
| `RoadZoneListQuery` | `{ west?; south?; east?; north?; country?; kind?; limit?; cursor? }`. |
| `RoadZoneKind` | One of `ROAD_ZONE_KINDS`. |
| `RoadZonePolicy` | `{ rules: RoadZoneRule[]; otherwise }`. |
| `RoadZoneRule` | `{ scheme; labels; decision; users? }`. |
| `RoadZoneVerdict` | What one zone says to one vehicle. |
| `RoadAccessInput` | `{ latitude; longitude; vehicle?; at? }`. `vehicle` defaults to `{ user: 'car' }`. |
| `RoadAccessDecision` | `{ decision; verdicts; at }`: the strictest decision among the zones covering a position, and each zone's verdict. |
| `RoadRuleSource` | `{ attribution; licence; retrievedAt }`. |
| `RoadRuleLink` | `{ label; href }`. |
| `VehicleProfile` | `{ user?; fuel?; standard?; electricRangeKm?; labels? }`. |
| `VehicleUser` | One of `VEHICLE_USERS`. |
| `VehicleFuel` | One of `VEHICLE_FUELS`. |
| `EmissionStandard` | One of `EMISSION_STANDARDS`. |
| `EnvironmentalLabelScheme` | One of `ENVIRONMENTAL_LABEL_SCHEMES`. |
| `ZoneDecision` | One of `ZONE_DECISIONS`. |
| `DrivingSide` | One of `DRIVING_SIDES`. |
| `ImplicitSpeedClass` | One of `IMPLICIT_SPEED_CLASSES`. |

### Live (HTTP)

The socket message types are in [`@goway.to/sdk/live`](./live.md).

| Type | Description |
| --- | --- |
| `LiveSource` | One feed: `id`, `kind`, `name`, `attribution`, `licence`, `coverage`, `completeness`, `status`, `lastUpdatedAt`, `pollIntervalSeconds`, `staleAfterSeconds`, `dropAfterSeconds`, `entityCount`. |
| `LiveSourcePage` | `{ items: LiveSource[]; nextCursor }`. |
| `LiveSourceStatus` | `'idle' \| 'starting' \| 'live' \| 'stale' \| 'unavailable'`. |
| `LiveShape` | An operator's route shape: `sourceId`, `id`, `coordinates`, `alongMeters`, `lengthMeters`. |
| `LiveLink` | `{ label; href }`. |
| `LiveKind` | `'aircraft' \| 'transit' \| 'bikeshare' \| 'vessel'`. |
| `LiveEntity` | Any live entity. |
| `LiveAircraft` | An aircraft position. |
| `LiveTransitVehicle` | A public-transport vehicle. |
| `LiveTransitMode` | `'bus' \| 'tram' \| 'subway' \| 'rail' \| 'ferry' \| 'cable' \| 'other'`. |
| `LiveBikeshareStation` | A bike-share station and its availability. |
| `LiveVessel` | A ship position. |

### Captures

| Type | Description |
| --- | --- |
| `CaptureSession` | A contributor's capture session. |
| `CaptureSessionId` | A capture session id (`string`). |
| `CaptureSessionInput` | `{ source; consentVersion; note?; attribution?; startedAt? }`. |
| `CaptureSessionPage` | `Page<CaptureSession>`. |
| `CaptureAsset` | One contribution, with its state, privacy gate, anchor, location evidence and media. |
| `CaptureAssetId` | A capture asset id (`string`). |
| `CaptureAssetInput` | Body of `captures.register`: `mediaKind`, `source`, `contentHash`, `byteSize`, `contentType`, `location`, and more. |
| `CaptureAssetPage` | `Page<CaptureAsset>`. |
| `CaptureAssetState` | One of `CAPTURE_ASSET_STATES`. |
| `CaptureUploadTicket` | `{ asset; upload? }`. `upload` is absent when the bytes were already stored. |
| `CaptureUploadIntent` | `{ assetId; method: 'PUT'; url; headers; expiresAt; byteSize; contentType }`. Send `headers` verbatim. |
| `CaptureUploadPolicy` | Whether capture is enabled, the consent version, and accepted types and sizes. |
| `CaptureEquirectangularPolicy` | Size, duration and resolution ceilings for 360-degree media. |
| `CaptureListQuery` | `{ limit?; cursor? }`. |
| `CaptureAnchor` | The coordinate a capture is placed at, with its origin and witness. |
| `CaptureLocationEvidence` | One piece of location evidence. |
| `CaptureLocationEvidenceInput` | Location evidence as a client sends it. |
| `CaptureLocationOrigin` | One of `CAPTURE_LOCATION_ORIGINS`. |
| `CaptureLocationWitness` | One of `CAPTURE_LOCATION_WITNESSES`. |
| `CaptureCameraMetadata` | Optional camera and media metadata. |
| `CaptureContentHashAlgorithm` | `'sha256'`. |
| `CaptureMediaKind` | One of `CAPTURE_MEDIA_KINDS`. |
| `CaptureMediaObject` | The stored object: hash, size, type, deduplication and lifecycle. |
| `CaptureMotionInput` | `{ orientation; samples }`: gravity samples recorded with a capture. |
| `CaptureMotionOrientation` | One of `CAPTURE_MOTION_ORIENTATIONS`. |
| `CaptureMotionSample` | `{ t; gravity }`. |
| `CapturePrivacyGate` | `{ state; pipelineVersion?; completedAt? }`. |
| `CapturePrivacyState` | One of `CAPTURE_PRIVACY_STATES`. |
| `CaptureProjection` | One of `CAPTURE_PROJECTIONS`. |
| `CaptureRetentionClass` | One of `CAPTURE_RETENTION_CLASSES`. |
| `CaptureSource` | One of `CAPTURE_SOURCES`. |
| `ExifGps` | EXIF GPS latitude and longitude in degrees, minutes, seconds. |
| `RetentionClass` | One of `RETENTION_CLASSES`. |
| `RetentionReason` | One of `RETENTION_REASONS`. |
| `DeletionReason` | One of `DELETION_REASONS`. |
| `StoredObjectLifecycle` | Retention class and reason, storage and expiry times, deletion fields. |

### Street 3D

| Type | Description |
| --- | --- |
| `StreetCoverage` | `{ scenes: StreetSceneSummary[]; areas: StreetCoverageArea[] }`. |
| `StreetCoverageQuery` | `{ west; south; east; north }`. |
| `StreetCoverageArea` | An area that is not yet a published scene. |
| `StreetCoverageAreaState` | One of `STREET_COVERAGE_AREA_STATES`. |
| `StreetSceneSummary` | A published scene in a coverage answer. |
| `StreetSceneId` | A scene id (`string`). |
| `StreetSceneManifest` | The served manifest of one scene: bounds, footprint, assets, transform, navigation, quality. |
| `StreetSceneAsset` | `{ role; format; url; byteSize; sha256; ... }`. |
| `StreetSceneAssetFormat` | One of `STREET_SCENE_ASSET_FORMATS`. |
| `StreetSceneAssetRole` | One of `STREET_SCENE_ASSET_ROLES`. |
| `StreetSceneWorldTransform` | `{ anchor; frame: 'enu'; enuFromScene }`. |
| `StreetSceneInitialView` | `{ position; target }`. |
| `StreetSceneNavigation` | `{ viewpoints; fieldOfView? }`. |
| `StreetSceneViewpoint` | `{ position; forward }`. |
| `StreetSceneFieldOfView` | `{ horizontalDegrees; verticalDegrees }`. |
| `StreetSceneQuality` | Reconstruction profile and quality figures. |
| `StreetSceneProfile` | One of `STREET_SCENE_PROFILES`. |
| `StreetScenePrivacyBasis` | One of `STREET_SCENE_PRIVACY_BASES`. |
| `StreetSceneReport` | `{ id; sceneId; version; reason; createdAt }`. |
| `StreetSceneReportInput` | `{ reason; note? }`. |
| `StreetSceneReportReason` | One of `STREET_SCENE_REPORT_REASONS`. |

### Organization lists

| Type | Description |
| --- | --- |
| `OrganizationList` | `{ id; oxyAccountId; title; description; revision; createdAt; updatedAt }`. |
| `OrganizationListEntry` | `{ id; listId; placeId; activity; information; startsAt; endsAt; position; completedAt; status; timezone }`. |
| `OrganizationListInput` | `{ oxyAccountId; title; description? }`. |
| `OrganizationListUpdate` | `{ title; description? }`. |
| `OrganizationListEntryInput` | `{ placeId; activity; startsAt; endsAt; information? }`. `endsAt` must be after `startsAt`. |
| `OrganizationListQuery` | `{ oxyAccountId?; limit?; cursor? }`. |
| `OrganizationListEntryQuery` | `{ state?: 'active' \| 'all'; limit?; cursor? }`. |
| `OrganizationListOrderInput` | `{ revision; entryIds }`. |

### Saved lists

| Type | Description |
| --- | --- |
| `SavedList` | `{ id; name; visibility; isDefault; itemCount; coverPlaceIds; createdAt; updatedAt }`. `coverPlaceIds` holds at most `SAVED_LIST_COVER_PLACES` place ids, in order. |
| `SavedListPage` | `{ items: SavedList[]; nextCursor }`. |
| `SavedListItem` | `{ id; listId; placeId; note?; position; addedAt }`. `position` is an ordering key, not an index: removing an item leaves a gap and only a reorder renumbers. |
| `SavedListItemPage` | `{ items: SavedListItem[]; nextCursor }`. |
| `SavedListVisibility` | One of `SAVED_LIST_VISIBILITIES`. |
| `SavedListConflictReason` | One of `SAVED_LIST_CONFLICT_REASONS`. |
| `SavedListInput` | `{ name }`. |
| `SavedDefaultListInput` | `{ name }`: the name the default list is created with when you have none. |
| `SavedListUpdateInput` | `{ name }`. |
| `SavedListItemInput` | `{ placeId; note? }`. |
| `SavedListItemUpdateInput` | `{ note: string \| null }`; `null` clears the note. |
| `SavedListItemOrderInput` | `{ itemIds }`: 1 to `MAX_SAVED_LIST_ITEMS` distinct item ids. |
| `SavedListQuery` | `{ limit?; cursor? }`. |
| `SavedListItemQuery` | `{ limit?; cursor? }`. |
| `SavedPlacesQuery` | `{ placeIds }`: 1 to `MAX_SAVED_PLACES_LOOKUP` place ids. |
| `SavedPlaceHold` | `{ listId; itemId }`: one list of yours that holds a place, and the item that holds it there. |
| `SavedPlace` | `{ placeId; lists: SavedPlaceHold[] }`: every list of yours that holds the place, oldest list first. |
| `SavedPlaces` | `{ items: SavedPlace[] }`: the asked-for places you have saved, in the order asked. Not a page. |

### Transit

| Type | Description |
| --- | --- |
| `NearbyTransit` | `{ stops: TransitStop[]; operators: TransitOperator[]; generatedAt }`. `stops` are nearest first (at most 10); `operators` lists every operator covering the point, whether or not one of its stops was in range; departure times are relative to `generatedAt`. |
| `NearbyTransitQuery` | `{ latitude; longitude; radiusMeters?; maxStops?; maxDepartures? }`. `radiusMeters` is 50 to 1000 (default 400), `maxStops` 1 to 10 (default 5), `maxDepartures` 1 to 10 per stop (default 4). |
| `TransitStop` | `{ id; operatorId; name; position; distanceMeters; modes; lines; departures }`. `operatorId` is an `id` of `operators`; `distanceMeters` is the straight line from the requested point; `lines` holds at most 24; `departures` are soonest first and empty when nothing is due in the next six hours. |
| `TransitLine` | `{ id; shortName; longName; mode; color; textColor }`. The operator's own names and colours, `null` when it publishes none. `id` is opaque and unique within one stop. |
| `TransitDeparture` | `{ lineId; headsign; time; basis; delaySeconds? }`. `lineId` is the `id` of an entry in the stop's `lines`; `time` is the predicted time when `basis` is `realtime`; `delaySeconds` is present exactly then. |
| `TransitDepartureBasis` | `'scheduled' \| 'realtime'`: the operator's published timetable, or its own live prediction for that trip at that stop. |
| `TransitMode` | `'bus' \| 'tram' \| 'subway' \| 'rail' \| 'ferry' \| 'cable' \| 'other'`, the same vocabulary as `LiveTransitMode`. |
| `TransitOperator` | `{ id; name; attribution; licence; availability; realtime; scheduleReadAt; realtimeAt }`. `attribution` and `licence` are `LiveLink`s to show while its stops are drawn. `availability` is `ready`, `preparing` (ask again shortly) or `unavailable`; `realtime` is `none`, `live` or `unavailable` (every departure then `scheduled`). |

### 3D models

| Type | Description |
| --- | --- |
| `ModelPlacementInput` | A model placement as a caller writes it: `position`, and optional `altitude`, `orientation`, `scale`. |
| `ModelPlacement` | A placement with every default applied. |
| `ModelAltitudeReference` | `'ground'`. |

### Map styles and tiles

| Type | Description |
| --- | --- |
| `MapStyleId` | One of `MAP_STYLE_IDS`. |
| `MapLightPreset` | One of `MAP_LIGHT_PRESETS`. |
| `MapStyleLightKind` | One of `MAP_STYLE_LIGHT_KINDS`. |
| `MapStyleSelection` | `{ style: MapStyleId; preset: MapLightPreset }`. |
| `MapStyleDefinition` | One catalogue entry: `id`, `presets`, `light`, and optional flags. |
| `MapStyleIndex` | The parsed `index.json` catalogue: `{ v: 1; default; styles }`. |
| `AvailableFont` | One of `AVAILABLE_FONTS`. |
| `OpenMapTilesSourceLayer` | A source-layer name. |
