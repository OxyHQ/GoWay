/**
 * THE one lazily-loaded chunk of the landmark tour UI. Import it ONLY with
 * `import('@/features/landmarks/lazy')`, never statically
 * (`components/__tests__/landmarksChunk.test.ts`). With the landmarks flag
 * off, `ExploreScreen` never evaluates that `import()`.
 */
export { LandmarkPlaceAction, LandmarksPillEntry } from './LandmarkEntry';
export { LandmarkOverlay } from './LandmarkOverlay';
