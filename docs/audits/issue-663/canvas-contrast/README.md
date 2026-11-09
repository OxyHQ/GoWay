# GoWay contrast candidate repeat

This is candidate-source verification, not published-package acceptance. GoWay
58dd79e uses the built local combination ddd2b048: Canvas b0b27845 plus the
Surface calculation and TextField correction a14ddf22/0d21ec4c. The manifest pins
compiled files, lock and comparison script. Bloom's package string is 17.22.0;
GoWay still declares 17.19.3. Neither string by itself identifies this candidate.

All 84 actual painted text samples clear 4.5:1, with foreground match delta zero.
The same 20 neighboring targets occur in each scene. All 80 neighbor ratios,
foregrounds and worst backing pixels are unchanged; only the four placeholders
change. No target worsens.

| Placeholder scene | Before | After |
| --- | ---: | ---: |
| Light land | 4.714 | 6.931 |
| Light sea | 4.696 | 6.905 |
| Dark land | 4.005 | 8.217 |
| Dark sea | 4.100 | 8.413 |

The dark placeholder now uses the existing semantic primary foreground where
the conservative quiet-text calculation cannot choose a quieter candidate.
This is a result on these actual map scenes, not a guarantee over every RGB
sampler or a change to the global primary token. Full screenshots and paired
ink-hidden screenshots retain the painted backing. The baseline methodology
and negative captures remain in `../canvas-candidate/`.

Reproduce capture and measurement with `scripts/canvas-pilot/contrast.mjs` and
`measure-contrast.mjs`, using the source candidate in `source-manifest.json`.
Compare with `compare-contrast.mjs`, setting `CONTRAST_BEFORE`, `CONTRAST_AFTER`
and `CONTRAST_DELTA`. The comparator matches the ordered target index and asserts
mode/scene/text equality. Text alone is not a key: two "Closed" labels per scene
caused a discarded exploratory comparator to report two false improvements.
The committed deltas use indexed identity and show 80 unchanged neighbors.

Android's real GoWay entry also bundled successfully (HTTP 200, 5,027 modules)
with its current explicit React Compiler opt-in and preset version recorded in
the manifest. This is only a compile preflight, not an APK, native map or
TalkBack result. No location request occurred in the web captures. External
writes remained blocked by the browser fixture.

Still pending: the dense WebKit fixture has a separate negative under
investigation; native map/device and accessible text scaling; actual published
Bloom adoption; complete safe-area/chrome and header acceptance. The library's
mono/graphite unknown-backing cases also remain explicitly uncertified. None of
those holds are closed by these 84 pixels.
