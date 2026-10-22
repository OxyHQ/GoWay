/**
 * A stored camera as the contract says it: its provider's credit and licence
 * attached, and its status worked out at read time from how old its newest
 * frame is against that provider's own windows — never stored, so it cannot
 * be stale in the table.
 */

import { type Camera, type CameraStatus, cameraSchema } from '@goway/contracts';
import type { cameras } from '../db/schema';
import type { CameraProviderDefinition } from './types';

export type CameraRow = typeof cameras.$inferSelect;

export function statusOf(
  lastFrameAt: Date | null,
  provider: Pick<CameraProviderDefinition, 'staleAfterSeconds' | 'dropAfterSeconds'>,
  now: Date,
): CameraStatus {
  if (lastFrameAt === null) return 'unknown';
  const age = (now.getTime() - lastFrameAt.getTime()) / 1000;
  if (age > provider.dropAfterSeconds) return 'offline';
  return age > provider.staleAfterSeconds ? 'stale' : 'live';
}

/** `null` when the row's provider is no longer in the registry: it is not served. */
export function cameraOf(
  row: CameraRow,
  provider: CameraProviderDefinition | undefined,
  now: Date,
): Camera | null {
  if (!provider) return null;
  return cameraSchema.parse({
    id: row.id,
    providerId: row.providerId,
    name: row.name,
    kind: row.kind,
    position: { latitude: row.latitude, longitude: row.longitude },
    heading: row.heading,
    roadName: row.roadName,
    media: {
      kind: row.mediaKind,
      refreshSeconds: row.mediaRefreshSeconds,
      width: row.mediaWidth,
      height: row.mediaHeight,
    },
    status: statusOf(row.lastFrameAt, provider, now),
    lastFrameAt: row.lastFrameAt?.toISOString() ?? null,
    attribution: provider.attribution,
    licence: provider.licence,
  });
}
