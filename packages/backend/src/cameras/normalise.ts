/**
 * The one place an upstream entry becomes a {@link CameraRecord} or is
 * refused. Every source calls {@link accept}, so a normaliser bug is a
 * `skipped` count in the sync report rather than a malformed camera in the
 * catalogue.
 */

import {
  CAMERA_KINDS,
  CAMERA_MEDIA_KINDS,
  cameraIdSchema,
  cameraMediaSchema,
  cameraProviderIdSchema,
  feedText,
  geoCoordinateSchema,
} from '@goway/contracts';
import { z } from 'zod';
import type { CameraRecord } from './types';

const httpUrl = z.string().regex(/^https?:\/\/\S+$/, 'must be an http(s) URL');

export const cameraRecordSchema = z
  .object({
    sourceId: feedText(160),
    name: feedText(120),
    kind: z.enum(CAMERA_KINDS),
    position: geoCoordinateSchema,
    heading: z.number().min(0).lt(360).nullable(),
    roadName: feedText(120).nullable(),
    media: cameraMediaSchema
      .extend({ kind: z.enum(CAMERA_MEDIA_KINDS) })
      .refine((media) => (media.kind === 'snapshot') === (media.refreshSeconds !== null), {
        message: 'a snapshot names its refresh; a stream has none',
      }),
    upstreamUrl: httpUrl,
    frameAt: z.date().nullable(),
  })
  // A coordinate at (0, 0) is a feed's "unknown", not a camera in the Gulf of Guinea.
  .refine(({ position }) => position.latitude !== 0 || position.longitude !== 0, {
    message: 'position is the null island',
  });

/** Count a refusal: `skipped[reason]++`. */
export function skip(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

/**
 * The record, or `null` when the entry is junk (counted in `skipped` under the
 * first reason zod gives). `candidate` is what the source built from the
 * upstream entry; this does not trust it.
 */
export function accept(candidate: unknown, skipped: Record<string, number>): CameraRecord | null {
  const parsed = cameraRecordSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  skip(skipped, parsed.error.issues[0]?.path.join('.') || 'invalid');
  return null;
}

/** A camera's GoWay id from its provider and the provider's own id. */
export function cameraIdOf(providerId: string, sourceId: string): string {
  const slug = sourceId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cameraIdSchema.parse(`${cameraProviderIdSchema.parse(providerId)}.${slug || 'camera'}`);
}

/**
 * Drop repeats of one `sourceId` (a catalogue listing a camera twice) and
 * ids that collide once slugged, counting each as skipped.
 */
export function dedupe(
  providerId: string,
  records: readonly CameraRecord[],
  skipped: Record<string, number>,
): CameraRecord[] {
  const seen = new Map<string, string>();
  const out: CameraRecord[] = [];
  for (const record of records) {
    const id = cameraIdOf(providerId, record.sourceId);
    const owner = seen.get(id);
    if (owner !== undefined) {
      skip(skipped, owner === record.sourceId ? 'duplicate' : 'id-collision');
      continue;
    }
    seen.set(id, record.sourceId);
    out.push(record);
  }
  return out;
}
