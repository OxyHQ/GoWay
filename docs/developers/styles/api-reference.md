# Map endpoints

Every public endpoint under `https://goway.to/map/`, with its parameters, responses and caching. These are plain HTTPS resources, not `/api/v1` operations: they need no key or session and are the same for every caller. MapLibre fetches them for you once a style is loaded; you only call them yourself to build your own style or tooling.

## Common behaviour

- **Methods.** `GET` and `HEAD`. The tile, glyph, elevation and contour endpoints also answer a CORS preflight (`OPTIONS`) with `204`, and any other method with `405` and `Allow: GET, HEAD, OPTIONS`.
- **CORS.** Every response carries `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, so pages on any origin can use them, including pages that enable cross-origin isolation (`Cross-Origin-Embedder-Policy: require-corp`). No credentials are needed or accepted.
- **Errors.** A path that is not a valid address (a zoom out of range, a coordinate outside the world, a malformed glyph range) is `404` with a short `text/plain` explanation. These are not JSON error envelopes like the HTTP API's.
- **Caching.** Each endpoint sets `Cache-Control` as listed below. URLs are not versioned; the cache lifetimes are what bound how long an update takes to reach clients.

## Summary

| Endpoint | Content | `Cache-Control` |
| --- | --- | --- |
| `GET /map/styles/index.json` | Style catalogue (JSON) | `public, max-age=300, must-revalidate` |
| `GET /map/styles/{style}/{light}.json` | Style document (JSON) | `public, max-age=300, must-revalidate` |
| `GET /map/goway-light.json`, `GET /map/goway-dark.json` | Older style document URLs (JSON) | `public, max-age=300, must-revalidate` |
| `GET /map/tiles.json` | TileJSON for the vector tiles | `public, max-age=300, must-revalidate` |
| `GET /map/tiles/{z}/{x}/{y}.pbf` | Vector tile | `public, max-age=86400` |
| `GET /map/fonts/{fontstack}/{range}.pbf` | Glyph range | `public, max-age=86400` |
| `GET /map/sprites/goway.json`, `.png`, `@2x.json`, `@2x.png` | Sprite index and image | `public, max-age=86400` |
| `GET /map/terrain/{z}/{x}/{y}.webp` | Elevation tile | `public, max-age=604800` |
| `GET /map/contours/{z}/{x}/{y}.pbf` | Contour line tile | `public, max-age=31536000` |

## Styles

### `GET /map/styles/index.json`

The catalogue of offered styles: each id, whether it follows the light, the lights it is published in, its default light and the URL of every document. Field reference: [The catalogue document](README.md#the-catalogue-document).

### `GET /map/styles/{style}/{light}.json`

One style document, a MapLibre style (version 8).

| Parameter | Values |
| --- | --- |
| `style` | `standard`, `streets`, `outdoors`, `navigation`, `monochrome`, `light`, `dark` |
| `light` | `day`, `dawn`, `dusk`, `night`, where the style is published in it ([table](README.md#styles-and-lights)) |

There is no fallback at this level: ask for the exact pair the catalogue lists. To turn "this style, roughly this light" into a URL, see [How a light is resolved](README.md#how-a-light-is-resolved).

### `GET /map/goway-light.json` and `GET /map/goway-dark.json`

Byte-for-byte copies of `standard/day.json` and `standard/night.json`, kept for clients built before the catalogue. Prefer the catalogue URLs in new code.

## Vector tiles

### `GET /map/tiles.json`

TileJSON 3.0.0 for GoWay's vector tiles: the tile URL template, zoom range 0 to 14, bounds and attribution. See [Tiles](guides/tiles.md#vector-tiles).

### `GET /map/tiles/{z}/{x}/{y}.pbf`

One Mapbox Vector Tile in the OpenMapTiles v3 schema.

| Parameter | Values |
| --- | --- |
| `z` | `0` to `14` |
| `x`, `y` | `0` to `2^z - 1` |

| Status | Meaning |
| --- | --- |
| `200` | The tile, `application/vnd.mapbox-vector-tile`. Sent with `Content-Encoding: gzip` when the request accepts gzip, uncompressed otherwise (`Vary: accept-encoding`). |
| `404` | No data in this tile (open ocean, for example), or `z`, `x` or `y` out of range. MapLibre draws a missing tile as empty. |
| `502`, `503` | The tile store could not be read. Retry later. |

## Glyphs

### `GET /map/fonts/{fontstack}/{range}.pbf`

A range of 256 glyphs as a signed distance field PBF.

| Parameter | Values |
| --- | --- |
| `fontstack` | `Inter Regular`, `Inter Medium`, `Inter SemiBold` or `Inter Bold`, URL-encoded (`Inter%20Regular`). One font only. |
| `range` | `{start}-{end}`, where `start` is a multiple of 256 and `end` is `start + 255`: `0-255`, `256-511`, and so on. |

Latin, Greek and Cyrillic ranges are Inter. Other ranges are answered with Noto Sans glyphs of the nearest weight. Any other fontstack, a combined fontstack, or a range that is not a 256-codepoint block is `404`. See [Glyphs](guides/tiles.md#glyphs).

## Sprite

### `GET /map/sprites/goway.json`, `goway.png`, `goway@2x.json`, `goway@2x.png`

GoWay's icon sprite at standard and double pixel density. A style refers to it as `https://goway.to/map/sprites/goway`, and MapLibre adds the suffixes.

## Elevation

### `GET /map/terrain/{z}/{x}/{y}.webp`

One elevation tile: Terrarium-encoded heights in a 512-pixel WebP.

| Parameter | Values |
| --- | --- |
| `z` | `0` to `12` |
| `x`, `y` | `0` to `2^z - 1` |

| Status | Meaning |
| --- | --- |
| `200` | The tile, `image/webp`. |
| `404` | No elevation data here (open ocean, for example), or `z`, `x` or `y` out of range. MapLibre draws it as flat ground. |
| `502`, `503` | The elevation store could not be read. Retry later. |

See [Elevation tiles](guides/tiles.md#elevation-tiles) for the encoding and a source definition.

### `GET /map/contours/{z}/{x}/{y}.pbf`

One tile of contour lines, traced from the elevation tiles, with a single source layer, `contours`.

| Parameter | Values |
| --- | --- |
| `z` | `9` to `14` |
| `x`, `y` | `0` to `2^z - 1` |

| Status | Meaning |
| --- | --- |
| `200` | The tile, `application/x-protobuf`. Empty where no contour line crosses the tile. |
| `404` | `z`, `x` or `y` out of range. |
| `502` | The contour tile could not be made. Retry later. |

See [Contour lines](guides/tiles.md#contour-lines) for the fields and intervals.

## Not public

`/map/satellite/*`, `/map/city/*` and `/map/city-roads/*` are also served from this origin. They back styles and features that are not offered to integrators yet, and their formats may change without notice. Do not build on them.
