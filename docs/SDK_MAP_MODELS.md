# 3D models on the map

*Design note. **Phase 1 (web) is built**, off by default, behind the flyover
flag — see [Phase 1 status](#phase-1-status) and
[`MAP_CAMERA_STUDIO.md`](./MAP_CAMERA_STUDIO.md). It proposes what `@goway.to/sdk` and GoWay's map
surface should offer for 3D models anchored at real coordinates. The map seam it
extends is `packages/frontend/components/map/` (`types.ts`, `shared.ts`, the two
`MapCanvas` forks); the wire primitives it builds on are
`packages/contracts/src/geo.ts` and, for precedent, `src/street3d.ts`. The
rendering engine is shared with the 3D city proposal in
[`MAP_3D_CITY.md`](./MAP_3D_CITY.md), whose web prototype
(`components/map/engine/city3d/`, off by default) is the engine this note's
model layer joins.*

The prompt for this note is [munim-maps](https://github.com/munimtechnologies/munim-maps)
(Apache-2.0, `0.5.2` on npm at the time of writing): one React Native API over
MapKit, Google Maps, Mapbox, MapLibre and Cesium, with glTF/USDZ models placed at
coordinates. Much of its model API is good and is borrowed below. Its central
idea, one API over five vendors' engines, is incompatible with GoWay, and the
reasons are given in [Not adopted](#not-adopted-and-why).

## What exists today

Verified against `main` (`55614bc`), before phase 1 (see [Phase 1 status](#phase-1-status) for what has since been built).

| Piece | State |
| --- | --- |
| `@goway.to/sdk` | **Headless.** `0.3.0` in the repo; its only runtime dependency is `zod`. It exports the API client, typed errors, pagination, links and contract types. It ships no component, no renderer and no map primitive (`packages/sdk/src/index.ts`, `package.json`). |
| `packages/contracts` | Has `GeoCoordinate`, `GeoPosition` (GeoJSON, longitude first, optional elevation), bounding boxes, GeoJSON geometries and a `MapViewport` *interface* that is not a schema. It has nothing about models, altitude references or orientation. Street 3D's `worldTransform` (an anchor with `altitudeMeters`, plus an ENU 4×4) is the only published 3D placement. |
| The map seam | `components/map/` inside the app, not published. `MapCanvasProps` has `markers` (DOM or native views), `overlays` (GeoJSON `line`/`fill`/`circle` with neutral paint), camera, press and label events. It has nothing in 3D except the camera's `pitch`. `MapCanvas.web.tsx` uses `maplibre-gl` `6.10.0` and `MapCanvas.native.tsx` uses `@maplibre/maplibre-react-native` `^11.4.0`. Both render `MapBrand` and `MapAttribution` unconditionally. |
| How consumers get a map | [`integration/merchant-discovery.md`](integration/merchant-discovery.md#render-the-merchants) gives three options: vendor the seam, draw `Place.location` with your own renderer, or hand off to `goway.to`. |
| The embed | `app/frame.tsx`, which `lib/map/embed.ts` parses: camera, at most 20 `marker=` points, `place=`, `interactive=0`, `theme=`. It deliberately accepts no GeoJSON and no style overrides. |
| 3D in the style | A single `fill-extrusion` layer (`lib/map/style/buildings3d.ts`). There is no `raster-dem`, no terrain and no globe, so the map is flat Web Mercator. |
| three.js | Already a frontend dependency (`three` `0.186.1`) for the Street 3D viewer (`components/street3d/engine/sparkEngine.ts`) and the city-3D prototype (`components/map/engine/city3d/cityEngine.ts`). Both are reached ONLY through one lazy module, `components/engine3d/lazyChunk.ts` — see [Download](#performance-budgets-proposed-to-be-measured-in-phase-1). |
| Native 3D hooks | `maplibre-react-native` 11.4 has no custom-layer API. Its layer components cover the style-spec types (fill, line, symbol, circle, heatmap, fill-extrusion, raster, background), and there is nothing to draw into its GL/Metal context. MapLibre GL JS 6.10 has `CustomLayerInterface`, and with `renderingMode: '3d'` it shares the depth buffer with the other layers. |

The consumers named below don't use GoWay's map today. Moovo draws with
`react-native-maps` on native and `maplibre-gl` `5.24.0` on web, and nothing in
its tree references `@goway.to/sdk`. Homiio runs its own MapLibre GL JS `6.10.0`
document inside a `react-native-webview` on native and an `<iframe>` on web
(`Homiio/packages/frontend/components/mapDocument.ts`). Its one GoWay touchpoint
is a planned GeoIP file distribution. **A model API in GoWay therefore reaches
nobody until the map itself is consumable.** That is phase 0 below, and it isn't
optional.

## Who would use it

- **Moovo: vehicles.** Moovo's fleet has a closed type set,
  `['bike', 'scooter', 'car', 'van', 'truck']`
  (`Moovo/packages/backend/src/db/schema/valueSets.ts`). Its three apps show
  couriers, pickups and dropoffs, today as 2D pins (`fleet-dashboard`'s
  `MapMarker.kind`). A heading-aware vehicle model in the tracker and fleet
  console is the most concrete case. Courier positions are Moovo's data. They
  reach the map as client props and never enter a GoWay request (see
  [Privacy](#privacy)).
- **Homiio: buildings, weakly.** The useful thing is "this is the building",
  and the 3D city engine already answers that by highlighting the extruded
  footprint. That needs no model asset. A developer-supplied massing model for a
  new-build development is plausible but has no source in Homiio today. It is
  treated as speculative and only shapes the place-attached tier (phase 4).
- **GoWay itself:** a place's own model (a landmark, a station entrance), and
  Street 3D handoff markers. Both are later and both are place-attached.
- **Mercaria, FairCoin, Mention:** no real case was found. A store or a
  merchant is a Place shown as a marker, and a 3D shopfront adds nothing the
  marker doesn't already say. They are left out on purpose.

## What munim-maps gets right, and what GoWay takes

| munim-maps | GoWay decision |
| --- | --- |
| `MapModel`: `coordinate`, `altitude`, `altitudeReference: 'ground' \| 'sea'`, `heading`, `scale`, `source`, `visible` | **Adopt the shape, tighten it.** Add `pitch` and `roll` (munim-maps has heading only, which isn't enough for a vehicle on a ramp or a model authored lying down). Altitude reference starts as `'ground'` only, because GoWay has no DEM (see [Altitude](#frames-and-conventions)). |
| `screenSize`: stay N points tall at any zoom | **Adopt** as `sizing: { mode: 'screen', heightPx }`. A vehicle at city zoom is a marker that happens to be 3D. |
| `tint` recolours materials named `paint…` | **Adopt the same convention**, so one asset works in both libraries. It is a client prop, never a wire field. |
| `occlusion="buildings"`, which synthesises building depth from OpenMapTiles tiles because MapKit doesn't share its depth buffer | **Adopt the behaviour, not the mechanism.** In MapLibre GL JS a `'3d'` custom layer *shares* the depth buffer with `fill-extrusion`, so buildings occlude models with no extra tiles and no second building source. The mechanism only returns if a native overlay renderer is chosen (phase 3). |
| `motion` keyframes interpolated per frame, natively | **Adopt for phase 2**, on the client. It is what makes a live courier move smoothly between 5-second updates. |
| `onModelPress(id)`, a layer that never takes gestures | **Adopt.** It slots into `MapCanvas`'s existing hit priority (see [Client props](#client-props)). |
| A vehicle catalogue on a CDN, cached on device, or bundled per model | **Adopt the idea, not the catalogue.** GoWay hosts its own small licensed set (phase 2). munim-maps-vehicles says Apache-2.0 at the package level, but the provenance of each of the 57 models has not been verified, and GoWay ships only assets whose licence it has checked (the same rule as Street 3D fixtures in [`STREET3D_VIEWER.md`](STREET3D_VIEWER.md#configuration)). |
| `MapModelLayer` drawn over someone else's map (react-native-maps, expo-maps, `@rnmapbox/maps`), matched to that engine's camera to under a point | **Reject** (see below). |
| `provider=` over MapKit, Google, Mapbox, MapLibre and Cesium | **Reject** (see below). |
| Typed per-engine escape hatches (`maplibreCommands(ref)`, `providerCommand`, `onProviderEvent`) | **Reject** (see below). |
| USDZ, USD, SCN, OBJ, PLY, STL and Alembic, plus glTF | **Reject.** GLB only (see [Assets](#assets-one-format)). |
| A react-native-maps migration table | **Not needed.** GoWay's own migration story is `MapMarker`, and a `MapModel` is designed to read as one. A short table goes in the consumer guide once the prop exists. |
| People in buildings: avatars at a friend's real floor height | **Reject as a product.** GoWay renders nobody's live position. The primitive (a camera-facing billboard at an altitude) is still possible for a consumer's own data. |

## The API

Two layers, split by whether the data ever crosses GoWay's wire:

- **Wire data** is a zod schema in `packages/contracts`. That covers an asset
  descriptor GoWay serves, the placement of a model GoWay serves, and the
  catalogue list. The backend validates with it, the SDK parses with it, and it
  is never a Drizzle row or a three.js type.
- **Client props** belong to the map component. That covers sizing, zoom
  window, occlusion, tint, the press handler and the 2D fallback. These are
  renderer behaviour, not data, so they aren't contracts. They reuse the
  contract types for any field that is also wire data, so there is one spelling
  of a placement and not two.

### Wire: contracts (proposed `packages/contracts/src/model.ts`)

```ts
/** Only 'ground' until GoWay has a DEM. Adding a value is a breaking change for exhaustive switches; see Open questions. */
export const MODEL_ALTITUDE_REFERENCES = ['ground'] as const;

export const modelPlacementSchema = z.object({
  /** The model's origin (see Frames). GoWay's object spelling, never a positional pair. */
  position: geoCoordinateSchema,
  altitude: z
    .object({ meters: z.number().min(-500).max(10_000), reference: z.enum(MODEL_ALTITUDE_REFERENCES) })
    .default({ meters: 0, reference: 'ground' }),
  /** Degrees. heading: clockwise from north, as MapViewport.bearing. */
  orientation: z
    .object({
      heading: z.number().min(0).lt(360).default(0),
      pitch: z.number().min(-90).max(90).default(0),
      roll: z.number().min(-180).max(180).default(0),
    })
    .default({}),
  /** Uniform; the asset is authored in metres. */
  scale: z.number().positive().max(1_000).default(1),
});

export const MODEL_ASSET_ROLES = ['full', 'lite'] as const; // as street3d's splat / splat_preview

export const modelAssetFileSchema = z.object({
  role: z.enum(MODEL_ASSET_ROLES),
  format: z.literal('glb'),
  url: httpsUrlSchema, // street3d.ts's HTTPS-or-loopback rule, moved to a shared module
  byteSize: z.number().int().min(1).max(MAX_MODEL_FILE_BYTES),
  sha256: sha256HexSchema,
  triangles: z.number().int().min(1),
});

export const modelAssetSchema = z.object({
  id: z.string().min(1), // opaque, stable
  files: z.array(modelAssetFileSchema).min(1), // exactly one 'full'
  /** Axis-aligned bounds in the asset's own metres, so a client can size and cull before downloading. */
  boundsMeters: z.object({ min: vector3Schema, max: vector3Schema }),
  /** SPDX id of the asset's licence, and the credits it obliges. */
  license: z.string().min(1),
  attributions: z.array(z.string().min(1)),
});
```

What GoWay would serve with it:

- **Phase 2:** `GET /models/catalogue` returns
  `{ items: ModelCatalogueEntry[], nextCursor }`. Each entry is
  `{ key, label, asset }`, where `key` is a namespaced string like
  `vehicle.car`. The list is paged as `~/Oxy/docs/api-conventions.md` requires,
  even though it is small, because a list that starts without a cursor can't
  add one without breaking its consumers. The labels follow
  [`LABEL_TRANSLATIONS.md`](LABEL_TRANSLATIONS.md): every `LABEL_LANGUAGES`
  language, and they are read through `localizedLabel`.
- **Phase 4:** a place's model is part of the place read, as
  `{ asset, placement }`. Its route is designed with the media rules (see
  [Hosting](#hosting-who-stores-what-and-who-pays)).

Errors are the shared closed codes. An unknown catalogue key is `not_found`, and
a withdrawn asset is `gone`. No error `details` ever carries a coordinate.

### Client props

```ts
/** Feature code builds these, the same way it builds a MapMarker. */
export interface MapModel {
  id: string;
  placement: ModelPlacementInput; // z.input<typeof modelPlacementSchema>: altitude, orientation, scale optional
  asset:
    | { kind: 'catalogue'; key: string } // resolved through the SDK and cached
    | { kind: 'served'; asset: ModelAsset } // e.g. a place's model, as the API returned it
    | { kind: 'url'; url: string; sha256?: string }; // the consumer's own GLB, on its own host
  /** 'world' (default): true metres. 'screen': at least heightPx tall, as munim-maps' screenSize. */
  sizing?: { mode: 'world' } | { mode: 'screen'; heightPx: number };
  /** Outside this zoom window the model is not drawn and `fallback` is. */
  minZoom?: number;
  maxZoom?: number;
  /** 'buildings' (default) hides it behind extrusions; 'none' always draws it, e.g. the selected vehicle. */
  occlusion?: 'buildings' | 'none';
  /** CSS colour applied to materials named `paint…`. */
  tint?: string;
  /** Required: a model is never information only the GPU has. */
  accessibilityLabel: string;
  /** What is drawn wherever the model is not (zoom window, unsupported device, native in phase 1, a failed load). */
  fallback?: Pick<MapMarker, 'kind' | 'label'>;
  /** Phase 2: keyframes the renderer interpolates per frame. */
  motion?: { start: string /* ISO-8601 */; keyframes: readonly ModelKeyframe[] };
}

// MapCanvasProps gains:
models?: readonly MapModel[];
onModelPress?: (model: MapModel) => void;
```

Rules that come with it:

- **A model always degrades to a marker.** The `fallback` is a plain
  `MapMarker` at `placement.position`, drawn through the existing marker path.
  A screen reader, a device with no WebGL2, the native fork in phase 1 and a
  404ing asset all get the same truthful pin. This is the Street 3D
  `deviceProfile.ts` stance (`unsupported` → poster) applied to the map.
- **The contract schema is the NaN gate.** `shared.ts` already refuses
  non-finite coordinates before they reach an engine (`drawableMarkers`). A
  `drawableModels` does the same thing by `safeParse`-ing each placement against
  `modelPlacementSchema`. A bad model costs that model only, not the canvas.
- **Hit priority** becomes: marker, then model, then basemap label, then bare
  map. Markers are DOM or native views, so they stay on top. A model is hit by a
  raycast against its bounds, not its triangles, because tapping a 3 m car on a
  phone has to be forgiving.
- **Coordinates stay objects.** `placement.position` is `{ latitude,
  longitude }`. The one conversion to the engine's order happens in `shared.ts`,
  as for every other primitive.

### Frames and conventions

- **Asset frame:** glTF's own conventions, so nothing is guessed. The asset is
  right-handed in metres with +Y up, and its front faces +Z. At `heading: 0` the
  front faces north. The **glTF origin is the anchor**, and assets are authored
  with the origin at the base centre. munim-maps instead puts the lowest point
  on the ground at runtime. That is forgiving, but a model that has a wheel
  dropped below the chassis would move. The catalogue's ingest check enforces
  the authoring rule (`boundsMeters.min[1]` within a few centimetres of 0). For
  consumer URLs it is documented, not checked.
- **Orientation:** heading about local up, then pitch about the model's right
  axis, then roll about its forward axis (intrinsic yaw-pitch-roll in local
  East-North-Up). Bearing on `MapViewport` is already clockwise from north, so
  heading means the same thing.
- **Altitude:** `'ground'` means metres above the drawn ground. On today's flat
  map that is the Mercator plane. Two more references are deliberately *not* in
  the first contract:
  - `'sea'` (geoid, as munim-maps' `altitudeReference: 'sea'`)
  - `'ellipsoid'` (WGS 84)

  Both need a DEM to subtract, and GoWay has none. munim-maps fetches AWS
  Terrarium tiles around each model for this, which tells a third party where
  the models are. The two references also differ. iOS reports altitude above
  mean sea level, and Android's `Location.getAltitude()` is documented as
  ellipsoidal (checked from memory of the platform docs, not re-verified here).
  So "the GPS altitude" is two different numbers, and a contract that has one
  `'sea'` would encode the confusion. Both references get added with a DEM
  (phase 5).
- **Precision:** three.js works in float32. Model matrices are built relative to
  a per-frame origin near the camera centre, not in absolute Mercator units,
  which jitter at street zoom.

### Assets: one format

**glTF 2.0 binary (`.glb`), and nothing else, for every GoWay-served asset and
every client prop.** The reasons:

- It is an open, royalty-free Khronos standard (ISO/IEC 12113:2022). It loads
  with three.js's `GLTFLoader` on web and with Filament's `gltfio` on Android,
  and it is what Cesium, Mapbox's model layer and munim-maps' own loader all
  read.
- It is one file. `.gltf` with side-car `.bin` and textures is a set of URLs,
  each one a CORS request and a separate cache entry.
- USDZ is the format iOS's SceneKit and RealityKit prefer. munim-maps' support
  matrix shows USD-family formats working only on iOS. Admitting USDZ would
  admit a format that one platform can draw and the other can't. If a native
  iOS renderer ever needs USDZ, GoWay converts on ingest and serves a second
  `files` entry. That is a pipeline detail. Consumers never author it.
- OBJ, PLY, STL, Alembic and SCN add no capability GoWay needs. OBJ arrives as
  a file set without PBR, and the others are interchange or authoring formats.

The **v1 profile** is a closed list of glTF extensions: `KHR_materials_unlit`,
`KHR_texture_transform`, `KHR_mesh_quantization` and `EXT_meshopt_compression`.
Draco and `KHR_texture_basisu` (KTX2) are deferred. Each needs a decoder
(WASM, transcoder) that has to be lazy-loaded and budgeted. munim-maps' own
loader supports neither, so assets shared with it would need a fallback anyway.
Animations are allowed, and the first clip loops, as in munim-maps. Morph
targets and skins are allowed on web, but whether a native renderer supports
them is open.

### Hosting: who stores what and who pays

| Tier | Where the bytes live | Who pays | Phase |
| --- | --- | --- | --- |
| **Consumer URL** (`asset.kind: 'url'`, e.g. Moovo's own vehicle set) | The consumer's host, or bundled in the consumer's app | The consumer | 1 |
| **GoWay catalogue** | A GoWay bucket behind a CDN with immutable, content-addressed keys. This is the Street 3D scene-bucket pattern ([`STREET3D_PIPELINE.md`](STREET3D_PIPELINE.md)), or the R2 origin the tiles already use (`lib/map/provider.ts`). | GoWay, bounded by keeping the catalogue small. Five Moovo vehicle classes of about 1 MB each is a rounding error next to tiles. | 2 |
| **Place-attached** | An **Oxy file**, as a place photo is ([`PLACE_MEDIA_REVIEWS.md`](PLACE_MEDIA_REVIEWS.md)). GoWay stores the id and never the bytes. | The uploader's Oxy storage | 4 |

Rules for every tier:

- **HTTPS only**, using the parser rule Street 3D already enforces. Web needs
  `Access-Control-Allow-Origin` on the asset host. Assets are fetched without
  credentials, so a model URL can't carry a session.
- **Immutable URLs, verified by `sha256`** where GoWay serves them. A client
  may then cache an asset for as long as it likes.
- **GoWay never proxies a consumer's model.** A model URL in a consumer's own
  app is that consumer's request, like a marker image.
- **No model parameter in the embed.** The reasons `lib/map/embed.ts` gives for
  refusing GeoJSON apply with more force here. A `model=URL` would make GoWay's
  frame fetch and execute a parser on a stranger's megabytes inside somebody
  else's page. The embed can show a *place's* model later, through `place=`,
  because GoWay already vetted it.
- **Licence travels with the asset.** `attributions` of models on screen are
  appended to `MapAttribution`, the one credit line, which `MapCanvas` renders
  and no screen can drop. Consumer URLs have no wire licence field, so the
  client prop needs an `attributions` field as well. That is an open question.

The place-attached tier has a conflict that has to be resolved before phase 4.
GoWay's media rule is that it **never fetches** an Oxy file, but a model that
nobody has validated can be a 200 MB file with a million triangles. Either Oxy
validates glTF on upload (size, triangle count, extension profile, and the
`model/gltf-binary` MIME type), or the rule needs an explicit, written
exception. Oxy's storage already *accepts* `model/gltf-binary`: it appears in
`oxy/packages/api` storage usage tests, counted under "other". Whether Oxy's CDN
serves it with the right `Content-Type` and CORS headers is **unverified**.

### Performance budgets (proposed; to be measured in phase 1)

| Budget | Value |
| --- | --- |
| `full` file | ≤ 2 MB and ≤ 50k triangles. Catalogue entries ≤ 1 MB. |
| `lite` file | ≤ 200 KB and ≤ 5k triangles. Used below a screen-height threshold and on `preview` devices. |
| Textures | ≤ 1024², at most 2 per asset |
| Per viewport | ≤ 20 distinct assets and ≤ 300 drawn instances. Repeated assets are drawn with `InstancedMesh`. Past the cap, the farthest models fall back to markers, the same screen-space capping the marker path does (`lib/goway/markers.ts`). |
| Frame | ≤ 4 ms of model work per frame on a mid-range phone. The layer redraws only when the camera moves or a model animates (`triggerRepaint`), never continuously. |
| Download | three.js and the model layer load by dynamic `import()` only when `models` is non-empty, and ONLY through `components/engine3d/lazyChunk.ts` — the model engine is re-exported from there, never imported from a lazy chunk of its own. A module two lazy chunks share is hoisted by Expo's serializer into the first-paint `__common` chunk: measured on the city-3D prototype, a second chunk importing `three` put 834 KB of renderer on every page load with the feature off ([`MAP_3D_CITY.md`](./MAP_3D_CITY.md#what-the-flag-costs-when-off)). `components/__tests__/engine3dChunk.test.ts` fails if anything else imports `three`. A map with no models pays nothing. |
| Device gate | Reuse `components/street3d/deviceProfile.ts`. `unsupported` gets markers only. `preview` gets `lite` files, pixel ratio 1 and no animations. |

## Rendering

### Web: one three.js custom layer, shared with the city

The model layer is a MapLibre GL JS `CustomLayerInterface` with
`renderingMode: '3d'`. A three.js `WebGLRenderer` is bound to the map's own
WebGL2 context (`autoClear` off, `resetState()` around every draw). It takes
its camera from `defaultProjectionData.mainMatrix`, and its positions from
`MercatorCoordinate.fromLngLat` relative to the per-frame origin.

**This is the same engine [`MAP_3D_CITY.md`](./MAP_3D_CITY.md) proposes for
buildings, not a second one.** One custom layer, one three.js renderer and one scene graph hold
both the city's meshes and these models. Two renderers on one GL context would
each need to save and restore state around the other. They would also mean two
copies of the same chunk and two sets of lights that disagree. The city-3D
prototype landed first, so the engine is `components/map/engine/city3d/` (its
host-neutral `cityEngine.ts`, behind the MapLibre adapter
`components/map/city3dLayer.web.ts`); models add a scene group to it, reuse its
centre-relative placement (`tileMath.ts`), and take the light it already
follows — the map's own `light`, i.e. the sun from `useSunLight`
(`components/map/city3dLight.ts`). Occlusion by buildings is free within that engine. With extrusions
drawn by MapLibre, it comes from the shared depth buffer. With city meshes drawn
by the shared scene, it comes from the scene itself. Below the zoom where
`buildings3d.ts` fades extrusions in, there is nothing to occlude with, and
models draw unoccluded.

munim-maps' MapLibre path does the same thing. It runs three.js `0.186.1`
inside MapLibre GL JS 5.24 inside a WebView. That is a useful existence proof,
and it pins the same three.js version as GoWay's frontend.

Only the web fork imports three.js. `types.ts` gains `MapModel` and nothing
renderer-shaped.

### Native: no good option yet, stated plainly

`maplibre-react-native` 11.4 can't host custom drawing, so every native option
costs something:

1. **The whole map in a WebView** running GL JS and the same engine. Street 3D's
   native viewer works this way ([`STREET3D_VIEWER.md`](STREET3D_VIEWER.md#native-strategy)),
   and so does Homiio's map, all of it. This gives one engine and identical
   output. The costs are WebView gesture feel, memory, a second map stack beside
   MapLibre Native, and switching renderers whenever models appear or
   disappear. `MapBrand` and `MapAttribution` stay native views over it,
   rendered by `MapCanvas`.
2. **A native overlay synced to MapLibre Native's camera**, which is munim-maps'
   `MapModelLayer` design: Filament on Android, SceneKit on Metal on iOS, and a
   transparent view reading the camera every frame. It feels native. The costs:
   GoWay would own a native module on two platforms, camera-matching would have
   to be measured as munim-maps measures it (to under a point), and with no
   shared depth, occlusion needs the synthesised building depth that munim-maps
   builds from tiles. munim-maps has no MapLibre React Native adapter, so there
   is nothing to reuse directly.
3. **Upstream:** a custom or model layer in MapLibre Native, exposed by
   `maplibre-react-native`. Whether MapLibre Native's custom-layer hook is
   usable on its current Metal and Vulkan backends is **unverified**. It is
   worth an upstream conversation before building (2).

Until one is chosen, native draws the `fallback` markers. That isn't a stub: it
is the same truthful pin every degraded device gets. The choice is made from
device benchmarks, as Street 3D's native renderer is (#14 Phase F). Whatever
wins, its native configuration comes from **`@oxy.so/app-preset`**, never from
GoWay's `app.config.js`. Today `app.config.js` lists the
`@maplibre/maplibre-react-native` plugin directly, and a model renderer must not
copy that pattern.

## Not adopted, and why

- **MapKit, Google Maps and Mapbox as engines.** AGENTS.md has every GoWay map
  carry the GoWay mark bottom-left and the data credit bottom-right, both drawn
  by `MapCanvas` with no prop to switch them off. (The one exception is
  `BrandedChromeProvider`, an opt-in for a surface whose own chrome already
  shows the logo. It isn't a prop and an embed can't use it.) These vendors draw
  their own logo and their own attribution, and their published terms require
  both to stay visible. That was not re-checked for this note. Two brands would
  then compete for the corners, and the GoWay one would be the one that has to
  give way. Beyond the corners:
  - The cartography would be theirs, so GoWay's style, tiles and labels
    disappear.
  - Each needs an API key and a billing account.
  - Each sees every viewport.
  - MapKit doesn't exist on Android.

  "MapLibre is a replaceable adapter" means GoWay can replace the engine with
  another one *it* controls. It doesn't mean GoWay can rent someone else's map.
  Cesium is open (Apache-2.0) and isn't excluded by the corners argument. It is
  excluded because it is a second globe engine with its own 13 MB runtime, for
  features (3D Tiles, CZML) that GoWay has no data for.
- **A model layer over someone else's map** (munim-maps' `MapModelLayer` over
  react-native-maps or `@rnmapbox/maps`). That would make GoWay a 3D plugin for
  Google's and Apple's maps. It would be a map GoWay draws on without the mark
  or GoWay's credit. It would also commit GoWay to matching each foreign
  engine's camera to the pixel through every release of that engine. A consumer
  that wants GoWay's models uses GoWay's map.
- **Per-engine escape hatches** (`maplibreCommands(ref)`, `providerCommand`).
  A typed hatch is a published MapLibre API under GoWay's name. The first
  consumer that calls `setPaintProperty` makes MapLibre irreplaceable, which is
  exactly what "feature code never imports the provider" prevents. Inside
  `components/map/` the forks already *are* the engine. A capability a consumer
  needs becomes a neutral prop, as `onLabelsChange` and `interaction` did.
- **Formats other than GLB, and munim-maps-vehicles wholesale** (see above).
- **Third-party terrain lookups.** A DEM GoWay hosts, or no `'sea'` reference
  at all.

## Privacy

- **A model's position is the consumer's data.** It's a client prop, drawn
  locally. No GoWay request carries it, and no GoWay log sees it, so a Moovo
  courier's position never reaches GoWay. Occlusion uses the tiles the map has
  already loaded. No terrain or building request is made per model.
- **GoWay renders no live person.** The catalogue is objects, not avatars, and
  nothing GoWay serves places an identifiable person at a coordinate.
- **A place-attached model is publication.** It goes through the same
  owner/public checks as a photo. Its revision says `model_added` and never
  holds the Oxy file id (AGENTS.md: no revision holds an Oxy file id). If a
  consumer deliberately shows a position as approximate, an exactly placed model
  there publishes the precision it withheld. The client prop can't know that,
  so the consumer guide has to say it.

## Phases

0. **A consumable map.** Publish the `components/map` seam (`MapCanvas`,
   `MapMarker`, `MapOverlay` and so on) where consumers can install it. The
   packaging is an open question below. Land the shared three.js engine with
   [`MAP_3D_CITY.md`](./MAP_3D_CITY.md)'s first slice.
1. **Web models.** Add the `models` prop on the web fork. It takes consumer
   URLs and catalogue keys stubbed to a fixture, with `'ground'` altitude,
   heading/pitch/roll, `sizing`, the zoom window, `occlusion`, `tint`,
   `onModelPress`, the marker fallback everywhere else, and the budgets above
   enforced. Gates:
   - an alignment test: a model's ground point against `map.project` within
     1 px at five cameras, the check munim-maps runs on device
   - the NaN-gate test
   - a bundle check that a map with no models loads no three.js
2. **Catalogue and motion.** Add `modelAssetSchema`, `GET /models/catalogue`,
   five licensed vehicles matching Moovo's types, and client-side `motion`
   interpolation. Moovo's tracker is the first consumer, behind its own flag.
3. **Native.** Benchmark WebView against a native overlay on the Street 3D
   device set, decide in a short note, and ship through `@oxy.so/app-preset`.
4. **Place-attached models.** Add Oxy-file models on places, moderation,
   revisions and the embed's `place=` showing them. This is blocked on the
   validation question above.
5. **Terrain.** Add a GoWay-hosted DEM, `raster-dem` in the style, and the
   `'sea'` and `'ellipsoid'` references.

## Phase 1 status

Built for the route flyover's vehicle ([`MAP_CAMERA_STUDIO.md`](./MAP_CAMERA_STUDIO.md)),
web only, off unless `EXPO_PUBLIC_MAP_FLYOVER` (or `?flyover=1` in development):

| Item | State |
| --- | --- |
| `modelPlacementSchema`, `MODEL_ALTITUDE_REFERENCES`, `parseModelPlacement` | In `packages/contracts/src/model.ts`, exported by the SDK. No asset schema (phase 2). |
| `models`, `onModelPress` on `MapCanvasProps`; `MapApi.moveModel` | Both forks. Native draws every model as its fallback marker. |
| Assets | `url` (HTTPS, this origin, or loopback) and `catalogue` keys from a stub (`lib/map/modelCatalogue.ts`, one model: `vehicle.car`). `served` is phase 2. |
| `'ground'` altitude, heading/pitch/roll, `sizing`, zoom window, `occlusion`, `tint`, fallback | Built. |
| Budgets | File size, triangles, distinct assets, instances enforced; `lite` files and the `deviceProfile` gate are not. |
| Engine | The city engine's scene, in a second custom layer on the same renderer above GoWay's overlays — see `MAP_CAMERA_STUDIO.md` → "Two layers, one renderer" for why, and the one deviation from "one scene". |
| Gates | NaN gate and frame tests (`components/map/__tests__/mapModels.test.ts`); alignment checked in a running build via `__gowayModelAlignment` (≤ 1e-8 px on settled frames) and against the host matrix in a unit test; bundle: three.js still loads only through `lazyChunk.ts` (`engine3dChunk.test.ts`), a map with no models requests none of it. |

## Open questions

- **Packaging.** Options:
  - A `@goway.to/sdk/map` subpath with optional peer dependencies. This keeps
    AGENTS.md's single integration boundary, and `import '@goway.to/sdk'` stays
    headless.
  - A separate package, which keeps the SDK's "one dependency: zod" promise
    literal.

  The seam depends on Bloom, NativeWind and the brand artwork, so either way the
  consumer inherits the Oxy frontend stack. Is that acceptable for non-Oxy
  consumers, or is the map Oxy-ecosystem-only?
- **Enum growth.** Adding `'sea'` to `MODEL_ALTITUDE_REFERENCES` breaks an
  exhaustive switch in an SDK consumer. Should closed value sets that are
  *expected* to grow be documented as open (`string` with known values)?
- **Consumer-URL credits.** Should `MapModel` carry `attributions`, so a CC-BY
  model a consumer supplies is credited in `MapAttribution`? Or is crediting the
  consumer's responsibility?
- **Who validates a place-attached model:** Oxy on upload, or GoWay by a
  narrowly scoped fetch that the media rule then allows?
- **Native renderer.** Is there MapLibre Native upstream interest in a
  custom/model layer, before GoWay builds and maintains a Filament plus
  SceneKit overlay?
- **Moovo's appetite.** Moovo would first have to move off `react-native-maps`
  and its own `maplibre-gl` 5.24 onto GoWay's map. That is a larger decision
  than vehicles and it belongs to Moovo. Nothing in the repos shows it is
  planned.
