# `@goway.to/maps/testing` API reference

A fake engine that drives the map's real web camera reports, for testing what a screen does with `onCameraChanged` without a GPU. See [Testing](../guides/testing.md).

| Export | Signature | What it does |
| --- | --- | --- |
| `fakeCameraEngine` | `(start?: Partial<FakeCamera>) => FakeCameraEngine` | a MapLibre map as far as the camera reports see it |
| `attachToFake` | `(engine: FakeCameraEngine, withListener?: boolean) => { changes; finals(); advance(ms); detach() }` | attach the real reports and record them |
| `PROGRAMMATIC`, `PROGRAMMATIC_TRANSIENT` | | the move markers, as in [`@goway.to/maps/plugin`](plugin.md#move-markers) |

| Type | Shape |
| --- | --- |
| `FakeCamera` | `{ lat; lng; zoom; bearing; pitch; span }`; `span` is half the visible box, in degrees |
| `FakeCameraEngine` | `{ camera: FakeCamera; fire(type, event?); move(event, to?); listenerCount(); on; off; getCenter; getBounds; getZoom; getBearing; getPitch }` |

A fresh engine starts at `{ lat: 41.4036, lng: 2.1744, zoom: 16.5, bearing: 30, pitch: 60, span: 0.01 }` unless `start` says otherwise. `move(event, to)` fires `movestart`, `move` and `moveend` with `event`, applying `to` to the camera in between. An event with an `originalEvent` is a gesture.
