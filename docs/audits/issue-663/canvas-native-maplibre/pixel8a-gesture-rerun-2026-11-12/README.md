# Pixel 8a body scroll and map overlay follow-up — 2026-11-12

## Result

The filtered `realMapPanPinchDetentsAndKeyboard` instrumentation test passed on the USB Pixel 8a (Android 16/API 36, serial `43221JEKB12200`) using the isolated GoWay Canvas Lab build. The test created deterministic overflow by inserting a tall native sentinel into the Explore scroll content. It confirmed `canScrollVertically=true`, scrolled from `scrollY=0` to `557`, and kept the sheet at its expanded detent (`snap=2`). It then injected a horizontal pan in the visible map area above the panel and confirmed map longitude changed while native map/view identity stayed stable and the panel remained expanded.

This follow-up closes the prior harness gap around body scroll and native map-under-panel gestures. The body overflow is test-fixture content, not a claim that the current product data naturally overflows. It verifies native scroll arbitration on device. Web pointer events outside the panel are not covered by this Android result; the combined GoWay §5 checklist item remains unchecked until that path is independently verified.

## Build and package limits

This was the isolated GoWay Canvas Lab app, not the production GoWay app or a published package. It used the private MapLibre Canvas Lab fixture described in the adjacent `pixel8a-gesture-rerun-2026-11-11` report. iOS was not tested, per the user's instruction.

## Reproduction

From `packages/frontend/android` in the isolated worktree:

```bash
ANDROID_HOME=/home/nate/Android/Sdk \
ANDROID_SDK_ROOT=/home/nate/Android/Sdk \
ANDROID_ADB_SERVER_PORT=5038 \
ANDROID_SERIAL=43221JEKB12200 \
./gradlew :app:connectedCanvasLabAndroidTest \\
  -PreactNativeArchitectures=arm64-v8a \\
  -Pandroid.testInstrumentationRunnerArguments.class=to.goway.canvas663.CanvasMapProbeTest#realMapPanPinchDetentsAndKeyboard \\
  -Pandroid.testInstrumentationRunnerArguments.fastPinch=true
```

The build passed in 50 seconds. `CanvasMapProbeTest.kt` and the captured device logcat are stored beside this report.
