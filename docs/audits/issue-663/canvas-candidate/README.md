# Canvas adoption checkpoint — not published acceptance

This draft depends on Bloom's additive Canvas API and MapControls orientation from
source `c64040c1` (Bloom draft PR #681). GoWay still declares Bloom 17.19.3. The browser
used an isolated **built** mirror reporting package 17.22.0; frontend and maps both
resolved that same mirror. This is candidate evidence, not a published-package gate.
The mirror is restored before committing; it is not part of this branch.

The adapter keeps one map and one panel content tree across sidebar/bottom placement.
Bloom owns panel gestures, measured detents, local geometry and claims. GoWay keeps
camera decisions and the existing fit-padding clamp. Official credit, scale and
error chrome stay outside CanvasBackground's renderer layer. No route or user
location is synthesized, and opening the scene made zero geolocation calls.

The credit toggle and its three legal links use shared 44 px controls. The expanded
links retain their original destinations. The map controls use the same component
in a horizontal row below 880 px and a vertical column above it. Measured capacity
removes controls that cannot fit, including their pointer targets; a focused
control transfers to the adjustable handle before display:none. Collapsing to
peek makes the controls keyboard-reachable again in the tested 500 px room.

## Evidence

- `focus-focus.json`: focused Zoom, resize 1440→390×500, focus transferred to handle;
  ArrowDown reaches peek; ShiftTab reaches Tilt, Zoom out, Zoom in; Enter zooms.
  Camera zoom 11 stays 11 across resize, then becomes 12 after activation. Map,
  canvas and input identities remain stable. Zero page errors or geolocation calls.
- `targets-320-targets.json`: actual peek/half/full values asserted; 320×844 coarse
  input, 44 px visible targets, real center hit-tests, legal hrefs and keyboard
  traversal. Screenshots keep actual foreground chrome visible. Hidden controls
  are recorded as hidden, not counted as reachable buttons.
- `safe-area-safe-area.json`: Chromium's actual CSS safe-area override 24/32/20/28.
  Full host reads top 24, left 32, right 20. After moving the host to 70,40 and sizing it
  to 300×500, local top/left/right padding returns to 16: window insets are not
  applied twice. Chrome and camera fitting both consume Canvas local geometry;
  overlapping safe-area/viewport/edge claims combine by MAX.
- `source-manifest.json`: source-file and built-module hashes; declared versions,
  lock hash and candidate source provenance. `artifacts.json` hashes the evidence.

## Contrast failure retained

`contrast-before-*` preserves the negative, before any shared palette correction.
The real map is placed over land and sea in light/dark mode at zoom 11. These are
camera positions for material measurement, not a user-location or route fixture.
Normal screenshots are full viewport captures. Diagnostic captures hide only the
selected text ink (and the input placeholder), keeping layout and material intact.

The measurement script compares normal/backing PNGs inside each rendered text rect.
It selects changed glyph pixels consistent with antialiasing between the declared
foreground and measured backing, excluding unchanged input borders. The foreground
used for contrast is read from the normal PNG, not assumed from computed style:
all 84 selected foregrounds match an actually painted pixel exactly (RGB delta 0).
That observed solid text color is compared with backing pixels under its glyph
footprint; antialiased edge pixels are not treated as new text colors. Coordinates,
RGBs and counts are recorded for each sample. The threshold is independently 4.5:1.

Across 21 texts × 2 modes × 2 map backings, the placeholder FAILS in dark mode:
4.0046:1 over land and4.1003:1 over sea. Light minima are4.7138/4.6958. The other 20
selected texts remain above 4.5. The shared Surface/TextField paint/backing owner is
being corrected separately. This sample does not establish all text, all backdrops,
all browsers or all of issue 663 §9.

## Reproduction

Start the isolated frontend with `EXPO_PUBLIC_OXY_CLIENT_ID=fixture-goway` and
`expo start --web --port 8132`, with the exact built Bloom candidate mirrored using
Bloom's consumer mirror helper. The scripts supply only the synthetic OAuth
registration response; other public GETs use the actual service. External writes
are blocked. Set `PLAYWRIGHT_PACKAGE_JSON` to an installed Playwright project and
`CHROME_PATH` to Chromium; the recorded run used Chromium 1248.

Run from GoWay root:

```sh
BASELINE_OUTPUT=packages/frontend/.local/issue-663/browser-runs/focus node scripts/canvas-pilot/focus.mjs
COARSE=1 ROOM_WIDTH=320 BASELINE_OUTPUT=packages/frontend/.local/issue-663/browser-runs/targets-320 node scripts/canvas-pilot/targets.mjs
SAFE_AREA='{"top":24,"left":32,"right":20,"bottom":28}' BASELINE_OUTPUT=packages/frontend/.local/issue-663/browser-runs/safe-area node scripts/canvas-pilot/safe-area.mjs
MODE=light BASELINE_OUTPUT=packages/frontend/.local/issue-663/browser-runs/contrast-light node scripts/canvas-pilot/contrast.mjs
MODE=dark BASELINE_OUTPUT=packages/frontend/.local/issue-663/browser-runs/contrast-dark node scripts/canvas-pilot/contrast.mjs
node scripts/canvas-pilot/measure-contrast.mjs
```

The measurement needs `pngjs`; `PNG_PACKAGE_JSON` can point at a package where it
is installed. `CANVAS_URL`, `ROOM_HEIGHT`, `CONTRAST_ROOT` and `CONTRAST_OUTPUT`
override the corresponding local defaults. Restore the mirror before validating
normal installed packages. The current published dependency cannot provide the
new Canvas API and is not claimed to pass this candidate's typecheck.

## Still pending

Published Bloom adoption and final package gates; header actions still wrap;
shared placeholder contrast correction and neighbor measurements; actual GoWay
Android renderer pan/pinch, camera, attribution and keyboard validation; TalkBack
reading/focus. The separate offline Canvas APK is not a native-map substitute.
iPhone is deferred by the user. No global visual or accessibility acceptance is
claimed by this checkpoint.

## Checkpoint verification

Candidate mirror: frontend 1,876 tests and maps 155 tests passed; frontend typecheck passed. Biome checked 1,270 files. Metro was stopped and the mirror restored; frontend and maps now both resolve the installed Bloom 17.19.3. These are candidate-source results, not published-package acceptance.
