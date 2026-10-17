# GoWay developer documentation

GoWay is Oxy's map platform: its own cartography, places, search, geocoding and routing. These pages are how to build on it, from an app that only needs a map to a service that calls the API directly.

## Products

| Product | Package | What it is for |
| --- | --- | --- |
| [Maps SDK](maps/README.md) | `@goway.to/maps` | a declarative map for React and React Native: GoWay styles, Bloom markers and clusters, the camera by value, user location |
| [GoWay SDK](sdk/README.md) | `@goway.to/sdk` | a typed client for GoWay's services: places, search, geocoding, routing, live data, canonical links |
| [Map styles and tiles](styles/README.md) | (no package) | the published styles, their `goway://` names and document URLs, and the vector tile schema, for any MapLibre renderer |
| [HTTP API](api/README.md) | (no package) | the REST API the GoWay SDK wraps, operation by operation |

## Where to start

- **Show a map in a React or React Native app:** [Maps SDK](maps/README.md), then the [examples](maps/examples/README.md).
- **Find places, search, geocode or route:** [GoWay SDK](sdk/README.md). Results are ready to draw with the Maps SDK.
- **Use GoWay's cartography in your own MapLibre setup:** [Map styles and tiles](styles/README.md).
- **Call GoWay from another language or a server:** [HTTP API](api/README.md).

## Conventions

- Coordinates are objects, `{ latitude, longitude }`, and boxes are `{ west, south, east, north }`. A box with `west > east` crosses the antimeridian. Positional `[longitude, latitude]` pairs appear only inside GeoJSON, where the format requires them.
- Every page is written from the code on `main`. Each package's API reference names every export, and a check keeps it that way.

## Each product's pages

Like docs.mapbox.com, each product has:

- an **overview** with installation and a quick start;
- **guides**, one per topic;
- **examples**: complete code you can paste;
- an **API reference**.
