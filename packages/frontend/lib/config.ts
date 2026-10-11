/** Runtime configuration, read from `EXPO_PUBLIC_*` env vars (see `.env.example`). */
import { DEFAULT_GOWAY_WEB_BASE_URL } from '@goway.to/sdk';
import { DEFAULT_MERCARIA_API_BASE_URL } from '@mercaria.co/sdk';

/** Backend API base URL. */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.goway.to';

/**
 * Oxy's own API — the identity service sign-in, session restore and token
 * refresh talk to. NOT GoWay's backend: `OxyServices` is constructed with this,
 * and GoWay's API is reached through `oxyServices.createLinkedClient({ baseURL:
 * API_URL })`. Pointing `OxyServices` at GoWay's API sends Oxy's own auth calls
 * (`/auth/oauth/client/…`) to a server that does not have them, and sign-in
 * fails.
 */
export const OXY_BASE_URL = process.env.EXPO_PUBLIC_OXY_BASE_URL ?? 'https://api.oxy.so';

/** The app's registered Oxy client id (ApplicationCredential publicKey). */
export const OXY_CLIENT_ID = process.env.EXPO_PUBLIC_OXY_CLIENT_ID ?? '';

/** An origin with no trailing slash, or `null` for an empty value. */
function origin(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : null;
}

/**
 * The public web origin of THIS deployment — where `goway.to` routes are served.
 *
 * Native needs it and web does not: the native Street 3D screen hosts the web
 * viewer in a WebView (see `components/street3d/SceneViewer.native.tsx`), and a
 * native app has no origin of its own. Defaults to the canonical origin the
 * published SDK already names; a native dev build points it at a dev server by
 * setting `EXPO_PUBLIC_WEB_ORIGIN`, never by editing product code.
 */
export const WEB_ORIGIN = origin(process.env.EXPO_PUBLIC_WEB_ORIGIN) ?? DEFAULT_GOWAY_WEB_BASE_URL;

/**
 * Mercaria's public API — where "Products at this store" on a place is read
 * from (`lib/mercaria/client.ts`). Defaults to the origin `@mercaria.co/sdk`
 * itself names; a build that talks to another Mercaria sets
 * `EXPO_PUBLIC_MERCARIA_API_URL`, never product code.
 */
export const MERCARIA_API_URL =
  origin(process.env.EXPO_PUBLIC_MERCARIA_API_URL) ?? DEFAULT_MERCARIA_API_BASE_URL;

/**
 * Whether Street 3D VIEWING is on: the coverage layer on the map and the
 * scene viewer route.
 *
 * Off unless `EXPO_PUBLIC_STREET3D_ENABLED` is `1`/`true`. Even when on, a
 * coverage endpoint that answers 404 or 503 hides the layer silently — the map
 * never shows an error for an optional layer.
 */
export const STREET3D_ENABLED = /^(1|true)$/i.test(process.env.EXPO_PUBLIC_STREET3D_ENABLED ?? '');

/**
 * The origin published scene assets (splats, posters) are served from, when
 * it is not the API's.
 *
 * Build-time configuration, not a hostname in product code. When set, the
 * viewer refuses an asset URL on any other origin; when unset, any `https:`
 * asset URL the API returns is accepted. `public/_headers` sets no CSP today;
 * if one is ever added, this origin must be in its `connect-src` (splats are
 * fetched) and `img-src` (posters), and `worker-src` must allow `blob:` (the
 * splat decoder runs in a blob worker).
 */
export const STREET3D_ASSET_ORIGIN = origin(process.env.EXPO_PUBLIC_STREET3D_ASSET_ORIGIN);

/**
 * Whether the city-3D PROTOTYPE replaces the map's `fill-extrusion` buildings
 * with bevelled, occlusion-shaded meshes (web only; `docs/MAP_3D_CITY.md`).
 *
 * Off unless `EXPO_PUBLIC_MAP_CITY3D` is `1`/`true`, and no production
 * deployment sets it. A development build can also turn it on per tab with
 * `?city3d=1` (`lib/map/city3dFlag.ts`); a production build ignores that.
 * When off, nothing about the map changes: the engine is a separate chunk that
 * is never requested and `building-3d` draws as it always has.
 */
export const MAP_CITY3D_ENABLED = /^(1|true)$/i.test(process.env.EXPO_PUBLIC_MAP_CITY3D ?? '');

/**
 * Whether the route flyover and Camera Studio are on (`docs/MAP_CAMERA_STUDIO.md`).
 *
 * Off unless `EXPO_PUBLIC_MAP_FLYOVER` is `1`/`true`, and no production
 * deployment sets it. A development build can also turn it on per tab with
 * `?flyover=1` (`lib/map/flyoverFlag.ts`); a production build ignores that.
 * When off, the directions planner shows no "Fly the route", `/studio`
 * redirects to the map, and the feature's chunk is never requested.
 */
export const MAP_FLYOVER_ENABLED = /^(1|true)$/i.test(process.env.EXPO_PUBLIC_MAP_FLYOVER ?? '');

/**
 * Whether the map draws the world as a GLOBE at low zoom (MapLibre's `globe`
 * projection, easing into mercator by z12) with a space backdrop and an
 * atmosphere (web only; `docs/MAP_TERRAIN_GLOBE.md`).
 *
 * Off unless `EXPO_PUBLIC_MAP_GLOBE` is `1`/`true`; no production deployment
 * sets it. A development build also honours `?globe=1` per tab
 * (`lib/map/reliefFlag.ts`); a production build ignores that.
 */
export const MAP_GLOBE_ENABLED = /^(1|true)$/i.test(process.env.EXPO_PUBLIC_MAP_GLOBE ?? '');

/**
 * Whether the map draws real relief: a hillshade at mid zooms and 3D terrain
 * once the camera is tilted, from GoWay's DEM tiles (`docs/MAP_TERRAIN_GLOBE.md`).
 * Native draws the hillshade only (its MapLibre has no terrain API).
 *
 * Off unless `EXPO_PUBLIC_MAP_TERRAIN` is `1`/`true`; no production deployment
 * sets it. A development build also honours `?terrain=1` per tab; a production
 * build ignores that.
 */
export const MAP_TERRAIN_ENABLED = /^(1|true)$/i.test(process.env.EXPO_PUBLIC_MAP_TERRAIN ?? '');
