# Street 3D viewer

Part of [#14](https://github.com/OxyHQ/GoWay/issues/14) and
[#15](https://github.com/OxyHQ/GoWay/issues/15): how published scenes reach a
user on the map and in the viewer, and what contributors are told. The
reconstruction side is in [`STREET3D_PIPELINE.md`](./STREET3D_PIPELINE.md); the
public contract is `packages/contracts/src/street3d.ts`.

## Layers

| Piece | Where | Owns |
| --- | --- | --- |
| API | `features/street3d/client.ts` | `@goway.to/sdk`'s `street3d` namespace: reads on the app's `gowayClient` (fixture transport included), `report` on the Oxy linked client. |
| Map layer | `features/street3d/useStreet3dLayer.tsx`, `coverageStyle.ts` | Footprints (`fill` + `line`), area dots (`circle`, one overlay per state), a poster chip per scene, the "contribute here" hint. |
| Viewer seam | `components/street3d/` | Provider-neutral `SceneViewer`. Feature code never imports `three` or `@sparkjsdev/spark`. |
| Web engine | `components/street3d/engine/sparkEngine.ts` | three.js + Spark, loaded by dynamic `import()` of `components/engine3d/lazyChunk.ts` — the ONE chunk every three.js consumer shares, so three.js never lands in the first-paint `__common` chunk (~3.5 MB, shared with the city-3D prototype engine); nobody who never opens a scene downloads it. |
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
viewer opens in guided **Walk** mode: you walk freely, but only over the ground
the scene was observed from. No viewpoint is ever shown or snapped to; there
are no arrows or markers.

- **Walkable region** (`components/street3d/walkableRegion.ts`). Viewpoints
  carry no order, so they are linked by a Gabriel graph (no other viewpoint
  inside the circle on the link as diameter) limited to 6 m; the region is the
  union of ground capsules of radius `reach` around the links, plus a disc around
  any unlinked viewpoint. `reach` is the manifest's `navigation.reachMeters`,
  else 3 m for a panorama (horizontal FOV ≥ 170°) and 1.2 m otherwise. All in
  the ground plane of `sceneUp(enuFromScene)`; queries use a uniform grid and
  allocate nothing.
- **Every frame** the wished-for position is clamped to the nearest walkable
  point, so pushing into the edge slides along it (no visible wall). The camera
  stands at the captured height there: each viewpoint's height is the median of
  those within 3 m, then blended over the nearby links so the height stays
  continuous.
- **Start**: `initialView.position` clamped into the region, facing
  `initialView.target`.
- **Keyboard**: W/S or ↑/↓ walk forward/back along the ground, A/D strafe, ←/→
  turn (as in Street View), Shift runs. 1.4 m/s walking, 3.5 m/s running.
- **Mouse**: drag to look. Click glides (eased, 2.5 m/s on average, 0.35–2.5 s)
  to the ground under the pointer, at most 25 m away and clamped into the
  region. The ground is `navigation.captureHeightMeters` below the captured
  height (a pole-carried scanner's 2.4 m, say), else 1.6 m, a hand-held camera. While hovering, a
  ring under the pointer shows where a click goes, only over walkable ground.
- **Touch**: one-finger drag to look. A touch landing in the lower two thirds
  of the left third becomes a thumbstick there once it moves: up walks
  forward, sideways strafes, full deflection (56 px) runs. It disappears on
  release. A double tap glides to that ground point; pinch narrows the FOV.
- Look is free in yaw. Pitch is clamped to ±35°, or ±60° when the capture's
  vertical FOV is at least 100° (a panorama saw sky and ground).
- The vertical FOV is the captured one (wheel/pinch only narrow it). Where the
  screen's horizontal FOV exceeds the captured horizontal FOV × 1.3, the sides
  are shaded instead of drawn; every edge is softly vignetted.

The native app gets the same controls through the embedded web viewer.
Orbit stays available behind the toggle as the free, secondary mode. Without
`navigation`, the viewer behaves as before (free orbit/walk).

## Loading and degrading

`deviceProfile.ts` judges the device before the engine is fetched:

- no WebGL2 → `unsupported`: no engine download, the poster and a sentence;
- low memory, few cores, Save-Data, a slow connection, a small max texture or an
  `spz` splat too large for reported memory → `preview`: pixel ratio 1, and the
  light `spz` splat only, or a `rad` scene at half the LoD budget;
- otherwise `full`: pixel ratio capped at 1.5; an `spz` scene draws
  `splat_preview` first, then `splat` streamed in and swapped.

A `rad` splat is a Spark level-of-detail tree, loaded paged on every tier that
draws, with no preview: its coarse levels draw first (`preview`), and the phase
is `full` once the pager has been idle for 500 ms. Spark's per-platform budget
(2.5M splats desktop, 1.5M iOS, 1M Android) is scaled by `lodSplatScale` 1
(`full`) or 0.5 (`preview`). The page pool holds extended splats (float32
centres: packed float16 steps by 12.5 cm beyond 128 m, which stripes a street
block) at half Spark's splat count, so its memory stays Spark's, scaled by the
tier. A chunked RAD's header names its `.radc` chunks; the viewer reads the
header first and refuses the scene unless every chunk resolves beside it and
passes the `STREET3D_ASSET_ORIGIN` rule. A `splat_environment` (always `rad`) is
paged into the same budget and drawn behind the scene by Spark's depth sort;
it loads only with a scene, and its failure is not an error.

The engine stops drawing in hidden tabs and on unmount frees every mesh, the
Spark renderer (page pool and workers included) and the WebGL context. Splats
are fetched without credentials. A development build shows fps, splats drawn,
bytes and load timings behind the `perf` toggle.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXPO_PUBLIC_STREET3D_ASSET_ORIGIN` | unset | When set, the only origin assets may come from. Otherwise any `https:` URL (the SDK's manifest parser already refuses anything else). |
| `EXPO_PUBLIC_WEB_ORIGIN` | `https://goway.to` | What the native WebView loads. |
| `EXPO_PUBLIC_STREET3D_FIXTURE_*` | unset | Fixture splat/poster URLs, anchor, opening view and credit (see `.env.example`). With an anchor, the fixtures are one scene, `s3d_fixture_anchor`, and two cells beside it; without, Barcelona examples. `…_NAVIGATION_URL` attaches a `navigation` JSON to the first fixture scene. |

`public/_headers` sets no CSP. If one is added, it must allow the asset origin
in `connect-src` and `img-src`, and `blob:` in `worker-src`. The scene CDN must
answer with `Access-Control-Allow-Origin` and allow the `Range` request header
(a RAD header is read by range).

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
