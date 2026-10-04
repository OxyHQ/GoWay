# Street 3D viewer

Part of [#14](https://github.com/OxyHQ/GoWay/issues/14) and
[#15](https://github.com/OxyHQ/GoWay/issues/15): how published scenes reach a
user on the map and in the viewer, and what contributors are told. The
reconstruction side is in [`STREET3D_PIPELINE.md`](./STREET3D_PIPELINE.md); the
public contract is `packages/shared-types/src/street3d.ts`.

## Layers

| Piece | Where | Owns |
| --- | --- | --- |
| API | `features/street3d/client.ts` | `@goway.to/sdk`'s `street3d` namespace: reads on the app's `gowayClient` (fixture transport included), `report` on the Oxy linked client. |
| Map layer | `features/street3d/useStreet3dLayer.tsx`, `coverageStyle.ts` | Footprints (`fill` + `line`), area dots (`circle`, one overlay per state), a poster chip per scene, the "contribute here" hint. |
| Viewer seam | `components/street3d/` | Provider-neutral `SceneViewer`. Feature code never imports `three` or `@sparkjsdev/spark`. |
| Web engine | `components/street3d/engine/sparkEngine.ts` | three.js + Spark, loaded by dynamic `import()` into its own chunk (~3.5 MB); nobody who never opens a scene downloads it. |
| Native | `components/street3d/SceneViewer.native.tsx` | A WebView on `<EXPO_PUBLIC_WEB_ORIGIN>/street3d/<id>?embed=1`. |
| Screen | `features/street3d/Street3dScreen.tsx`, `app/street3d/[sceneId].tsx` | Chrome, poster, credits, report, place labels, the 2D ⇄ 3D handoff. |
| Contribution status | `features/contribute/status.ts`, `ContributionStatusCard.tsx` | The truthful per-capture state, source expiry, and the at-risk hint. |

## Frames

Scene space is metric ENU around `worldTransform.anchor`: x east, y north, z up,
ground near z = 0; `enuFromScene` is the identity for current worker output.
Spark decodes `.spz` values as stored. The viewer therefore does **not** rotate
the mesh into three.js's Y-up: it sets the camera's up to `sceneUp(enuFromScene)`
and keeps `initialView` and labels in scene coordinates. Any other similarity is
handled by the same code; a transform that is not a similarity yields no labels
rather than wrong ones.

Places become labels by WGS 84 → ECEF → ENU around the anchor
(`lib/street3d/geodesy.ts`), then the inverse of `enuFromScene`
(`lib/street3d/placeLabels.ts`). Labels float a few metres above the anchor's
altitude (places have none), are capped (nearest first), and are hidden when
behind the camera, out of frame or too far. They are DOM elements over the
canvas, never splat pixels.

## Guided navigation

A Gaussian scene is only trustworthy from where it was observed; free flight
exposes unobserved space as shards and needles, worst at the edges of a portrait
capture shown on a landscape screen. When a manifest publishes `navigation`, the
viewer opens in guided **Walk** mode (`components/street3d/guidedNavigation.ts`):

- The camera stands on a viewpoint (the one nearest `initialView.position`,
  facing `initialView.target`) and glides (~400 ms, eased) to the next one:
  W/S or the up/down arrows, the on-screen arrows, a click ahead, or a ground
  marker. The next viewpoint is the best within 45° of the requested ground
  direction and 0.5–6 m away. A/D and left/right turn; nothing strafes.
- Look is free in yaw; pitch is clamped to ±35°.
- The vertical FOV is the captured one (wheel/pinch only narrow it). Where the
  screen's horizontal FOV exceeds the captured horizontal FOV × 1.3, the sides
  are shaded instead of drawn; every edge is softly vignetted.
- Ground markers (1.6 m below each reachable viewpoint, one per direction
  sector) appear on hover or drag and after each step.

Orbit stays available behind the toggle as the free, secondary mode. Without
`navigation`, the viewer behaves as before (free orbit/walk).

## Loading and degrading

`deviceProfile.ts` judges the device before the engine is fetched:

- no WebGL2 → `unsupported`: no engine download, the poster and a sentence;
- low memory, few cores, Save-Data, a slow connection, a small max texture or a
  splat too large for reported memory → `preview`: the light splat only, pixel
  ratio 1;
- otherwise `full`: `splat_preview` first, then `splat` streamed in and swapped,
  pixel ratio capped at 1.5.

The engine stops drawing in hidden tabs and on unmount frees both meshes, the
Spark renderer and the WebGL context. Splats are fetched without credentials.
A development build shows fps, bytes and load timings behind the `perf` toggle.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXPO_PUBLIC_STREET3D_ENABLED` | off | Coverage layer and viewer. A 404 (no GoWay body) from coverage switches the layer off for the session; 503 hides it until the next viewport. |
| `EXPO_PUBLIC_STREET3D_ASSET_ORIGIN` | unset | When set, the only origin assets may come from. Otherwise any `https:` URL (the SDK's manifest parser already refuses anything else). |
| `EXPO_PUBLIC_WEB_ORIGIN` | `https://goway.to` | What the native WebView loads. |
| `EXPO_PUBLIC_STREET3D_FIXTURE_*` | unset | Fixture splat/poster URLs, anchor, opening view and credit (see `.env.example`). With an anchor, the fixtures are one scene, `s3d_fixture_anchor`, and two cells beside it; without, Barcelona examples. `…_NAVIGATION_URL` attaches a `navigation` JSON to the first fixture scene. |

`public/_headers` sets no CSP. If one is added, it must allow the asset origin
in `connect-src` and `img-src`, and `blob:` in `worker-src`. The scene CDN must
answer with `Access-Control-Allow-Origin`.

No sample splat is committed or linked by default: GoWay ships only assets whose
licence has been verified. Point the fixture variables at a `.spz` you are
entitled to use, served over HTTPS (the SDK's parser rejects any other asset
URL) with CORS.

## Native strategy

The WebView is the initial native renderer on purpose: #14 Phase F asks for the
final native renderer to be chosen from device benchmarks. The WebView loads only
the configured web origin, has geolocation off, and speaks a validated two-message
protocol (`bridge.ts`): a place tap (→ native `router.push('/place/<id>')`) and
the viewer phase. Report and contribute are native controls that use the app's
own Oxy session; nothing identity-bound runs in the WebView.

## Privacy and honesty

- Viewing is public. Reporting and "contribute here" are gated by `useAuthGate`
  at the moment they are asked for.
- Nothing requests location. The at-risk lookup on the contribution screen sends
  the capture's own anchor (the contributor's data) as a small box and keeps the
  answer in memory only.
- Expiry copy is always about temporary source media; a published scene survives
  its inputs and no string says otherwise (`lib/messages/__tests__`).
- An `approximate` scene is drawn muted and thinner on the map and labelled as
  approximate in the viewer.
