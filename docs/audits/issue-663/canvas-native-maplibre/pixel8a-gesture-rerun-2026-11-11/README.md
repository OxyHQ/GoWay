# Pixel 8a map gesture rerun — 2026-11-11

## Result

The cleaned private Canvas Lab build passed the updated map gesture instrumentation test on the USB Pixel 8a (Android 16/API 36, serial `43221JEKB12200`). It used `fastPinch=true`. The map's native view and map identities stayed constant across pan, pinch, panel detents, handle drags, keyboard, and Back. Pan changed longitude. Pinch changed zoom from `11` to `12.9446`. All three detents settled. Dragging the handle expanded the sheet and returned it to half while the camera stayed unchanged. The keyboard opened and closed. A separate full-suite run on the same cleaned APK passed `legalTargets`; all 19 sampled attribution toggle/link edge points activated. See `legal-targets-summary.json` for the sample outcomes.

The default slow synthetic pinch (`40px` initial half-span, `5px` per move) failed to change zoom on the same cleaned build; detents and keyboard/Back still completed before that final assertion. The passing profile uses an `80px` initial half-span and `12px` per move. The logs preserve both outcomes: Android gesture injection on this device accepts the wider/faster sequence, while the narrow/slow synthetic sequence does not. These are system-injected motion events on a physical device; no human physical pinch was performed.

## Build and package limits

This was an isolated Canvas Lab application, not the GoWay production application. It used the private `11.5.1-canvas663.2` MapLibre tarball at SHA-256 `21a51e9d35c83e692dc6e07ba7c5ee3e54e6d04c3bc4bafdd7e83a2a91b8ad15`. The patch in `maplibre-style-test.patch` adds Android hillshade scalar/color conversion and instrumentation tests; the Android `MLRNMapView.kt` gesture implementation is unchanged from public MapLibre `11.5.1`. The cleaned test APK SHA-256 was `dfa22dbe17df9e23f24101115c265d9ebf1820e42a9ca8e52431a1c4206e31a1`.

GoWay main still needs validation with an unmodified, published package and its production native build before this evidence can establish shipped behavior. iOS was not tested, per the user's instruction.

## Reproduction

From `packages/frontend/android` in the isolated worktree, with the private package fixture installed:

```bash
ANDROID_HOME=/home/nate/Android/Sdk \
ANDROID_SDK_ROOT=/home/nate/Android/Sdk \
ANDROID_ADB_SERVER_PORT=5038 \
ANDROID_SERIAL=43221JEKB12200 \
./gradlew :app:connectedCanvasLabAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.fastPinch=true
```

The captured updated test source, passing and failing filtered device logs, edge-target summary, style-test patch, and APK hash are stored beside this report.

## Interaction follow-up

A follow-up on the same Pixel 8a verified Android Back from the half-open panel to `peek`, with map and native view identities retained. The test then tried a `Paris` search to produce a long Explore results list, but the screen had no overflowing body content (`scrollY` stayed at 0), so body-scroll arbitration could not be exercised. The instrumentation run therefore ended at that assertion; this is **not** a scroll pass. `android-run-interaction-followup.log` preserves the panel-Back observation and the no-overflow result. The existing §5 checklist item remains unchecked until body scrolling, map-under-overlay interaction, and outside-panel pointer behavior are verified.
