import { OxyServices } from '@oxy.so/core';

import { OXY_BASE_URL } from './config';

/**
 * The one `OxyServices` instance for the app.
 *
 * It is created here, outside the React tree, so that things which must be
 * configured ON `BloomProvider` — the image resolver, which sits ABOVE
 * `OxyProvider` — can reach it without a hook. `OxyProvider` receives this same
 * instance, so there is still exactly one client and one session authority.
 *
 * Session restore stays entirely OxyProvider's: device-first credential mint,
 * then silent OAuth. Only `baseURL` is configured here, and it is OXY's API —
 * GoWay's own API is reached through `createLinkedClient`, never as this base.
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });
