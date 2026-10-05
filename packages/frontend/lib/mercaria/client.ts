/**
 * The app's one `@mercaria.co/sdk` client — GoWay's adapter for Mercaria.
 *
 * A place on GoWay can be a shop that sells on Mercaria. GoWay stores none of
 * that: what is on the shelf, at what price, and whether the shop still trades
 * from the place are Mercaria's, read through Mercaria's public SDK every time
 * the sheet opens. `lib/mercaria/` is the adapter over that SDK (with the
 * default origin in `lib/config.ts`); `features/` reads the hooks in
 * `queries.ts` and the words in `presentation.ts` and never imports the SDK,
 * the same way it never names MapLibre or Valhalla.
 *
 * ## Anonymous, on purpose
 *
 * Every read GoWay makes works anonymously, and the only thing a session would
 * add is whether the reader saved a product on Mercaria, which this app does
 * not show. So no `getAccessToken`: the reader's Oxy token is not sent to a
 * second origin for nothing, and the section works signed out like the rest
 * of the place sheet.
 *
 * ## Fixtures
 *
 * Under `EXPO_PUBLIC_GOWAY_FIXTURES` — the switch `lib/goway/client.ts` reads —
 * the client is handed the fixture `fetch` in `mockTransport.ts`, so local
 * development shows the Boqueria's stalls with no Mercaria running, through
 * the REAL SDK's parser. The deployed build sets fixtures off and reads
 * `EXPO_PUBLIC_MERCARIA_API_URL`.
 */
import { createMercariaClient, type MercariaClient } from '@mercaria.co/sdk';

import { MERCARIA_API_URL } from '@/lib/config';
import { USING_FIXTURES } from '@/lib/goway/client';
import { parseFixtureFaults } from '@/lib/goway/mockTransport';

import { createMercariaFixtureFetch } from './mockTransport';

export const mercariaClient: MercariaClient = createMercariaClient({
  apiBaseUrl: MERCARIA_API_URL,
  ...(USING_FIXTURES
    ? { fetch: createMercariaFixtureFetch(parseFixtureFaults(process.env.EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS).mercaria) }
    : {}),
});
