# Testing

What a screen does with `onCameraChanged` (arm "Search this area", commit a box) is the screen's own logic, and the sequences that matter are the ones a real map produces: the opening camera, a programmatic frame, a drag. `@goway.to/maps/testing` runs the SDK's real web camera reporting against a fake engine, so you can test that logic without a GPU.

```ts
import { describe, expect, it } from 'bun:test';
import { attachToFake, fakeCameraEngine, PROGRAMMATIC } from '@goway.to/maps/testing';

describe('search this area', () => {
  it('arms on a drag, not on the opening frame', () => {
    const engine = fakeCameraEngine({ lat: 41.39, lng: 2.17, zoom: 11 });
    const reports = attachToFake(engine);

    engine.fire('load'); // the camera the map opened at
    engine.move(PROGRAMMATIC, { zoom: 13 }); // the app frames the results
    engine.move({ originalEvent: {} }, { lng: 2.2 }); // the reader drags

    expect(reports.finals().map((change) => change.source)).toEqual(['programmatic', 'programmatic', 'user']);
  });
});
```

## `fakeCameraEngine(start?)`

A stand-in for a MapLibre map, as far as the camera reports see it. `start` overrides the camera (`lat`, `lng`, `zoom`, `bearing`, `pitch`, and `span`, half the visible box in degrees).

| Member | What it does |
| --- | --- |
| `camera` | the current `FakeCamera`, mutable |
| `fire(type, event?)` | fire one engine event (`load`, `movestart`, …) |
| `move(event, to?)` | a whole move as MapLibre fires it (`movestart`, `move`, `moveend`), ending at `to` |
| `listenerCount()` | how many listeners are attached (to test that detaching cleans up) |

A move whose event has an `originalEvent` is a gesture (`user`). `PROGRAMMATIC` and `PROGRAMMATIC_TRANSIENT` (re-exported here) mark a move as the app's.

## `attachToFake(engine, withListener?)`

Attaches the real reporting and records what it reports.

| Member | What it is |
| --- | --- |
| `changes` | every `MapCameraChange`, in order |
| `finals()` | the settled ones (`isFinal: true`) |
| `advance(ms)` | move the reporter's clock (live reports are throttled to one per 100 ms) |
| `detach()` | stop reporting |

`withListener: false` attaches with no `onCameraChanged`, as a map without one.
