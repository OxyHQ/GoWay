/**
 * GoWay shared contracts.
 *
 * Everything here is provider-neutral on purpose. MapLibre, OpenFreeMap,
 * Photon, Nominatim, Valhalla, COLMAP and gsplat are replaceable adapters
 * behind these shapes; none of their native types appear in this package.
 *
 * This package is **private**. `@goway.to/sdk` bundles it so a published
 * consumer never resolves a `workspace:*` dependency, and the backend's
 * internal Drizzle/PostGIS schema is never published at all.
 */

export * from './geo';
export * from './place';
export * from './search';
export * from './routes';
export * from './errors';

/** Response shape of the backend health check. */
export interface HealthResponse {
  status: 'ok';
  service: string;
}
