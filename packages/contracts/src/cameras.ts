/**
 * Public cameras — the catalogue GoWay holds, the media it serves itself, and
 * what it reads off the pictures.
 *
 * ## Everything is GoWay's
 *
 * A client never talks to a camera's operator. {@link Camera.media} says what
 * GoWay serves for it (a refreshed snapshot, an MJPEG stream, an HLS
 * playlist); the URL is always GoWay's own (`/cameras/{id}/snapshot`,
 * `/cameras/{id}/stream`), and the operator's credit and licence travel with
 * the camera so they are shown whenever it is drawn.
 *
 * ## Observations are aggregates, never pictures
 *
 * {@link CameraObservation} is what the video worker counted in one window:
 * vehicles and people by class, how congested the road looked, how well the
 * camera could see. It carries no frame, no face, no plate and no identity —
 * GoWay analyses a picture and discards it.
 */

import { z } from 'zod';
import { geoBoundingBoxSchema, geoCoordinateSchema } from './geo';
import { feedText, hubLinkSchema } from './hub';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import { instantSchema } from './time';

/** A stable GoWay camera id: the provider and the camera within it (`dgt.es-1234`). */
export const cameraIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{2,127}$/, 'must be a camera id');

/** A camera provider id: lower-case, hyphenated, stable (`digitraffic-weathercam`). */
export const cameraProviderIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'must be a camera provider id');

/**
 * What a camera looks at. Closed: a client filters and styles per kind.
 *
 * - `traffic` — a road. - `city` — a street, square or skyline.
 * - `harbour` — a port, marina or coast. - `mountain` — a slope, pass or peak.
 * - `weather` — a station whose point is the sky and the ground.
 */
export const CAMERA_KINDS = ['traffic', 'city', 'harbour', 'mountain', 'weather'] as const;
export type CameraKind = (typeof CAMERA_KINDS)[number];
export const cameraKindSchema = z.enum(CAMERA_KINDS);

/**
 * What GoWay serves for the camera:
 *
 * - `snapshot` — a still the camera refreshes every `refreshSeconds`.
 * - `mjpeg` — a continuous multipart stream.
 * - `hls` — a playlist of short segments.
 */
export const CAMERA_MEDIA_KINDS = ['snapshot', 'mjpeg', 'hls'] as const;
export type CameraMediaKind = (typeof CAMERA_MEDIA_KINDS)[number];

export const cameraMediaSchema = z.object({
  kind: z.enum(CAMERA_MEDIA_KINDS),
  /** How often a `snapshot` changes, in seconds; `null` for a stream. */
  refreshSeconds: z.number().int().min(1).max(3600).nullable(),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
});
export type CameraMedia = z.infer<typeof cameraMediaSchema>;

/**
 * How the camera is doing, as of the server's last look: `live` (a recent
 * frame), `stale` (older than its provider's freshness window, still shown as
 * old) or `offline` (no frame within the drop window).
 */
export const CAMERA_STATUSES = ['live', 'stale', 'offline'] as const;
export type CameraStatus = (typeof CAMERA_STATUSES)[number];
export const cameraStatusSchema = z.enum(CAMERA_STATUSES);

export const cameraSchema = z.object({
  id: cameraIdSchema,
  providerId: cameraProviderIdSchema,
  name: feedText(120),
  kind: cameraKindSchema,
  position: geoCoordinateSchema,
  /** Degrees clockwise from true north the camera faces, when the provider says. */
  heading: z.number().min(0).lt(360).nullable(),
  /** The road, as the provider names it (`A-2 km 596`), when it says. */
  roadName: feedText(120).nullable(),
  media: cameraMediaSchema,
  status: cameraStatusSchema,
  /** When the newest frame was taken; `null` before the first. */
  lastFrameAt: instantSchema.nullable(),
  /** The credit the provider's licence requires, shown whenever the camera is drawn. */
  attribution: hubLinkSchema,
  licence: hubLinkSchema,
});
export type Camera = z.infer<typeof cameraSchema>;

export const DEFAULT_CAMERA_LIST_LIMIT = 200;
export const MAX_CAMERA_LIST_LIMIT = 1000;

/** `GET /cameras` — the cameras in a box, ordered by id. */
export const cameraListQuerySchema = geoBoundingBoxSchema
  .extend({
    kind: cameraKindSchema.optional(),
    limit: limitSchema(MAX_CAMERA_LIST_LIMIT, DEFAULT_CAMERA_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict()
  .refine((query) => query.south <= query.north, {
    message: 'south must not be north of north',
    path: ['south'],
  });
export type CameraListQuery = z.input<typeof cameraListQuerySchema>;
export const cameraPageSchema = pageSchema(cameraSchema);
export type CameraPage = z.infer<typeof cameraPageSchema>;

/** `GET /cameras/{cameraId}` and the media routes under it. */
export const cameraPathSchema = z.object({ cameraId: cameraIdSchema }).strict();
export type CameraPath = z.infer<typeof cameraPathSchema>;

/**
 * What a picture can hold that is counted. Classes of thing, never of person:
 * a pedestrian is a count, not someone.
 */
export const OBSERVED_CLASSES = [
  'car',
  'truck',
  'bus',
  'motorcycle',
  'bicycle',
  'pedestrian',
] as const;
export type ObservedClass = (typeof OBSERVED_CLASSES)[number];
export const observedClassSchema = z.enum(OBSERVED_CLASSES);

/** How congested the road looked: from free-flowing to not moving. */
export const CONGESTION_LEVELS = ['free', 'busy', 'slow', 'stopped'] as const;
export type CongestionLevel = (typeof CONGESTION_LEVELS)[number];
export const congestionLevelSchema = z.enum(CONGESTION_LEVELS);

/**
 * Whether the picture can be trusted: `ok`, `dark` (night with nothing to
 * see), `obstructed` (lens covered, fog, glare), `frozen` (the same frame
 * repeating).
 */
export const CAMERA_HEALTH = ['ok', 'dark', 'obstructed', 'frozen'] as const;
export type CameraHealth = (typeof CAMERA_HEALTH)[number];
export const cameraHealthSchema = z.enum(CAMERA_HEALTH);

export const cameraObservationSchema = z
  .object({
    cameraId: cameraIdSchema,
    /** The window the worker counted over. */
    from: instantSchema,
    to: instantSchema,
    /** Distinct things that crossed the counting line, per class. */
    counts: z.partialRecord(observedClassSchema, z.number().int().min(0)),
    /** Things in frame at the window's end, per class. */
    present: z.partialRecord(observedClassSchema, z.number().int().min(0)),
    /** Vehicles per minute through the counting line; `null` when it has none. */
    flowPerMinute: z.number().min(0).nullable(),
    congestion: congestionLevelSchema.nullable(),
    health: cameraHealthSchema,
  })
  .refine((observation) => Date.parse(observation.from) <= Date.parse(observation.to), {
    message: 'from must not be after to',
    path: ['from'],
  });
export type CameraObservation = z.infer<typeof cameraObservationSchema>;

export const DEFAULT_OBSERVATION_LIMIT = 60;
export const MAX_OBSERVATION_LIMIT = 500;

/** `GET /cameras/{cameraId}/observations` — newest first. */
export const cameraObservationsQuerySchema = z
  .object({
    since: instantSchema.optional(),
    limit: limitSchema(MAX_OBSERVATION_LIMIT, DEFAULT_OBSERVATION_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type CameraObservationsQuery = z.input<typeof cameraObservationsQuerySchema>;
export const cameraObservationPageSchema = pageSchema(cameraObservationSchema);
export type CameraObservationPage = z.infer<typeof cameraObservationPageSchema>;

/** One provider the catalogue holds, with its terms and how much it carries. */
export const cameraProviderSchema = z.object({
  id: cameraProviderIdSchema,
  name: feedText(80),
  attribution: hubLinkSchema,
  licence: hubLinkSchema,
  /** Whether GoWay serves this provider's pictures itself (`relay`) or lists it only. */
  redistribution: z.enum(['relay', 'catalogue-only']),
  cameraCount: z.number().int().min(0),
  coverage: geoBoundingBoxSchema.nullable(),
});
export type CameraProvider = z.infer<typeof cameraProviderSchema>;
export const cameraProviderPageSchema = pageSchema(cameraProviderSchema);
export type CameraProviderPage = z.infer<typeof cameraProviderPageSchema>;
