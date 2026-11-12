# Canvas and panel interaction — 2026-11-12

## Web pointer and Escape

GoWay's isolated Canvas Lab was started with its deterministic development fixtures and opened in headless Chromium at 1440×900. The persistent Explore panel occupied x=16–400 while the map canvas filled the window. A synthetic pointer drag from (900,430) by 240×40 px changed 165,372 pixels in the sampled map region; two no-input baseline captures had zero changed pixels. There were no page errors. The before/after screenshots and machine-readable result are adjacent to this report.

The map-style picker was opened as a real dialog overlay. Pressing Escape closed the dialog and left the persistent panel visible. Screenshots record the open and dismissed states.

## Android native gestures and scroll

On the USB Pixel 8a (Android 16/API 36, serial `43221JEKB12200`), the filtered instrumentation method `realMapPanPinchDetentsAndKeyboard` passed on 2026-11-12. It verifies native map pan and pinch, panel detent and handle gestures, keyboard and Back behavior, body scroll, and map interaction above the expanded panel. The deterministic scroll fixture produced `scrollHeight=1203`, `contentHeight=1923`, `before=0`, `after=557`, with panel `snap=2`. The camera changed on the visible map pan while the native map and view identities remained stable.

Both web pointer input and Android motion events were system-injected, not human gestures. The scroll overflow came from a test-only sentinel added to the native scroll container, not naturally overflowing product results.

## Scope

Web and Android behavior are verified against the local, isolated GoWay Canvas Lab. It is not the production GoWay binary or the published MapLibre package. This evidence does not establish behavior in shipped GoWay or Bloom package consumers. iOS testing is omitted per the user's instruction.

## Attribution and keyboard geometry

On the same Pixel, `CanvasMapProbeTest.legalTargets` passed at the `peek` detent and again at the expanded detent with the Android keyboard visible. In the expanded keyboard run, 20 toggle/link center and edge samples all activated. The structured log records the full `1080×2400` device bounds, expanded handle, IME visibility, and visible rectangles for the data credit, its toggle, and the map scale bar. See `android-legal-full-keyboard.json` and `android-legal-full-keyboard-logcat.txt`. The test fixture exercises attribution and scale geometry; it does not cover every conditional GoWay banner or directions state, so the broader placement checklist remains open.

## Positioning on a phone-sized web viewport

At Chromium 390×844, the persistent panel began at y=464.2. The top bar, map settings/style stack, map controls, credit/toggle, and scale bar all rendered within the visible map region. After a 300 px user-map drag, “Search this area” appeared at x=118, y=128, 154×40 px, below the top bar and left of the right-hand control stack. `mobile-390x844.png`, `mobile-390x844.json`, and `mobile-search-area.png` show those measurements/states.

Selecting the fixture place and opening Directions produced the real directions panel. The location-permission notice remained above that panel, alongside visible map controls and the attribution control; `mobile-directions.png` captures the state. The native Pixel runs cover attribution in the peek state and with the expanded panel plus keyboard, sampling all 20 edge/center toggle and link points successfully. The tested interaction code exercises attribution/scale and the listed visible geometry; it does not exhaust every conditional banner, route failure, or landscape geometry.

The web run returned two HTTP 503s from `/api/v1/live/sources`; the map rendered and pointer interaction completed without page errors. These requests are outside the tested pointer/positioning path and are recorded as an environment limitation, not treated as a successful live-services check.

## Focused checks

- `bun test packages/frontend/lib/map/__tests__/canvas-policy.test.ts`: 4 passed.
- `bun test packages/maps/test/creditNative.test.ts`: passed after extending its native mock to include `Platform.select`; the probe also asserts the Android 48×48 dp target and zero hit slop.
- `bun test` for `compactCredit`, `labelHits`, and `creditLabels`: 50 passed.
- `bun run lint`: passed. Biome reports an informational pre-existing redundant fragment in `ExploreScreen.tsx`.
- `bun run typecheck`: blocked by existing errors in `node_modules/@oxy.so/services/src/ui/hooks/useSurfaceHeader.ts` where `HeaderAction` lacks `accessibilityLabel`; no type errors point to the changed GoWay files.
