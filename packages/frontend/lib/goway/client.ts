/**
 * The app's one `@goway.to/sdk` client.
 *
 * GoWay's own app is a consumer of GoWay's public SDK, deliberately: if the
 * integration boundary is not good enough for the first-party map, it is not
 * good enough for FairCoin, Moovo or Homiio either. Nothing in `features/` or
 * `components/` constructs a client, builds a URL or names an endpoint — they
 * call `gowayClient.places.inBounds(...)` and get a parsed `Place[]` or a typed
 * error.
 *
 * ## Fixtures, and how the real backend replaces them
 *
 * There is no GoWay API deployed yet. Rather than stub the client, this module
 * injects a fixture `fetch` (`mockTransport.ts`) into the REAL client, so every
 * request still goes through the SDK's query serialisation, response parsing,
 * cancellation and error classification. The swap to the live backend is the
 * deletion of one option:
 *
 * ```ts
 * createGoWayClient({ apiBaseUrl: API_URL, getAccessToken })   // live
 * createGoWayClient({ apiBaseUrl: API_URL, getAccessToken, fetch: fixtures })  // now
 * ```
 *
 * It is controlled by `EXPO_PUBLIC_GOWAY_FIXTURES`, which defaults to ON while
 * no backend exists. Setting it to `0` points the identical app at a real API.
 *
 * ## Token custody
 *
 * `getAccessToken` is called before every request and the SDK never caches it —
 * `OxyServices` remains the single session authority, as AGENTS.md requires. It
 * returns `null` when signed out, which is a NORMAL configuration here: the
 * map, search, place details and routing are all public, and only the
 * identity-bound writes (`places.create`, `places.update`) need a session.
 */
import { createGoWayClient, type GoWayClient } from '@goway.to/sdk';

import { API_URL } from '@/lib/config';
import { oxyServices } from '@/lib/oxyServices';

import { createFixtureFetch, parseFixtureFaults } from './mockTransport';

/**
 * Whether this build is served by the fixture layer.
 *
 * Defaults to `true`. An explicit `0`/`false` turns it off; anything else
 * (including the variable being absent) keeps fixtures, because "no backend"
 * is the current state of the world and a blank map is a worse default than an
 * obviously-local dataset.
 */
export const USING_FIXTURES = !/^(0|false)$/i.test(process.env.EXPO_PUBLIC_GOWAY_FIXTURES ?? '');

export const gowayClient: GoWayClient = createGoWayClient({
  apiBaseUrl: API_URL,
  // Oxy owns the session; the SDK borrows the token per request and keeps none.
  getAccessToken: () => oxyServices.getAccessToken(),
  ...(USING_FIXTURES
    ? { fetch: createFixtureFetch(parseFixtureFaults(process.env.EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS)) }
    : {}),
});
