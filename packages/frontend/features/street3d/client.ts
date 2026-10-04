/**
 * The app's Street 3D API: `@goway.to/sdk`'s `street3d` namespace, split by
 * who authenticates the request.
 *
 *  - Public reads (`coverage`, `scene`) go through the app's one `gowayClient`,
 *    like every other public read — including its fixture transport when
 *    `EXPO_PUBLIC_GOWAY_FIXTURES` is on.
 *  - The identity-bound write (`report`) goes through the Oxy linked client,
 *    like captures, so Oxy stays the session and refresh authority. With
 *    fixtures on it stays on `gowayClient`, whose fixture transport answers it.
 *
 * That split is the whole reason this file exists; everything else is the SDK.
 */
import type { GoWayStreet3dApi } from '@goway.to/sdk';

import { linkedGowayClient } from '@/features/contribute/client';
import { gowayClient, USING_FIXTURES } from '@/lib/goway/client';

const writer = USING_FIXTURES ? gowayClient : linkedGowayClient;

export const street3dApi: GoWayStreet3dApi = {
  coverage: gowayClient.street3d.coverage,
  scene: gowayClient.street3d.scene,
  report: writer.street3d.report,
};
