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

import type { GeoBoundingBox, GeoCoordinate } from './geo';

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
export interface StreetSceneAsset {
  role: StreetSceneAssetRole;
  /** `spz` for Gaussian splats, `jpeg` for the poster. */
  format: 'spz' | 'jpeg';
  url: string;
  byteSize: number;
  sha256: string;
  /** Gaussian count, for splat roles. */
  gaussians?: number;
}

/**
 * How scene coordinates map onto the world.
 *
 * Scene space is metric. `enuFromScene` is a column-major 4×4 similarity that
 * takes a scene point to local East-North-Up metres around `anchor`. A consumer
 * placing a WGS 84 coordinate in the scene converts it to ENU around the anchor
 * and applies the inverse.
 */
export interface StreetSceneWorldTransform {
  anchor: GeoCoordinate & { altitudeMeters: number };
  frame: 'enu';
  enuFromScene: number[];
}

/** Why a consumer should, or should not, trust the scene's placement and look. */
export interface StreetSceneQuality {
  profile: StreetSceneProfile;
  /** Share of input frames whose cameras were solved, 0–1. */
  registrationRatio: number;
  /** Median distance between solved cameras and their position priors, in metres. */
  alignmentResidualMeters: number;
  /** Held-out reconstruction quality, in dB. Higher is better. */
  heldOutPsnr: number;
  /**
   * `precise` when alignment residual is within the configured tolerance;
   * `approximate` otherwise. An approximate scene must not be presented as
   * exactly placed on the map.
   */
  placement: 'precise' | 'approximate';
}

/** The camera a viewer opens on, in scene coordinates. */
export interface StreetSceneInitialView {
  position: [number, number, number];
  target: [number, number, number];
}

/** A published scene version, as a viewer needs it. */
export interface StreetSceneManifest {
  id: StreetSceneId;
  /** Monotonic per scene. A newer version supersedes an older one. */
  version: number;
  bounds: GeoBoundingBox;
  /** GeoJSON polygon of the area the scene actually covers. */
  footprint: { type: 'Polygon'; coordinates: number[][][] };
  worldTransform: StreetSceneWorldTransform;
  initialView: StreetSceneInitialView;
  assets: StreetSceneAsset[];
  quality: StreetSceneQuality;
  /** ISO 8601 bounds of when the source imagery was observed. */
  observedFrom: string;
  observedTo: string;
  /** ISO 8601 instant this version was published. */
  publishedAt: string;
  /** Data credits this version must display, e.g. an open imagery licence. */
  attributions: string[];
  /** The privacy pipeline versions every input passed. */
  privacyPipelineVersions: string[];
}

/** A published scene on the map: enough to draw it and open it. */
export interface StreetSceneSummary {
  id: StreetSceneId;
  version: number;
  center: GeoCoordinate;
  bounds: GeoBoundingBox;
  footprint: { type: 'Polygon'; coordinates: number[][][] };
  placement: StreetSceneQuality['placement'];
  posterUrl?: string;
  publishedAt: string;
}

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
export interface StreetCoverageArea {
  /** Opaque, stable for as long as the area exists. */
  id: string;
  state: StreetCoverageAreaState;
  center: GeoCoordinate;
  bounds: GeoBoundingBox;
  /** Rounded count band of useful contributions: `1-4`, `5-19`, `20+`. */
  contributionBand: '1-4' | '5-19' | '20+';
  /** ISO 8601 instant the earliest useful source expires, when `at_risk`. */
  atRiskUntil?: string;
  /** The published scene this area improves, when one exists. */
  sceneId?: StreetSceneId;
}

/** What `GET /street3d/coverage` answers for a bounding box. */
export interface StreetCoverage {
  scenes: StreetSceneSummary[];
  areas: StreetCoverageArea[];
}

export type StreetCoverageQuery = GeoBoundingBox;

/** Why a scene is being reported. */
export const STREET_SCENE_REPORT_REASONS = ['privacy', 'inappropriate', 'inaccurate', 'other'] as const;
export type StreetSceneReportReason = (typeof STREET_SCENE_REPORT_REASONS)[number];

export interface StreetSceneReportInput {
  reason: StreetSceneReportReason;
  /** Optional free text, at most 500 characters. Never published. */
  note?: string;
}

export interface StreetSceneReport {
  id: string;
  sceneId: StreetSceneId;
  version: number;
  reason: StreetSceneReportReason;
  createdAt: string;
}
