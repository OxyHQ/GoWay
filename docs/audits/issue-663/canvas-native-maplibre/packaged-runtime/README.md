# Packaged Android runtime: map interaction and keyboard

This private `canvasLab` variant inherits release behavior, bundles Hermes and
disables development support. It keeps native minification off for instrumentation
and uses the isolated debug certificate/application ID; it is not a production
release. The normal product release-signing gate is unchanged. The manifest was
verified non-debuggable and declares only its private receiver permission.
No Metro connection or reverse was used; warnings remain logged.

`packaged-build-receipt.json` identifies the first app/bundle/sourcemap and initial
test. `region-manifest.json` identifies the later **af0b40e4…** APK with a private
Canvas-region logger, its exact instrumented test, bundled source and source map.
That full artifact set is retained locally under the receipt's SHA directory;
the reproduction source delta and instrumentation source are checked in here.
The product source was unchanged by that logger. The viewport correction is
commit `937d279` and is **not** present in these baseline APKs.

## Measured interaction

The broader pinch test passes pan, pinch, full → peek → half, keyboard opening,
and Back dismissal. Native map/view identity and the post-pinch camera are
preserved across all three detents and keyboard changes. The visible error branch
for unavailable places is captured honestly; result selection has not been
verified by this test. No location action or business write was invoked.

The original slow pinch remains a negative. The installed core 13.6.1 scale
listener requires a minimum span speed; its AAR resource is
`maplibre_minimum_scale_speed=0.6dp` (1.575px/ms at this density). The slow test's
observed detector span changes around 18px per 17ms fall below that floor.
The broader test uses the same system dispatcher, detector and app configuration;
its two pointers start 160px apart and end 736px apart over roughly 450ms.
It enters scale progress and changes zoom from 11 to approximately 12.96.
The motor's threshold was not modified to make the test pass.

## Confirmed credit-placement defect

Without IME, the collapsed credit occupies y1205–1310px, immediately above the
panel at y1321px. With IME, the panel moves to y827px, but the credit instead
occupies y1609–1714px and the scale y1521–1598px: both are behind the panel/keyboard.
Android's `getGlobalVisibleRect` still reports them visible; screenshots show why
that flag is not an occlusion/hit-test proof.

The Canvas owner reports bounds height 914.285706dp, visible viewport height
572.190491dp and viewport y0 during IME. Their difference is 342.095215dp,
approximately 898px at density 2.625. The live panel height excludes that lower
region, while the resting edge claim includes it. The adapter's former subtraction
cancels it, explaining the measured placement error. The correction must use this
local viewport difference, not a new keyboard observer or a guessed keyboard size.
An already resized container must contribute zero extra clearance.

TalkBack reading/focus, native enlarged text, attribution-link targets, selection,
full optical parity and published dependencies remain separate pending criteria.
These passing interaction records do not accept the scene globally.
