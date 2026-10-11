# The model library

GoWay draws ONE set of 3D vehicles, vessels and people. City life's simulated
traffic (`MAP_CITY_LIFE.md`) and GoWay Live's real vehicles (`MAP_LIVE.md`)
both draw from it; there is no second, parallel model set, and a new consumer
reads this library rather than building shapes of its own.

| Piece | Where |
| --- | --- |
| Manifest schema, kinds, budgets | `packages/frontend/lib/map/modelLibrary.ts` |
| Licence record (shared with landmarks) | `packages/frontend/lib/map/assetLicence.ts` |
| Build | `packages/frontend/scripts/build-model-library.ts`, `scripts/library/` |
| Built assets | `packages/frontend/public/models/library/` (`manifest.json` + one GLB per model) |
| Runtime loader | `packages/frontend/components/map/engine/vehicles/library.ts` |
| Shader helpers | `packages/frontend/components/map/engine/vehicles/glsl.ts` |
| Tests | `components/map/__tests__/modelLibrary.test.ts`, `features/live/__tests__/fleets.test.ts` |

## The models

| Key | Kind | From | Near / far triangles |
| --- | --- | --- | --- |
| `vehicle.hatchback`, `.sedan`, `.suv`, `.taxi` | car | Kenney Car Kit 3.1 | ≤ 800 / ≤ 150 |
| `vehicle.van`, `vehicle.truck` | van, truck | Kenney Car Kit 3.1 | ≤ 800 / ≤ 150 |
| `vehicle.bus`, `vehicle.bus-double` | bus | GoWay (`scripts/library/bus.ts`) | 540 / 60, 596 / 84 |
| `tram.modern`, `tram.classic` | tram | Kenney Train Kit 1.1 | ≤ 1,200 / ≤ 150 |
| `train.commuter`, `train.double` | train | Kenney Train Kit 1.1 | ≤ 1,200 / ≤ 150 |
| `metro.car` | metro | Kenney Train Kit 1.1 | ≤ 1,200 / ≤ 150 |
| `vessel.ferry`, `.cargo`, `.liner`, `.tug`, `.fishing`, `.sailboat`, `.motorboat` | vessel | Kenney Watercraft Kit 2.1 | ≤ 1,200 / ≤ 150 |
| `aircraft.airliner` | aircraft | GoWay (`scripts/library/aircraft.ts`) | 320 / 136 |
| `person.female-b`, `-c`, `-d`, `-f`, `person.male-a`, `-b`, `-d`, `-f`, `person.wheelchair` | person | Kenney Mini Characters 1.0 | ≤ 600 / 48 |

The budgets are `MODEL_BUDGETS`, enforced by the schema: the build, the tests
and the app all refuse a model over them. About 1.1 MB in all.

Left out on purpose: police, ambulance, fire engine and every other emergency
or branded vehicle (an emergency vehicle on a simulated street claims an
emergency that is not happening), karts, and the police character.

## Licences

Every Kenney kit is CC0 1.0 — checked in each download's `License.txt` (the
build refuses a kit whose licence text does not say CC0) and on its page.
CC0 owes no credit; GoWay credits Kenney anyway, in Settings → About and on
`/attribution` (`lib/map/credits.ts` → `models`). The bus, double-decker and
airliner are GoWay's own geometry, CC0. Each manifest entry carries the
landmarks' licence record (`assetLicenceSchema`: SPDX id, method, author,
source, verification date, notes), its byte size and SHA-256, and
`public/models/LICENSE.md` lists the set.

The kits are never committed. To rebuild, download the four kits from
kenney.nl, unzip each into its own folder (`car-kit/`, `train-kit/`,
`watercraft-kit/`, `mini-characters/`) and run:

```sh
cd packages/frontend
bun scripts/build-model-library.ts --kits=<that folder>
```

## The build

Per model (`build-model-library.ts`):

1. **Read** the kit's GLB as data (`scripts/library/kenney.ts`, gltf-transform:
   positions, indices, UVs, skins, animation samplers — nothing executed). The
   kits colour by UV into one palette texture (`colormap.png`, decoded by the
   map scripts' own `decodePng`); each vertex takes its palette colour.
2. **Bake** a character's clips (walk and idle; the wheelchair user's push and
   sit) by skinning on the CPU: 8 walk frames and 4 idle frames.
3. **Fit** uniformly: vehicles to a real width, vessels to a real length,
   people to 1.7 m standing (the wheelchair user is scaled by the standing
   character, so the chair is to scale). Front +Z, standing on y = 0.
4. **Recolour** into the maquette palette. The kits shade with palette RAMPS,
   so the body's paint is the whole ramp of the most common saturated hue:
   it becomes the tintable `paint` material, each face keeping its shade as a
   grey the tint is multiplied by. Glass is one dark tint (the kits' light,
   blue-tinted greys above the waist). Everything else is tempered: a little
   desaturated, a little lifted.
5. **Decimate** with meshoptimizer (`simplifyWithAttributes`, colour as an
   attribute so colour borders survive) to the near budget; a vehicle's far
   level is the wheel-less model decimated to the far budget. A person's far
   level is four boxes (legs, torso, face, crown) in the colours most of each
   band wears: a character decimated to a few dozen triangles shatters.
6. **Write** with the landmarks' writer (`scripts/landmarks/glb.ts →
   writeModelGlb`): `near` and `far` nodes on one quantisation grid,
   `KHR_mesh_quantization` + `EXT_meshopt_compression`, `COLOR_0` vertex
   colours, a person's frames as morph targets on `near`.

## The asset profile (what a consumer may rely on)

- glTF frame: metres, +Y up, front +Z, +X the model's left, origin on the
  ground at the centre of its footprint. `size` in the manifest is
  `[width, height, length]` as built — the kits' toy proportions; stretch
  along the length to a real one if you need it (city life and Live do).
- Two levels of detail, `near` and `far`.
- `paint` (0/1): the tintable body. `color`: linear vertex colour; on paint,
  the kit's shade (a grey) to multiply the tint by.
- People only: `clips.move` and `clips.idle` (first frame, frame count,
  frames per second) into the frames.
- No textures, no lettering, no logos, no liveries but the paint you give it.

## Runtime API (`components/map/engine/vehicles/`)

Inside the three.js chunk only (`components/engine3d/lazyChunk.ts`).

```ts
import {
  loadModelLibrary,       // (options?) => Promise<Map<key, LibraryModel>>
  parseLibraryModel,      // (entry, bytes) => Promise<LibraryModel>
  createAnimationTexture, // (animation) => THREE.DataTexture
  type LibraryModel,      // { entry, near: LibraryLod, far: LibraryLod, animation? }
  type LibraryLod,        // { geometry: THREE.BufferGeometry, triangles }
  type LibraryAnimation,  // { vertexCount, frameCount, positions: Float32Array }
} from '../vehicles/library';
import { LIBRARY_GLSL } from '../vehicles/glsl';
```

- `loadModelLibrary({ keys?, baseUrl?, signal? })` fetches the manifest from
  the app's own origin (`/models/library/manifest.json`), validates it, then
  only the requested GLBs (each checked against its manifest size), and merges
  every primitive of a level into ONE indexed `BufferGeometry` (one draw per
  level) with `position`, `normal` (float, glTF frame, metres), `color` and
  `paint`. The caller owns the geometries and disposes them.
- `createAnimationTexture(model.animation)`: a person's frames as an RGBA32F
  texture, one row per frame, one texel per near vertex.
- `LIBRARY_GLSL` (GLSL ES 3.00): `libraryFrame(g)` turns the glTF frame into
  a map's x-forward, y-left, z-up frame (a cyclic swap: winding preserved);
  `libraryColour(color, paint, tintSrgb)`; `libraryPose(frames, clip, t)`
  reads a clip at time `t` by `gl_VertexID`, blending frames.

City life (`cityLife/lifeRenderer.ts`, `lifeShaders.ts`) draws each model as
an instanced near/far pair over shared instance buffers with the library's
GLSL. GoWay Live (`live3d/liveModels.ts → buildLiveModel(model, detail,
source)`) maps each live form to a library key (`LIVE_LIBRARY_KEYS`),
stretches it per axis to the fleet's real dimensions and bakes the fleet's
livery into vertex colours.
