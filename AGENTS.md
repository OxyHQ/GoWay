# GoWay

Oxy's open map and geographic platform: the consumer app at `goway.to`, the public `@goway.to/sdk`, and GoWay-owned Places. Expo / React Native frontend + Express + Socket.IO backend on the Oxy SDK.

## Commands

```bash
bun install                  # postinstall builds contracts, sdk, maps
cp packages/backend/.env.example packages/backend/.env   # then fill it (README.md)
bun run dev                  # backend + frontend (dev:backend, dev:frontend alone)
bun run lint && bun run typecheck && bun run test
bun run lint:fix             # Biome write mode
bun run check:migrations && bun run check:openapi && bun run test:gates
bun run validate:agents-md   # byte budget for every AGENTS.md
```

## Map

- Setup and layout: `README.md`, `ARCHITECTURE.md`; design notes: `docs/` (index `docs/README.md`).
- Nested rules load when you work there; read the one for your area first:
  `packages/backend/AGENTS.md` (database, migrations, Live, Street 3D),
  `packages/backend/src/places/AGENTS.md` (Places),
  `packages/frontend/AGENTS.md` (map, 3D, imagery, Mercaria),
  `packages/maps/AGENTS.md` (map mark, data credit, logo).
- `packages/*` only, never `apps/`. `packages/reconstruction-worker` is Python/CUDA, not a Bun workspace: use the root `worker:setup|doctor|run`.
- Street 3D capture and contribution UI live in `packages/frontend`; there is no second consumer app.

## Conventions

- Use bun only; commit `bun.lock` with its `package.json` (`check:lockfile`).
- Biome lints and formats everything; ESLint exists only in `packages/frontend/eslint.config.js` for rules Biome lacks. Never add ESLint or Prettier elsewhere.
- An env variable is only what differs per deployment (secrets, origins, buckets, ids). No feature on/off variable: shipped means on; tuning is a constant in code.
- One `OxyProvider` from `@oxy.so/services/ui/client` with `EXPO_PUBLIC_OXY_CLIENT_ID`; sign-in is the in-app `OxyAccountDialog`, never an IdP redirect.
- Expo config comes from `@oxy.so/app-preset`; fix the preset, never copy config into the app.
- Theme through `BloomThemeProvider`; no hardcoded brand colors or restated Bloom tokens.
- Gate private API calls on `useAuth().canUsePrivateApi`; only the root `Stack` swaps route groups.
- Backend auth is `@oxy.so/core/server` only; no app-local auth, bearer parsing or CORS. Call your own API via `oxyServices.createLinkedClient({ baseURL })`.
- Every request, response, error code and value set is a zod schema in `packages/contracts`. A route change edits `API_OPERATIONS`, then `bun run openapi`. Never add a `*Schemas.ts` or hand parser.
- Lists are `{ items, nextCursor }` with fingerprinted cursors (`http/cursor.ts`); errors use the contract's closed codes.
- Vocabulary labels carry every `LABEL_LANGUAGES` language; read via `localizedLabel`/`matchLanguageTag`, never `locale.startsWith` (`docs/LABEL_TRANSLATIONS.md`).

## Boundaries

- Never hardcode a development endpoint; the canonical origin is `https://goway.to`, the package `@goway.to/sdk` (the integration boundary for FairCoin, Moovo, Mercaria, Homiio, Mention, Clarity).
- Never publish a Drizzle/PostGIS row shape or a Python worker detail as an SDK contract.
- MapLibre, OpenFreeMap, Photon, Nominatim, Valhalla, COLMAP, gsplat are adapters; feature code imports the GoWay abstraction, never the provider.
- A route is only a routing engine's answer: no fixture, fallback or client-drawn route; no engine is an error state (`check:routing`).
- Operator powers (`moderation.operate`, `capture.pilot`) are Oxy application keys in `oxy/appPermissions.ts`, held by org role; never a user-id list or per-person grant.
- Privacy: browsing, search and routing work signed out; require auth only for identity-bound features. Request location permission only on a location action; never persist precise coordinates or put user location in Places tables.
- Ask first before adding a dependency, a Bun workspace or an env variable.

## Testing and PRs

- Run `lint`, `typecheck`, `test` plus the `check:*` gate for the area you touched; CI (`.github/workflows/ci.yml`) runs them all.
- Deploys run via `workflow_call` from CI; never dispatch by hand. Never publish to npm from a laptop.
- Secrets come from `.env` files and GitHub secrets; never print or commit them.

## Links

[Oxy engineering standards](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md) ·
[lint and format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md) ·
[API conventions](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/api-conventions.md) ·
[application roles](https://github.com/OxyHQ/oxy/blob/main/docs/auth/application-roles.md) ·
[npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md) ·
[build traps](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/build-and-runtime-traps.md)

Owner: Oxy engineering. Last reviewed 2026-11-11.
