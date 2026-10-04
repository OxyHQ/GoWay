/**
 * The app's Street 3D API instance — see `api.ts` for why it is an adapter.
 *
 * Transport choices mirror the rest of the app exactly:
 *
 *  - Fixtures on → the same fixture `fetch` the main client uses, so the
 *    Street 3D routes are answered locally like every other route.
 *  - Fixtures off → public reads (coverage, scene) over the global `fetch`
 *    with the borrowed Oxy token, like `gowayClient`; the identity-bound write
 *    (report) over the Oxy linked client, like `captureClient`, so Oxy stays the
 *    session and refresh authority.
 */
import type { GoWayFetch } from '@goway.to/sdk';

import { gowayClient, USING_FIXTURES } from '@/lib/goway/client';
import { createFixtureFetch, parseFixtureFaults } from '@/lib/goway/mockTransport';
import { API_URL } from '@/lib/config';
import { oxyServices } from '@/lib/oxyServices';

import { createStreet3dApi } from './api';

function linkedFetch(): GoWayFetch {
  const linked = oxyServices.createLinkedClient({ baseURL: API_URL });
  return (url, init) =>
    linked.client.requestResponse({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
}

const fixtureFetch = USING_FIXTURES
  ? createFixtureFetch(parseFixtureFaults(process.env.EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS))
  : undefined;

export const street3dApi = createStreet3dApi({
  client: gowayClient,
  apiBaseUrl: API_URL,
  getAccessToken: () => oxyServices.session.accessToken,
  ...(fixtureFetch ? { fetch: fixtureFetch, writeFetch: fixtureFetch } : { writeFetch: linkedFetch() }),
});
