/**
 * The directions request schema.
 *
 * ## The shape is `@goway.to/sdk`'s, because the SDK is published contract
 *
 * `packages/sdk/src/client.ts` builds the body field by field — `origin`,
 * `destination`, `waypoints`, `mode`, `alternatives`, `locale`, each location
 * `{ coordinate?, placeId?, name? }` — and `POST`s it to `/routes` under
 * `/api/v1`. That is exactly what this schema accepts. Unknown fields are
 * DROPPED rather than refused, so a newer SDK sending a field this backend has
 * not learned yet still gets a route instead of a 400.
 *
 * ## `mode` is a string here, and narrowed in the handler
 *
 * Validating it as an enum would answer `validation_failed` for `transit`,
 * which tells an integrator their request was malformed. The vocabulary has a
 * code that says the true thing — `unsupported_mode` — and a client can hide a
 * travel-mode button on the strength of it. So the schema checks only that a
 * mode was sent, and the handler decides whether GoWay routes it.
 *
 * ## `details` names the FIELD and never the value
 *
 * Inherited from `http/validation`, and it matters more here than anywhere
 * else in the API: every value in this body is a precise location, and GoWay's
 * privacy rule is that those are transient request data that are never
 * persisted — including in somebody else's log index.
 */

import { z } from 'zod';

/**
 * The most intermediate stops one request may carry.
 *
 * A stock Valhalla refuses more than 20 locations for `auto` and fewer for the
 * pedestrian and bicycle models, and the refusal arrives as an engine error a
 * caller cannot interpret. Eight stops plus an origin and a destination is
 * comfortably inside every profile's limit, and a request for more is refused
 * here — naming the field — rather than upstream.
 */
export const MAX_WAYPOINTS = 8;

/** Longest accepted stop label. Echoed nowhere; bounded so it cannot be abuse. */
const MAX_NAME_LENGTH = 200;

/**
 * A coordinate, in the ergonomic named form the whole contract uses.
 *
 * `z.number()` and not `z.coerce.number()`: this is a JSON body, so a string
 * where a number belongs is a malformed request (`bad_request`) rather than a
 * refused value, and coercing it would hide a client serialisation bug that
 * will eventually send `"NaN"`.
 */
const coordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * One end of a route.
 *
 * At least one of `coordinate` and `placeId`. When BOTH arrive, the place wins
 * and an unknown place id is still `not_found` — the caller's coordinate does
 * not rescue it. That is the whole point of accepting a place id: which point a
 * router should aim at is GoWay's knowledge, and silently falling back would
 * route to a building centroid the caller guessed while reporting success.
 */
const routeLocationSchema = z
  .object({
    coordinate: coordinateSchema.optional(),
    placeId: z.string().trim().min(1).max(128).optional(),
    name: z.string().max(MAX_NAME_LENGTH).optional(),
  })
  .refine((value) => value.coordinate !== undefined || value.placeId !== undefined, {
    message: 'must carry a coordinate or a placeId',
  });

/**
 * A BCP-47 language tag, checked for SHAPE only.
 *
 * Whether the engine has instructions in that language is its business; a tag
 * it does not know falls back to English rather than failing. What is checked
 * is that the value is a language tag at all, because it is forwarded upstream.
 */
const localeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/, 'must be a BCP-47 language tag');

export const routeRequestSchema = z.object({
  origin: routeLocationSchema,
  destination: routeLocationSchema,
  waypoints: z.array(routeLocationSchema).max(MAX_WAYPOINTS).optional(),
  // Bounded: an unsupported mode is echoed back in `details` so a client can
  // report what it asked for, and an unbounded echo is a log-flooding gift.
  mode: z.string().trim().min(1).max(32),
  alternatives: z.boolean().optional(),
  locale: localeSchema.optional(),
});

export type RouteRequestInput = z.infer<typeof routeRequestSchema>;
export type RouteLocationInput = z.infer<typeof routeLocationSchema>;
