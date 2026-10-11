/**
 * THE one lazily-loaded chunk of the flyover feature. Import it ONLY with
 * `import('@/features/flyover/lazy')`, never statically.
 *
 * Two screens open the feature — the directions planner's "Fly the route"
 * (`ExploreScreen`) and Camera Studio (`app/studio.tsx`) — and both use the
 * camera modules in `lib/map/camera/`. Imported through two separate
 * `import()`s, those shared modules would be hoisted by Expo's web serializer
 * into the first-paint `__common` chunk, downloaded by every visitor with the
 * flag off (`components/engine3d/lazyChunk.ts` tells that story for
 * three.js). Re-exported from one module, they are reachable from exactly one
 * async chunk. `components/__tests__/flyoverChunk.test.ts` pins it.
 */
export { RouteFlyover } from './RouteFlyover';
export { StudioScreen } from './studio/StudioScreen';
