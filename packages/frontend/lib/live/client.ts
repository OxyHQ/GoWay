/**
 * GoWay Live's HTTP client (`live.sources()`, `live.shape()`): always the real
 * API, never the fixture transport `lib/goway/client.ts` may use — live data
 * is never faked, and its socket (`features/live/liveClient.ts`) talks to the
 * same origin. Public routes: no session is sent.
 *
 * Imported only by the live feature and the settings dialog's live credits,
 * both loaded on demand.
 */
import { createGoWayClient } from '@goway.to/sdk';

import { API_URL } from '@/lib/config';

export const liveApiClient = createGoWayClient({ apiBaseUrl: API_URL });
