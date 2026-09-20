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
 * ## Fixtures, and the backend that has replaced them
 *
 * `api.goway.to` is live: Places, search, geocoding and real Valhalla routing.
 * **The deployed site runs against it** —
 * `.github/workflows/deploy-frontend.yml` sets `EXPO_PUBLIC_GOWAY_FIXTURES: '0'`
 * — and the fixture layer is now a LOCAL convenience only, for working on the
 * app with no backend running.
 *
 * Rather than stub the client, this module injects a fixture `fetch`
 * (`mockTransport.ts`) into the REAL client, so every request still goes
 * through the SDK's query serialisation, response parsing, cancellation and
 * error classification. Going live is the deletion of one option:
 *
 * ```ts
 * createGoWayClient({ apiBaseUrl: API_URL, getAccessToken })   // deployed
 * createGoWayClient({ apiBaseUrl: API_URL, getAccessToken, fetch: fixtures })  // local
 * ```
 *
 * The default is still ON, so `bun run dev:frontend` works with nothing else
 * running. Set `EXPO_PUBLIC_GOWAY_FIXTURES=0` in `packages/frontend/.env` to
 * develop against the real API, which is what the deployed bundle does.
 *
 * ## The fixture route is a STRAIGHT LINE, and the app says so
 *
 * `mockTransport.ts` answers `POST /routes` with the crow's path between the
 * stops at 1.25×, because a fake polyline along real streets would be a worse
 * lie than an obvious one. It is still a lie, so {@link USING_FIXTURES} is
 * exported and `DirectionsPanel` prints a line under any route drawn from it.
 * A developer must never mistake the fixture for the engine — that confusion
 * is what shipped a straight line to production.
 *
 * ## The locale is set ONCE, here
 *
 * Every place, search, geocoding and routing call the app makes carries the
 * device's language tag, because it is a client option rather than a parameter
 * each call site remembers. A locale threaded per call is a locale some call
 * site forgets, and the symptom is a pin labelled in one language and the sheet
 * it opens labelled in another.
 *
 * It does not change `Place.name`, which is always the place's default,
 * local-language name; it adds `localizedName`, and `placeDisplayName` is what
 * the UI renders. A street or a city label still comes from the tile and is
 * still `name:latin` — that is a separate problem, and a separate issue.
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
import { deviceLocale } from '@/lib/i18n';
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
  locale: deviceLocale(),
  // Oxy owns the session; the SDK borrows the token per request and keeps none.
  getAccessToken: () => oxyServices.getAccessToken(),
  ...(USING_FIXTURES
    ? { fetch: createFixtureFetch(parseFixtureFaults(process.env.EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS)) }
    : {}),
});
