# The camera never inside a building

The owner: "it's fine that the camera can move freely, but it shouldn't pass
through buildings, because it feels broken." At high pitch and close zoom,
rotating or tilting near tall buildings (the Sagrada Família, Eixample blocks,
Manhattan) put the map's eye inside a building: the walls vanished, or sliced
through the view. The reference is Apple Maps: free movement, but the eye is
never inside a building or under the ground, and when a gesture would take it
there it is held at the surface, smoothly, without a jump and without a fight.

| Piece | Where |
| --- | --- |
| The rule (platform-neutral: no DOM, WebGL or map engine) | `packages/frontend/components/map/engine/camera/clearance.ts` |
| The buildings as prisms: the index, built per tile on the mesh worker; landmark columns | `components/map/engine/camera/volumes.ts`, called by `engine/city3d/tileMeshing.ts` and `engine/city3d/models.ts` (`assetVolumes`) |
| The engine's height field (tiles held, landmarks drawn, the ground they stand on) | `components/map/engine/camera/field.ts`, `CityEngine.clearance`, `City3dHandle.clearance()` |
| The MapLibre host | `components/map/cameraClearance.web.ts`, attached by `MapCanvas.web.tsx` |
| Tests | `components/map/__tests__/cameraClearance.test.ts`; the browser check `packages/frontend/scripts/check-camera-clearance.ts` |

## What the camera is

MapLibre owns it: a centre (and the ground elevation under it), a zoom, a
pitch and a bearing. The eye is derived: `distance` metres from the centre
(half the screen height over the tangent of half the field of view, at the
zoom's metres per pixel), behind it along the bearing and up by the pitch
(`clearance.ts` → `eyeOf`, checked against MapLibre's own
`getCameraLngLat`/`getCameraAltitude` in the browser check). At z18 on a
720 px tall screen in Barcelona the eye is 241 m from the centre; at 76° it is
234 m behind it and 58 m up — inside the Sagrada Família, or inside most
Eixample blocks at z19.

Every way the camera moves goes through one place. Drag-rotate, pitch, pinch,
the wheel, the keyboard and inertia (`HandlerManager._updateMapTransform`), and
every `jumpTo`/`easeTo`/`flyTo` — flyovers, landmark tours, Camera Studio,
deep links, `MapApi.moveTo` — build the camera ASKED for and hand it to
`Camera.applyUpdatedTransform`. That runs MapLibre's own terrain rule first,
then `transformCameraUpdate`, then draws. MapLibre keeps the camera asked for
(`_requestedCameraState`) apart from the one drawn for as long as a gesture or
animation lasts, and drops it at `moveend`.

MapLibre already keeps the eye out of the terrain:
`Camera._elevateCameraIfInsideTerrain`, always on while terrain is on, raises
an eye under the terrain to the terrain — "the same ground position but at
higher altitude, still pointing to the same spot" — by lowering the pitch and
the zoom. It knows nothing of buildings, and keeps no margin (the near plane
cuts the hillside). `centerClampedToGround` (on by default) is about the
CENTRE, not the eye: it keeps the point looked at on the terrain.

## Decision: raise the eye, over a continuous field

When the eye would be inside a building or under the ground, the rule raises
it just enough, keeping the centre, the bearing and the eye's position over
the ground, and lowering only the pitch and the zoom: MapLibre's terrain rule,
extended to the buildings. Chosen over stopping the gesture at the surface:

- **A rotation always turns.** The bearing is never touched, so rotating past
  a tower lifts the eye over it and sets it back down on the far side. Stopping
  at the wall holds the bearing while the finger keeps going: a wall, the
  "wall bug" feel; and if the camera asked for passes through the building, the
  drawn one pops across it.
- **The centre never moves**, so what is under the finger stays there.
- **One answer per camera, no search.** With the eye's ground position fixed
  the requirement is read once (`requirementFor`); moving the eye along the
  view ray or around the orbit would need a search whose answer can jump.
- **Terrain and buildings hold the eye the same way.**

**Smooth by construction.** Each prism asks for its top plus a margin over
and beside its footprint, falling at `slope` (2: a 63° ramp) past the margin
(`volumes.ts` → `prismRequirement`). The field is the highest ask, so it is
continuous, and the correction a pure function of the camera asked for: a
camera that moves a little is corrected a little (no snap), and the same
camera gets the same correction every frame (no oscillation). A correction is
a fixed point: asking again changes nothing, so when a gesture resumes from a
corrected camera (MapLibre resets to the drawn camera at `moveend`), nothing
jumps. The ramp is the price: the eye is lifted a little before it reaches a
wall below the roof — at street level beside a 25 m Eixample block, within
14 m of it.

**The margin** is at least 2 m and at least 1.5 near planes (MapLibre's near
plane is a fiftieth of the screen height in its camera's pixels: 4 m at z18,
8 m at z17), measured at the distance AFTER the lift so the answer is a fixed
point. Over the ground too: MapLibre's own rule keeps none.

**Data arriving under the eye** is the one change the field cannot make
smooth: a tile or a landmark appearing where the eye is. The rule passes at
once the part of a change that the camera's own motion explains (a fixed field
changes by at most `slope + 1` per metre the eye moves, plus its own change of
height and margin) and eases the rest with a 120 ms time constant
(`createCameraClearance`). A still camera gets no camera updates, so the host
eases it: when the field's version changes and the map is not moving,
`cameraClearance.web.ts` asks `settle` and runs one 350 ms `easeTo`, which the
first frame of a gesture interrupts.

**Programmatic animations are corrected too**, not left alone. Tours,
flyovers and Camera Studio paths are authored without building heights; a
Studio tour at street level through Manhattan would otherwise fly through the
towers. They pass through `transformCameraUpdate` like a gesture, so their
path is adjusted where (and only where) it would clip, smoothly, and the tour
itself is unchanged. The landmark tours orbit outside their landmark and are
not touched unless a neighbour stands in the way.

**Limits.** A gesture pushed into a building keeps going in the camera asked
for; reversing it moves the drawn camera only once the camera asked for comes
back out (within that one gesture: MapLibre's own terrain rule does the same).
A footprint is the convex hull of a unit's lowest vertices: an L-shaped
building or a courtyard is filled. A part that starts in the air (a skybridge)
is a prism from the ground: the eye goes over it, never under.

## The buildings, as prisms

The mesh worker already writes, per unit (a building, a building part, a
polygon of a far level), its vertices and its footprint box. Beside them it
now writes the unit's convex footprint (the hull of its lowest vertices, in
the mesh's stored units) and its top, and a 64 × 64 grid over the units with
each cell's tallest top (`meshVolumes`). The main thread keeps it with the
mesh's CPU side (`PackedMesh.volumes`, never uploaded); nothing is downloaded
and no geometry is copied. A query looks at the cells within reach of its
point, skips any whose tallest top cannot matter, then measures the few
footprints left.

Each unit stands where the grounder stands it: the drawn ground at the centre
of its footprint box, read from the same grid the buildings are lifted by
(`terrainGround.ts` → `Ground.grid`). The engine lists, per tile, the finest
mesh it holds (not only the tiles drawn this frame: the eye's own tile is
behind the camera half the time, and a list that followed the frustum would
come and go as the view turns).

Landmark models are hand-made, taller than their footprint prism and far from
a prism: the Sagrada Família is a 45 m nave under 172 m towers. Their index is
made from their own triangles (`models.ts` → `assetVolumes`): every triangle
sampled at half a column's width, columns of 1.5–8 m (about 32 across the
model), each as tall as the model is there; placed by the landmark's heading,
scale and ground. A spire is a spire.

## The ground

The host reads the terrain the way MapLibre's own rule reads it,
`Terrain.getElevationForLngLatZoom(eye, zoom)`, in `cameraClearance.web.ts` →
`groundAt` — the one function to switch to the shared elevation sampler when
it lands, so the eye, the buildings and the terrain mesh agree on one surface.
The buildings' ground is the engine's own `Ground` (unchanged here).

## Cost

| | |
| --- | --- |
| Per camera change (unit test, nine dense synthetic z15 tiles, 20,000 street-level changes) | **≈3 µs** |
| Per camera change, in the browser (development export, headless Chromium on SwiftShader, a host at load 35+; the browser check's drives) | Sagrada Família 0.31 ms mean, 19 ms worst (346 changes); One Vanderbilt 0.41 ms mean, 13 ms worst (293) |
| Worker, per tile (synthetic z15 city tile: 952 units, 37,800 vertices) | 0.6 ms |
| Memory, per tile (same tile) | 86 KB (8% of its mesh); fixed 32 KB of grid + ~40 B a unit |
| A landmark's columns, once per asset as it loads (the Sagrada Família, 30,320 triangles → 536 columns, 68 KB) | 36 ms, on the main thread beside its glTF parse |
| First paint (`entry`) | ~1.4 KB gzip (`cameraClearance.web.ts` + `clearance.ts`, minified); the index and field are in the engine chunk and the mesh worker |
| The frame-budget gate (`frameBudget.test.ts`) | identical draws, triangles, passes, shadow redraws and per-frame uploads before and after; the load-time upload counts move run to run with arrival order, the same spread in two runs of either build |

The rule is not run below z13, and returns before measuring anything when the
eye is above every tile's tallest prism. It needs no `QualityProfile` knob:
it draws nothing, so no preset draws more or less for it, and it animates only
through MapLibre's own camera (the still camera's one `easeTo`), never a timer
or a frame loop of its own.

## The browser check

`packages/frontend/scripts/check-camera-clearance.ts`, against a development
export served with `serve-map-build.ts --upstream=https://goway.to` (it needs
goway.to's tiles, so it is a local check, not a CI job). At the Sagrada
Família (the landmark model) and One Vanderbilt (a city-tile tower, 427 m), at
76° (the city sky's ceiling is 80°), by real input: a slow Ctrl-drag onto the
tower, tilts towards the horizon there, rotations past and back through it, a
programmatic `easeTo` orbit through it, and the wheel. Every frame MapLibre
draws, the drawn eye is sampled against the prisms (no margin, no ramp), and
the rule's eye against MapLibre's own (`getCameraLngLat`/`getCameraAltitude`:
identical in every frame of both runs).

"Before" is the same export with the rule's answer discarded (measured, never
applied), so both builds draw the same city:

| Scene | Build | Frames | Frames with the eye inside | Deepest | Pitch reached |
| --- | --- | ---: | ---: | ---: | --- |
| Sagrada Família | before | 1,241 | **121** | 129.8 m under the tops | 20–80° |
| Sagrada Família | this change | 1,302 | **0** | — | 20–76° |
| One Vanderbilt | before | 1,367 | **132** | 307 m | 20–80° |
| One Vanderbilt | this change | 1,415 | **0** | — | 20–60.8° |

The pitch a drive reached is the rule at work: tilting towards the horizon
beside One Vanderbilt holds the camera at 61° instead of entering the tower.

## Native

The rule is engine code, ready for the native host. Today it has nothing to
hold on native, and no place to run:

- **No pre-frame camera hook.** MapLibre Native has no `transformCameraUpdate`
  and `@maplibre/maplibre-react-native` 11.4.1 exposes none: its camera is
  driven by the platform's gesture recognisers on the UI thread, and JS hears
  of a move only after it is drawn (`onRegionIsChanging`). Correcting it then
  (`Camera.jumpTo`) would draw the bad frame first and fight the recogniser
  every frame. iOS's `mapView:shouldChangeFromCamera:toCamera:` (which the
  wrapper uses for `maxBounds`) can only VETO a camera — a wall, not a lift;
  Android's `MapLibreMap` has no equivalent at all.
- **No buildings to clear.** Native draws MapLibre Native's own
  `fill-extrusion` (`building-3d`), not the city engine, so there is no index;
  their heights reach JS only through an asynchronous `queryRenderedFeatures`.
  No 3D terrain either (the wrapper exposes none).

Phase 4 of `MAP_NATIVE_3D.md` (GoWay's engine drawing the native map, with
"one camera and gesture controller" on the UI thread) brings both: its camera
calls `createCameraClearance().constrain` with the engine's `clearance` field
on every update, exactly as `cameraClearance.web.ts` does.
