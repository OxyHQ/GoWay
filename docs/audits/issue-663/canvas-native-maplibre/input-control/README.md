# System-input control and matrix limits

The public two-argument Android UiAutomation injection method always waits for
window animation fences, even with `sync=false`. The private instrumentation now
uses AOSP's three-argument test API with `waitForAnimations=false`; it still
injects through the system input dispatcher. Device animation settings were not
changed. A forwarding Window.Callback logs actual delivered pointer IDs/counts.
Both fingers (IDs 0 and 1) reached the window, with the complete pinch taking
approximately 450 ms. No hidden API is used by production code.

Pan changes longitude and retains both native map/view identities. Pinch still
leaves zoom at 11. The same app APK, source-built bridge and renderer were then
run with only `MapCanvas` in a flex View: no Canvas, CanvasBackground or panel.
That control also pans and does not zoom. This is an unresolved map/gesture-input
issue, not evidence of a Canvas-specific regression. Window delivery does not
yet establish that both pointers reach the map's scale detector.

The panel matrix initially assumed peek incorrectly: GoWay starts at half.
`handleValue` records that fact. Later records show movement and delayed
accessible values, but a debug notification then opened LogBox over the app.
`canvas-ime.png` identifies the error as application-classification timeout.
Consequently the failed IME assertion is not an accepted field regression, and
this run does not verify detents/IME/Back end to end. Future runs must wait for
actual settled values and confirm that debug overlays are absent before input.

The control source is preserved here and was restored immediately afterward.
The private fixture was force-stopped, its reverse removed, and device settings
rechecked unchanged before handing the Pixel back. All earlier negative runs
remain intact. No published package, TalkBack reading, native font scaling or
iPhone acceptance is claimed.
