/**
 * The public Street 3D request schemas.
 *
 * Coverage takes a bounding box and is CAPPED: a coverage answer is cells and
 * scenes, and a continent-sized box is a scan that the row limit would truncate
 * arbitrarily — which reads as missing coverage rather than a refused query.
 * `west > east` is the antimeridian, not an inversion, exactly as in
 * `placeSchemas.ts`.
 */

import { z } from 'zod';
import { STREET_SCENE_REPORT_REASONS } from '@goway/shared-types';

const latitudeParam = z.coerce.number().min(-90).max(90);
const longitudeParam = z.coerce.number().min(-180).max(180);

export function coverageQuerySchema(maxSpanDegrees: number) {
  return z
    .object({ west: longitudeParam, south: latitudeParam, east: longitudeParam, north: latitudeParam })
    .refine((box) => box.south <= box.north, { message: 'south must not be north of north', path: ['south'] })
    .refine((box) => box.north - box.south <= maxSpanDegrees, { message: 'the box is too tall', path: ['north'] })
    .refine(
      (box) => (box.east >= box.west ? box.east - box.west : 360 - box.west + box.east) <= maxSpanDegrees,
      { message: 'the box is too wide', path: ['east'] },
    );
}

export const sceneReportSchema = z
  .object({
    reason: z.enum(STREET_SCENE_REPORT_REASONS),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
