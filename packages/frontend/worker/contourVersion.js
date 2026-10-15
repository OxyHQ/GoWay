/**
 * The version of what a contour tile HOLDS (`contours.js`): its levels, the
 * tracer's options and the tracer itself. It is in the tile's URL
 * (`/map/contours/<version>/{z}/{x}/{y}.pbf`, which the Outdoors documents
 * name through `lib/map/provider.ts`) and in the edge cache's key, because a
 * tile is cached for a year: a change to any of those that kept the URL would
 * leave a year of old tiles in browsers and at the edge, mixed with new ones
 * at the seams.
 *
 * Bump it with every such change. `worker/__tests__/contours.test.js` pins the
 * parameters' fingerprint to the version, so a change that forgets fails.
 *
 * Its own module, with no imports, because the app's first-paint bundle
 * reads it (`provider.ts`) and must not carry the tracer.
 */
export const CONTOUR_VERSION = 'v1';
