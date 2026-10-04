/**
 * GoWay contracts — the single source of truth for the GoWay API.
 *
 * Every request, response, error code and closed value set is a zod 4 schema
 * here, and every type is `z.infer`/`z.input` of one. The backend validates
 * requests with these schemas, `@goway.to/sdk` parses responses with them, and
 * the OpenAPI document and JSON Schemas are generated from them. There is no
 * second definition anywhere to drift from this one
 * (`~/Oxy/docs/api-conventions.md`).
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
export * from './language';
export * from './time';
export * from './pagination';
export * from './query';
export * from './errors';
export * from './place';
export * from './revision';
export * from './moderation';
export * from './capture';
export * from './street3d';
export * from './search';
export * from './directions';
export * from './health';
export * from './json-schema';
export * from './base-path';
export * from './operations';
export * from './openapi';
