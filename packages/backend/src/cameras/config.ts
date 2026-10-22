/**
 * Tuning for the camera channel. Constants in code, not environment: what
 * differs per deployment is a secret or an origin, and nothing here is
 * (`AGENTS.md` → env variables).
 */

/** Observations are aggregates a few bytes each; a month answers "how is this road usually". */
export const OBSERVATION_RETENTION_DAYS = 30;

/** The shortest a snapshot is held before the camera is asked again. */
export const SNAPSHOT_CACHE_MIN_SECONDS = 5;

/** Never record a frame time more often than this per camera (`touchFrame` writes). */
export const FRAME_TOUCH_INTERVAL_SECONDS = 60;
