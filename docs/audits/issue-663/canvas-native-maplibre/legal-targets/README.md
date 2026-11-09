# Native legal target probe — incomplete matrix

Pixel 8a Android 16, density 2.625/font 1.15. Private packaged GoWay app source
includes 937d279, app SHA256 f06d9a66665e82f45010202ae57e1cc7bd8c0d6e4653396425e2f343f725083e.
The input probe intercepts external ACTION_VIEW intents and records destinations;
no external page opens.

The toggle center (991,1257) opens attribution, but its 48 dp-target top edge
(991,1195) does not. OpenMapTiles center (284,1175) invokes the exact legal URL;
the top edge (284,1113) does not. These are valid negative samples, not a full
44/48 dp-region characterization. The current layout uses compact link/button
geometry and hitSlop inside a clipped plate. Ancestor geometry was not logged
in this first probe and must be measured in the repeat.

Discard the remaining link results: the probe reused View references after an
activation unmounted them (later coordinates y 24/-38 show the invalid sample).
Their false results do not prove an inaccessible legal link. The test process
reported OK because it collected diagnostics, not because all targets passed.

A repeat must requery attached, shown nodes after each disclosure or activation,
measure Pressable and ancestor bounds, and test actual callbacks at edges and
center. Peek/half/full/IME and TalkBack remain pending.

## Revalidation after native target sizing

The focused consumer change in `packages/maps/src/MapAttribution.tsx` reserves
48 dp for Android and 44 dp for iOS; Android hitSlop is zero so adjacent links
do not overlap. Source SHA256:
`de89cd69652f87b81f6dca018bb93c794d8904a14b2c7061a23a5a94a8b867e3`.

Revalidated on a physical Google Pixel 8a (`akita`), Android 16 / API 36,
420 dpi, 1080×2400, app `to.goway.app`. Bloom 17.24.0 was mirrored from the
local candidate. The GoWay branch was `feat/issue-663-canvas` based on
`d0ff949cd01ddb7bcc54de31f3391a3725a82535`, plus the attribution sizing change
recorded above. Every top, center, bottom, left,
and right coordinate was tapped for both legal links. All ten taps opened the
expected external domain; after every return, a fresh UI hierarchy found the
same attached target bounds. OpenMapTiles measured 302×126 px and OpenStreetMap
327×126 px (48 dp high each). Both fit inside the clipping parent bounds
`[21,1037][1059,1310]`.

Evidence: [`legal-targets-after.json`](legal-targets-after.json),
SHA256 `8774c8db9000c92ddf2b4df26df1a25dd4c0762c723a106844070d68f1edf5fa`;
expanded capture [`legal-expanded-after.png`](legal-expanded-after.png),
SHA256 `3c3fb38fd93595908e0f5570f824a63bc5f143e2aa814bb747f45c02501a988c`.
The debug APK SHA256 is
`05e056e0cf2e6750c7c6f22d2f2e6ee24a4dd8126544a3878f2653cc846083ce`.

Two test-environment accommodations limit the claim: the generated local
Android manifest omitted Oxy signature permissions so this debug app could
coexist with installed `so.oxy.commons`; and Metro selected `openfreemap`
because the current native GoWay hillshade style independently crashes in
`MLRNStyleFactory.setHillshadeIlluminationDirection`. This confirms hit testing,
browser handoff, target bounds, and clipping for the actual GoWay attribution
component on a device. It does not validate that style, the production manifest,
panel detents/IME/TalkBack, or the complete production map interaction matrix.
