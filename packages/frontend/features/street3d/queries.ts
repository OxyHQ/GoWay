/**
 * React Query over the SDK's Street 3D namespace (`client.ts`).
 *
 * The coverage layer is OPTIONAL map furniture, and its error policy says so:
 * a coverage failure never renders an error. A 404 with no GoWay body means the
 * deployment has no Street 3D routes at all, so the layer switches itself off
 * for the session instead of asking again on every pan; anything else just
 * hides the layer until the next viewport.
 */
import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { GeoBoundingBox } from '@goway.to/sdk';
import type { StreetCoverage, StreetSceneManifest, StreetSceneReportInput } from '@goway.to/sdk';

import { classifyGoWayError, shouldRetryGoWay } from '@/lib/goway/errors';

import { isStreet3dEndpointMissing } from './availability';
import { street3dApi } from './client';

let endpointMissing = false;

function round(value: number): number {
  // ~10 m: coverage cells are far coarser than that, and coarser keys mean a
  // small pan reuses the cached answer.
  return Math.round(value * 1e4) / 1e4;
}

export function useStreetCoverage(
  bounds: GeoBoundingBox | null,
  { enabled = true, gcTime }: { enabled?: boolean; gcTime?: number } = {},
): UseQueryResult<StreetCoverage> {
  const key = bounds
    ? [round(bounds.west), round(bounds.south), round(bounds.east), round(bounds.north)]
    : null;
  return useQuery({
    queryKey: ['goway', 'street3d', 'coverage', key],
    enabled: enabled && bounds != null && !endpointMissing,
    retry: (count, error) =>
      !isStreet3dEndpointMissing(error) &&
      classifyGoWayError(error).kind !== 'unavailable' &&
      shouldRetryGoWay(count, error),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
    ...(gcTime !== undefined ? { gcTime } : {}),
    queryFn: async ({ signal }) => {
      try {
        return await street3dApi.coverage(bounds as GeoBoundingBox, { signal });
      } catch (error) {
        if (isStreet3dEndpointMissing(error)) endpointMissing = true;
        throw error;
      }
    },
  });
}

export function useStreetScene(sceneId: string | null): UseQueryResult<StreetSceneManifest> {
  return useQuery({
    queryKey: ['goway', 'street3d', 'scene', sceneId],
    enabled: sceneId != null,
    retry: shouldRetryGoWay,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => street3dApi.scene(sceneId as string, { signal }),
  });
}

export function useReportScene(sceneId: string) {
  return useMutation({
    mutationFn: (input: StreetSceneReportInput) => street3dApi.report(sceneId, input),
  });
}
