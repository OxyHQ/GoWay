# Examples

Complete, copy-pasteable programs that use `@goway.to/sdk`. The TypeScript programs run in Node 18+ or Bun as they are; the React examples render with `@goway.to/maps` and work on web and React Native. None needs an account unless it says so.

| Example | What it shows |
| --- | --- |
| [Nearby places with a capability filter](./nearby-with-capability-filter.md) | `places.nearby` with `capabilities`, distance, "open now" and links. |
| [Search as you type](./search-as-you-type.md) | `search.query` with debouncing, cancellation through `AbortSignal`, and a viewport bias. |
| [Reverse geocode a tap](./reverse-geocode-tap.md) | `geocode.reverse` from a `MapView` press, cancelling the previous lookup. |
| [Route between two points and draw it](./route-and-draw.md) | `routes.directions`, a `GeoJSONSource` and `Layer`, framing the camera, and "no route" handling. |
| [Walk all pages](./walk-all-pages.md) | `iterateGoWayPages` over `places.inBounds`, stopping early. |
| [Handle errors](./handle-errors.md) | Error classes, `retryable`, backoff, following a merged place. |
| [Live vehicles](./live-vehicles.md) | The `@goway.to/sdk/live` socket protocol with `socket.io-client`: subscribe, snapshots, deltas, credits. |
| [Refresh stored place ids](./refresh-stored-places.md) | `places.getMany` in batches, following merges and dropping retired ids. |

For explanations, start with the [guides](../README.md#guides).
