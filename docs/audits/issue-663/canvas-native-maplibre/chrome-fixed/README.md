# Native credit placement after local viewport compensation

Product correction: `937d279`. Private packaged APK SHA-256:
`f06d9a66665e82f45010202ae57e1cc7bd8c0d6e4653396425e2f343f725083e`.
The full APK, test APK, Hermes bundle, source map and private source delta are
retained in the native fixture's `.local/issue-663/native/artifacts/<APK SHA>/`;
`manifest.json` pins each file. The map bridge remains private source-built
11.5.1-canvas663.2 and Bloom remains the private validation build, not published
adoption. Test input and release-runtime conventions match `../packaged-runtime`.

The physical test passes pan, broader pinch (zoom 11→12.959439), all three
controlled detents, IME opening and Back dismissal. Native view/engine identities
and the resulting camera persist through each panel/keyboard transition.

During IME, credit bounds move from the baseline y1609–1714px to y711–816px;
scale bounds move from y1521–1598px to y623–700px. The panel starts at y827px.
The 898px correction equals the measured Canvas-local bottom exclusion; no
keyboard-height constant or extra keyboard subscription is used. Without IME,
credit returns to y1205–1310px above panel y1321px, matching the baseline.
Screenshots confirm the credit and scale are actually painted above the panel.

Eleven focused policy/occupancy tests pass, including an embedded host with a
nonzero origin/local clipping and an already resized host with zero exclusion.
The shared value follows live panel height; camera fitting and state are unchanged.
The embedded coordinate cases are unit evidence, not a new browser acceptance run.

This closes the measured placement regression only. Expanded legal-link hit
targets, TalkBack reading/focus, enlarged native text, selected-place retention,
header layout and published-package adoption are still pending. The earlier slow
pinch remains below the renderer's start-speed threshold; it is not rewritten as
a passing gesture. No device settings changed and only the private app was stopped
at handoff.
