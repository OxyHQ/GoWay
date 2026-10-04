import { createGoWayClient } from '@goway.to/sdk';
import { API_URL } from '@/lib/config';
import { oxyServices } from '@/lib/oxyServices';

// Oxy remains the session/refresh authority. Never send its bearer to object storage.
const linked = oxyServices.createLinkedClient({ baseURL: API_URL });
export const captureClient = createGoWayClient({
  apiBaseUrl: API_URL,
  fetch: (url, init) => linked.client.requestResponse({
    url, method: init.method, headers: init.headers, body: init.body, signal: init.signal,
  }),
}).captures;
