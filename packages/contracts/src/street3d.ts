/**
 * GoWay Street 3D — the public contract for published scenes and coverage.
 *
 * A scene is DERIVED, published work: a versioned Gaussian representation of a
 * stretch of street, reconstructed from privacy-cleared contributions. It
 * outlives the temporary media it was built from, and nothing in these shapes
 * points back at that media — no capture id, no object key, no contributor.
 *
 * The reconstruction stack (SfM, trainer, compression) is an internal,
 * replaceable implementation. What is published here is the result: where the
 * scene is, how it maps onto the world, where its assets are and how much to
 * trust it.
 */

import { z } from 'zod';
import { boundingBoxWidth, geoBoundingBoxSchema, geoCoordinateSchema } from './geo';
import { instantSchema } from './time';

/** A stable GoWay Street 3D scene identifier. */
export type StreetSceneId = string;

/**
 * How much reconstruction effort a version received.
 *
 * `draft` is a fast, bounded reconstruction; `standard` is the normal
 * published budget. Higher tiers are added when usage justifies them.
 */
export const STREET_SCENE_PROFILES = ['draft', 'standard'] as const;
export type StreetSceneProfile = (typeof STREET_SCENE_PROFILES)[number];

/**
 * HTTPS, with one exception: plain HTTP on a loopback host. Such a URL can only
 * ever reach the machine the client runs on, so it downgrades nothing; it is
 * what a local development server for scene assets looks like.
 */
const HTTPS_OR_LOOPBACK_HTTP = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/)/;

/** An immutable, content-addressed HTTPS URL (or a loopback HTTP one). */
const httpsUrlSchema = z.string().regex(HTTPS_OR_LOOPBACK_HTTP, 'must be an HTTPS URL');

/** A point or direction in scene space: three finite numbers. */
const vector3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** A GeoJSON polygon footprint, positions longitude first. */
const footprintSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(z.array(z.number()).min(2).max(3))),
});

/** The asset roles a published version carries. */
export const STREET_SCENE_ASSET_ROLES = ['splat', 'splat_preview', 'poster'] as const;
export type StreetSceneAssetRole = (typeof STREET_SCENE_ASSET_ROLES)[number];

/**
 * One downloadable asset of a published version.
 *
 * `url` is immutable for the life of the version: the key is content-hashed, so
 * a client may cache it indefinitely and verify it with `sha256`. A disabled
 * version stops being served; its URL then answers an error, never other bytes.
 */
export const streetSceneAssetSchema = z.object({
  role: z.enum(STREET_SCENE_ASSET_ROLES),
  /** `spz` for Gaussian splats, `jpeg` for the poster. */
  format: z.enum(['spz', 'jpeg']),
  url: httpsUrlSchema,
  byteSize: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a lower-case hex SHA-256 digest'),
  /** Gaussian count, for splat roles. */
  gaussians: z.number().int().min(0).optional(),
});
export type StreetSceneAsset = z.infer<typeof streetSceneAssetSchema>;

/**
 * How scene coordinates map onto the world.
 *
 * Scene space is metric. `enuFromScene` is a column-major 4×4 similarity that
 * takes a scene point to local East-North-Up metres around `anchor`. A consumer
 * placing a WGS 84 coordinate in the scene converts it to ENU around the anchor
 * and applies the inverse.
 */
export const streetSceneWorldTransformSchema = z.object({
  anchor: geoCoordinateSchema.extend({ altitudeMeters: z.number() }),
  frame: z.literal('enu'),
  /** Column-major 4×4. */
  enuFromScene: z.array(z.number()).length(16),
});
export type StreetSceneWorldTransform = z.infer<typeof streetSceneWorldTransformSchema>;

/** Why a consumer should, or should not, trust the scene's placement and look. */
export const streetSceneQualitySchema = z.object({
  profile: z.enum(STREET_SCENE_PROFILES),
  /** Share of input frames whose cameras were solved, 0–1. */
  registrationRatio: z.number().min(0).max(1),
  /** Median distance between solved cameras and their position priors, in metres. */
  alignmentResidualMeters: z.number().min(0),
  /** Held-out reconstruction quality, in dB. Higher is better. */
  heldOutPsnr: z.number(),
  /**
   * `precise` when alignment residual is within the configured tolerance;
   * `approximate` otherwise. An approximate scene must not be presented as
   * exactly placed on the map.
   */
  placement: z.enum(['precise', 'approximate']),
});
export type StreetSceneQuality = z.infer<typeof streetSceneQualitySchema>;

/** The camera a viewer opens on, in scene coordinates. */
export const streetSceneInitialViewSchema = z.object({
  position: vector3Schema,
  target: vector3Schema,
});
export type StreetSceneInitialView = z.infer<typeof streetSceneInitialViewSchema>;

/** A position imagery was captured from, in scene coordinates. */
export const streetSceneViewpointSchema = z.object({
  position: vector3Schema,
  /** Approximate unit direction the camera faced. */
  forward: vector3Schema,
});
export type StreetSceneViewpoint = z.infer<typeof streetSceneViewpointSchema>;

/** The angular extent of the source imagery, in degrees. */
export const streetSceneFieldOfViewSchema = z.object({
  horizontalDegrees: z.number().min(1).max(179),
  verticalDegrees: z.number().min(1).max(179),
});
export type StreetSceneFieldOfView = z.infer<typeof streetSceneFieldOfViewSchema>;

/**
 * Where a viewer can move without leaving observed space.
 *
 * `viewpoints` are positions imagery was captured from, in scene coordinates
 * (metric ENU, z up). They are decimated and merged across every contribution
 * the version was built from, and carry no timestamp, no per-contributor order
 * and no identity: they say where the scene was seen from, not who walked
 * where, or when.
 *
 * A Gaussian scene is only trustworthy from where it was observed. A viewer
 * should keep the camera near these positions and its view within the captured
 * `fieldOfView` — moving between viewpoints Street-View-style rather than
 * flying freely — because unobserved space renders poorly.
 */
export const streetSceneNavigationSchema = z.object({
  viewpoints: z.array(streetSceneViewpointSchema),
  fieldOfView: streetSceneFieldOfViewSchema.optional(),
});
export type StreetSceneNavigation = z.infer<typeof streetSceneNavigationSchema>;

/** A published scene version, as a viewer needs it. */
export const streetSceneManifestSchema = z.object({
  id: z.string().min(1),
  /** Monotonic per scene. A newer version supersedes an older one. */
  version: z.number().int().min(0),
  bounds: geoBoundingBoxSchema,
  /** GeoJSON polygon of the area the scene actually covers. */
  footprint: footprintSchema,
  worldTransform: streetSceneWorldTransformSchema,
  initialView: streetSceneInitialViewSchema,
  /** Guided-navigation data. Absent for a version reconstructed without it. */
  navigation: streetSceneNavigationSchema.optional(),
  assets: z.array(streetSceneAssetSchema),
  quality: streetSceneQualitySchema,
  /** ISO 8601 bounds of when the source imagery was observed. */
  observedFrom: instantSchema,
  observedTo: instantSchema,
  /** ISO 8601 instant this version was published. */
  publishedAt: instantSchema,
  /** Data credits this version must display, e.g. an open imagery licence. */
  attributions: z.array(z.string().min(1)),
  /** The privacy pipeline versions every input passed. */
  privacyPipelineVersions: z.array(z.string().min(1)),
});
export type StreetSceneManifest = z.infer<typeof streetSceneManifestSchema>;

/** A published scene on the map: enough to draw it and open it. */
export const streetSceneSummarySchema = z.object({
  id: z.string().min(1),
  version: z.number().int().min(0),
  center: geoCoordinateSchema,
  bounds: geoBoundingBoxSchema,
  footprint: footprintSchema,
  placement: streetSceneQualitySchema.shape.placement,
  posterUrl: httpsUrlSchema.optional(),
  publishedAt: instantSchema,
});
export type StreetSceneSummary = z.infer<typeof streetSceneSummarySchema>;

/**
 * The health of an area that is not (yet) a published scene, or that is being
 * improved.
 *
 * - `seeded` — useful contributions exist but nothing overlaps them yet.
 * - `partial` — overlapping contributions exist, not enough to reconstruct.
 * - `at_risk` — partial, and useful temporary media expires soon. More
 *   captures here may rescue it. A published scene is never `at_risk`:
 *   published output survives its inputs.
 * - `reconstructable` — enough overlap; waiting for the external worker.
 * - `reconstructing` — a job is running.
 * - `needs_more_capture` — a reconstruction found too little overlap.
 */
export const STREET_COVERAGE_AREA_STATES = [
  'seeded',
  'partial',
  'at_risk',
  'reconstructable',
  'reconstructing',
  'needs_more_capture',
] as const;
export type StreetCoverageAreaState = (typeof STREET_COVERAGE_AREA_STATES)[number];

/**
 * A coarse area of contribution activity.
 *
 * Deliberately coarse: `center` is the centre of a cell, not of any capture, and
 * counts are rounded into bands, so coverage cannot be read back into anybody's
 * position.
 */
export const streetCoverageAreaSchema = z.object({
  /** Opaque, stable for as long as the area exists. */
  id: z.string().min(1),
  state: z.enum(STREET_COVERAGE_AREA_STATES),
  center: geoCoordinateSchema,
  bounds: geoBoundingBoxSchema,
  /** Rounded count band of useful contributions: `1-4`, `5-19`, `20+`. */
  contributionBand: z.enum(['1-4', '5-19', '20+']),
  /** ISO 8601 instant the earliest useful source expires, when `at_risk`. */
  atRiskUntil: instantSchema.optional(),
  /** The published scene this area improves, when one exists. */
  sceneId: z.string().min(1).optional(),
});
export type StreetCoverageArea = z.infer<typeof streetCoverageAreaSchema>;

/**
 * What `GET /street3d/coverage` answers for a bounding box.
 *
 * A bounded SNAPSHOT of one box rather than a list that pages: both arrays are
 * capped server-side, and the way to see more is a smaller box — which is what
 * a map viewport already is. `{ items, nextCursor }` would promise an order
 * across scenes and cells that coverage does not have.
 */
export const streetCoverageSchema = z.object({
  scenes: z.array(streetSceneSummarySchema),
  areas: z.array(streetCoverageAreaSchema),
});
export type StreetCoverage = z.infer<typeof streetCoverageSchema>;

/**
 * `GET /street3d/coverage`. The span cap is the deployment's
 * (`STREET3D_COVERAGE_MAX_SPAN_DEGREES`), so it is enforced server-side and not
 * here; `west > east` is the antimeridian, not an inversion.
 */
export const streetCoverageQuerySchema = geoBoundingBoxSchema
  .strict()
  .refine((box) => box.south <= box.north, {
    message: 'south must not be north of north',
    path: ['south'],
  });
export type StreetCoverageQuery = z.input<typeof streetCoverageQuerySchema>;

/** Whether a coverage box fits inside a span cap, in degrees on either axis. */
export function coverageBoxWithin(box: StreetCoverageQuery, maxSpanDegrees: number): boolean {
  return box.north - box.south <= maxSpanDegrees && boundingBoxWidth(box) <= maxSpanDegrees;
}

/** Why a scene is being reported. */
export const STREET_SCENE_REPORT_REASONS = [
  'privacy',
  'inappropriate',
  'inaccurate',
  'other',
] as const;
export type StreetSceneReportReason = (typeof STREET_SCENE_REPORT_REASONS)[number];

/** The body of `POST /street3d/scenes/{sceneId}/reports`. */
export const streetSceneReportInputSchema = z
  .object({
    reason: z.enum(STREET_SCENE_REPORT_REASONS),
    /** Optional free text, at most 500 characters. Never published. */
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type StreetSceneReportInput = z.input<typeof streetSceneReportInputSchema>;

export const streetSceneReportSchema = z.object({
  id: z.string().min(1),
  sceneId: z.string().min(1),
  version: z.number().int().min(0),
  reason: z.enum(STREET_SCENE_REPORT_REASONS),
  createdAt: instantSchema,
});
export type StreetSceneReport = z.infer<typeof streetSceneReportSchema>;
