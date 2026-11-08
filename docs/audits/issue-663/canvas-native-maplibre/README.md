# Native map checkpoint — private source build

This is an incomplete Android validation checkpoint, not published-package adoption.
The signed-out GoWay fixture uses a real MapLibre renderer and public map data;
external mutations are blocked by the private entry point (fetch and XHR).
No location action was invoked. Absence of a permission dialog does not establish
that every native location API was instrumented.

## Source and build

`maplibre-source-provenance.json` records upstream v11.5.1, the exact source commit,
private package digest, resolved Android core 13.6.1, toolchain and both APK hashes.
Apply `maplibre-source.patch` to upstream commit
`6941f96d1c7bc0e52847663d46935dc43e3ce2ab`; the separate private-package patch
sets the isolated test artifact version. No fork has been published. The Android
style generator and generated setters accept scalar number/color values alongside
arrays; expression branches remain intact. iOS sources are unchanged and unverified.
Run the source checkout's codegen, lint/types, Jest and prepack before packing.
The source suite passed 26 suites, 274 tests and 9 snapshots.

The installed bridge test APK passed three physical Pixel 8a/API 36 cases,
including direction/altitude, arrays/expressions and color alpha. These cases do
not establish application gesture behavior. Original 11.4.1 also crashed in a
map-only fixture with Canvas removed (`no-canvas-crash.txt`), so the scalar bridge
incompatibility predates this adoption. Current native hillshade values and the
rendered map are retained in the probe log and screenshot.

The original Gradle audio dependency task eventually downloaded its official
artifact successfully. `audio-build-provenance.json` records the comparison;
there was no manual extraction. The private generated manifest removes only
permission declarations owned by the installed ecosystem app, retaining uses;
no production configuration or ecosystem signing was changed.

## Real map results and remaining work

- Pan changed longitude while retaining both native view and engine identity.
- Native hillshade shadow/highlight values match the configured map style.
- Both pinch attempts left zoom at 11 despite native zoom gestures being enabled.
  The system injection takes approximately 0.5 seconds per event even when the
  public UiAutomation call requests asynchronous injection. This is an unresolved
  input-versus-product diagnosis, **not a pinch pass**. Both failures are retained.
- The failing pinch assertion prevented subsequent detent/IME/Back assertions.
  Those checks remain unverified; the probe source is provided for continuation.
- Expanded attribution is visible. Its native link bounds are text height with
  hit slop; actual reachability/target separation still needs physical verification.
- TalkBack reading/focus, native enlarged text, optical parity and published
  dependency adoption remain unverified. Browser results do not fill these gaps.

The fixture uses Bloom validation source `17ed628a` and GoWay base `2e9a65e`.
Its MapCanvas diagnostic logs mount identity and camera without changing camera
policy. Device settings remained portrait, font scale 1.15, 1080×2400 at density
420. The fixture was force-stopped and its tcp:8081 reverse removed before handoff.
