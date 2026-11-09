# GoWay contrast after enclosing degraded backdrop paint

Candidate verification only: GoWay 2e9a65e with locally built Bloom combination
17ed628a (Canvas 9f1fe561 and optics through fdc3827c), based on main 82d89f8b.
The package string remains 17.22.0, while GoWay declares 17.19.3. Neither is a
published adoption claim; compiled source hashes identify the tested candidate.

All 84 painted samples clear 4.5, minimum 4.623069, exact foreground match delta
zero. Against the previous filtered-only candidate, all 80 neighboring text
ratios, foregrounds and sampled backings remain identical. No target worsens.
Only the two light placeholders change: land 6.931037 → 9.470253 and sea
6.904573 → 9.434094. Dark placeholders remain 8.216599 and 8.412782.

The screenshots retain the full viewport and paired ink-hidden painted backing.
Captures use actual public land/sea map scenes, signed out, with only a synthetic
OAuth application registry response. Both modes report zero errors, blocked
writes and location requests. No business action was exercised.

Reproduce using scripts/canvas-pilot/{contrast,measure-contrast,compare-contrast}.mjs.
The comparator matches ordered target indices and asserts mode/scene/text;
repeated labels are not treated as unique keys. Source and artifact hashes are
recorded alongside results and deltas.

This comparison verifies these scenes and these 84 texts. It does not close
unknown RGB coverage, mono/graphite, native accessible font scaling, the dense
material optical parity in WebKit/Firefox, full header/safe-area acceptance,
real native map gestures/TalkBack, or published adoption. The separate real
Android build exposed a MapLibre hillshade bridge incompatibility that is being
fixed and verified in its source; an APK build alone is not native acceptance.
