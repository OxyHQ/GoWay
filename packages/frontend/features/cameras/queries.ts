/**
 * React Query over the SDK's cameras namespace (`goway.cameras`).
 *
 * The layer is OPTIONAL map furniture, and its error policy says so: a failure
 * never renders an error. A 404 with no GoWay body means this deployment has no
 * camera routes at all, so the layer switches itself off for the session
 * instead of asking again on every pan (`lib/goway/endpointMissing.ts`).
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  MAX_CAMERA_LIST_LIMIT,
  type Camera,
  type CameraObservationPage,
  type GeoBoundingBox,
} from '@goway.to/sdk';

import { isEndpointMissing } from '@/lib/goway/endpointMissing';
import { classifyGoWayError, shouldRetryGoWay } from '@/lib/goway/errors';
import { gowayClient } from '@/lib/goway/client';

/** Pages read per viewport: a settled view at street scale holds far fewer than this. */
const MAX_PAGES = 3;

let endpointMissing = false;

function round(value: number): number {
  // ~10 m: a small pan reuses the cached answer.
  return Math.round(value * 1e4) / 1e4;
}

export function useCameras(
  bounds: GeoBoundingBox | null,
  { enabled = true }: { enabled?: boolean } = {},
): UseQueryResult<Camera[]> {
  const key = bounds
    ? [round(bounds.west), round(bounds.south), round(bounds.east), round(bounds.north)]
    : null;
  return useQuery({
    queryKey: ['goway', 'cameras', 'list', key],
    enabled: enabled && bounds != null && !endpointMissing,
    retry: (count, error) =>
      !isEndpointMissing(error) &&
      classifyGoWayError(error).kind !== 'unavailable' &&
      shouldRetryGoWay(count, error),
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const cameras: Camera[] = [];
      let cursor: string | undefined;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await gowayClient.cameras.list(
            { ...(bounds as GeoBoundingBox), limit: MAX_CAMERA_LIST_LIMIT, cursor },
            { signal },
          );
          cameras.push(...result.items);
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
      } catch (error) {
        if (isEndpointMissing(error)) endpointMissing = true;
        throw error;
      }
      return cameras;
    },
  });
}

/** One camera, refreshed as often as its status can move. */
export function useCamera(cameraId: string | null): UseQueryResult<Camera> {
  return useQuery({
    queryKey: ['goway', 'cameras', 'one', cameraId],
    enabled: cameraId != null,
    retry: shouldRetryGoWay,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: ({ signal }) => gowayClient.cameras.get(cameraId as string, { signal }),
  });
}

/** What was counted at a camera lately: the newest few windows. */
export function useCameraObservations(
  cameraId: string | null,
): UseQueryResult<CameraObservationPage> {
  return useQuery({
    queryKey: ['goway', 'cameras', 'observations', cameraId],
    enabled: cameraId != null,
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: ({ signal }) =>
      gowayClient.cameras.observations(cameraId as string, { limit: 5 }, { signal }),
  });
}
