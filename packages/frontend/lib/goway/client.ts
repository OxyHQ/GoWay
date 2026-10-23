/**
 * The app's one `@goway.to/sdk` client.
 *
 * GoWay's own app is a consumer of GoWay's public SDK, deliberately: if the
 * integration boundary is not good enough for the first-party map, it is not
 * good enough for FairCoin, Moovo or Homiio either. Nothing in `features/` or
 * `components/` constructs a client, builds a URL or names an endpoint — they
 * call `gowayClient.places.inBounds(...)` and get a parsed page of places or a
 * typed error.
 *
 * ## Fixtures, and the backend that has replaced them
 *
 * `api.goway.to` is live: Places, search, geocoding and real Valhalla routing.
 * **Every production build runs against it** — a production build never uses
 * the fixture layer unless told to (`fixturesOn`) — and the fixture layer is a
 * LOCAL convenience only, for working on the app with no backend running.
 *
 * Rather than stub the client, this module injects a fixture `fetch`
 * (`mockTransport.ts`) into the REAL client, so every request still goes
 * through the SDK's query serialisation, response parsing, cancellation and
 * error classification. Going live is the deletion of one option:
 *
 * ```ts
 * createGoWayClient({ apiBaseUrl: API_URL, fetch: linked.fetchOptional })   // deployed
 * createGoWayClient({ apiBaseUrl: API_URL, fetch: fixtures })  // local
 * ```
 *
 * A development build defaults it ON, so `bun run dev:frontend` works with
 * nothing else running. Set `EXPO_PUBLIC_GOWAY_FIXTURES=0` in
 * `packages/frontend/.env` to develop against the real API, which is what every
 * production build does.
 *
 * ## Directions are NEVER a fixture
 *
 * The fixture layer answers places, search, geocoding and Street 3D. It does
 * not answer `POST /routes`: that request leaves for the real API at
 * `EXPO_PUBLIC_API_URL` as it would with fixtures off (a fixture place, whose
 * id the API has never heard of, travels as its point), and the route on the
 * map is the engine's. With the default `https://api.goway.to` that is
 * GoWay's own Valhalla; a local backend routes with whatever its
 * `ROUTING_VALHALLA_URL` names (`packages/backend/.env.example`), and with none
 * the planner says it cannot work out the route. There is no third answer. The
 * fixture this replaced drew the crow's path at 1.25× and labelled it, and a
 * labelled lie still reads as "routing is broken" to everyone who uses it.
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
 * The linked client owns token acquisition, refresh, cancellation and session
 * changes. Its optional-session fetch preserves signed-out browsing. Fixtures
 * receive only a signed-in boolean; no real bearer enters the fixture layer.
 */
import { createGoWayClient, type GoWayClient } from '@goway.to/sdk';

import { API_URL } from '@/lib/config';
import { deviceLocale } from '@/lib/i18n';
import { oxyServices } from '@/lib/oxyServices';

import { createFixtureFetch, fixturesOn, parseFixtureFaults } from './mockTransport';

/** Whether this build is served by the fixture layer (`fixturesOn`). */
export const USING_FIXTURES = fixturesOn(process.env.EXPO_PUBLIC_GOWAY_FIXTURES, __DEV__);

const linked = oxyServices.createLinkedClient({ baseURL: API_URL });

export const gowayClient: GoWayClient = createGoWayClient({
  apiBaseUrl: API_URL,
  locale: deviceLocale(),
  fetch: USING_FIXTURES
    ? createFixtureFetch(
        parseFixtureFaults(process.env.EXPO_PUBLIC_GOWAY_FIXTURE_FAULTS),
        linked.fetchOptional,
        () => oxyServices.session.isAuthenticated,
      )
    : linked.fetchOptional,
});
