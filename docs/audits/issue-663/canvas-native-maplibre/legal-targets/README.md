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
