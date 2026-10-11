/**
 * THE one lazily-loaded chunk that carries three.js. Import it ONLY with
 * `import('@/components/engine3d/lazyChunk')`, never statically.
 *
 * ## Why both engines go through one module
 *
 * Expo's web serializer hoists any module reachable from TWO `import()`-ed
 * chunks into `/__common.js`, which it emits as an unconditional `<script>` in
 * the page — downloaded at first paint by every visitor (see
 * `~/Oxy/docs/build-and-runtime-traps.md` → "Metro web chunking"; there is no
 * opt-out). Street 3D's engine and the city-3D engine both import `three`.
 * Loaded through two separate `import()`s, three.js stopped being lazy at all:
 * measured with `expo export --platform web`, `__common` went from 78,516 B to
 * 912,807 B with the city-3D flag OFF — 834 KB of renderer on the first paint
 * of a page that never draws a 3D thing.
 *
 * With every three.js consumer re-exported from here, three.js is reachable
 * from exactly one async chunk and stays out of `__common`. The cost is that
 * opening either 3D feature downloads both engines (Spark included). That is
 * the right side of the trade while the city layer is a prototype; a
 * dedicated "three runtime" chunk both engines share is the cleaner end
 * state, and `docs/MAP_3D_CITY.md` records it.
 *
 * GoWay Live's 3D pass (`map/engine/live3d/livePass.ts`) is drawn BY the city
 * engine's renderer, so it rides in this chunk too.
 *
 * `components/__tests__/engine3dChunk.test.ts` fails if anything else starts
 * importing `three` or reaching either engine directly.
 */
export { createSceneEngine } from '../street3d/engine/sparkEngine';
export { createCityEngine } from '../map/engine/city3d/cityEngine';
export { createCityLife } from '../map/engine/cityLife/lifeRenderer';
// GoWay Live's 3D shapes: a pass of the city engine, so the same chunk.
export { createLivePass } from '../map/engine/live3d/livePass';
