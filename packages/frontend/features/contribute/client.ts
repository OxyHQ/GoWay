import { createGoWayClient } from '@goway.to/sdk';
import { API_URL } from '@/lib/config';
import { oxyServices } from '@/lib/oxyServices';

// Oxy remains the session/refresh authority. Never send its bearer to object storage.
const linked = oxyServices.createLinkedClient({ baseURL: API_URL });

/**
 * A GoWay client whose requests go through the Oxy linked client, for
 * identity-bound calls: Oxy attaches and refreshes the session itself.
 */
export const linkedGowayClient = createGoWayClient({
  apiBaseUrl: API_URL,
  fetch: (url, init) =>
    linked.client.requestResponse({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    }),
});

export const captureClient = linkedGowayClient.captures;
