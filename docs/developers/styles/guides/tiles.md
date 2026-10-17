# Tiles

GoWay serves its own map data from `https://goway.to/map/`: vector tiles in the OpenMapTiles v3 schema, glyph ranges for labels, a sprite, elevation tiles and contour lines. This page describes what each one contains, so you can write your own style layers, filters and queries against them. Every GoWay style already uses these sources; you only need this page to go beyond the published styles.

## Vector tiles

The vector source is described by a TileJSON document:

```text
https://goway.to/map/tiles.json
```

```json
{
  "tilejson": "3.0.0",
  "name": "GoWay",
  "description": "GoWay vector tiles, OpenMapTiles v3 schema.",
  "scheme": "xyz",
  "tiles": ["https://goway.to/map/tiles/{z}/{x}/{y}.pbf"],
  "minzoom": 0,
  "maxzoom": 14,
  "bounds": [-180, -85.0511, 180, 85.0511],
  "attribution": "<a href=\"https://www.openmaptiles.org/\" target=\"_blank\">&copy; OpenMapTiles</a> <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\">&copy; OpenStreetMap contributors</a>"
}
```

Point a MapLibre vector source at it and keep its attribution visible:

```json
{
  "sources": {
    "openmaptiles": { "type": "vector", "url": "https://goway.to/map/tiles.json" }
  }
}
```

GoWay's styles name this source `openmaptiles`.

Tiles exist from zoom 0 to 14. Above 14, MapLibre over-zooms the z14 tiles, so a map can still be drawn at street level; a request for a tile above z14 is answered `404`. A tile with no data in it (open ocean, for example) is also a `404`, which MapLibre draws as empty. Tiles are Mapbox Vector Tiles (`application/vnd.mapbox-vector-tile`), sent gzip-compressed to clients that accept gzip.

The data is built from OpenStreetMap. Points of interest carry the OpenStreetMap element they came from as their feature id: `id = osmId * 10 + t`, where `t` is `1` for a node, `2` for a way and `3` for a relation.

### Source layers

A style layer or a query names one of these source layers. A misspelled `source-layer` draws nothing and reports no error, so copy names from here or from `OPENMAPTILES_SOURCE_LAYERS` in `@goway.to/sdk/map`.

| Source layer | SDK key | Fields GoWay's own styles read |
| --- | --- | --- |
| `aerodrome_label` | `aerodromeLabel` | `iata`, `name`, `name:latin` |
| `aeroway` | `aeroway` | `class` |
| `boundary` | `boundary` | `admin_level`, `maritime` |
| `building` | `building` | `render_height`, `render_min_height`, `hide_3d` |
| `housenumber` | `housenumber` | `housenumber` |
| `landcover` | `landcover` | `class` ([values](#landcoverclass)) |
| `landuse` | `landuse` | `class` ([values](#landuseclass)) |
| `mountain_peak` | `mountainPeak` | `class`, `ele`, `name`, `name:latin`, `rank` |
| `park` | `park` | `name`, `name:latin`, `rank` |
| `place` | `place` | `class` ([values](#placeclass)), `name`, `name:latin` |
| `poi` | `poi` | `class` ([values](#poiclass)), `name`, `name:latin`, `rank`, `agg_stop` |
| `transportation` | `transportation` | `class` ([values](#transportationclass)), `subclass`, `brunnel`, `oneway`, `ramp`, `mtb_scale` |
| `transportation_name` | `transportationName` | `class`, `name`, `name:latin` |
| `water` | `water` | `class` ([values](#waterclass)), `brunnel` |
| `water_name` | `waterName` | `name`, `name:latin` |
| `waterway` | `waterway` | `brunnel`, `name`, `name:latin` |

The third column lists the fields GoWay's published styles use, not every field the OpenMapTiles v3 schema defines.

Labels: `name` is the name in the local language, as written on the ground; `name:latin` is its Latin-script form where one exists. GoWay's styles label features with `name:latin` and fall back to `name`:

```json
["coalesce", ["get", "name:latin"], ["get", "name"], ""]
```

### Class values

These are the `class` values that occur in GoWay's tiles, as listed in `@goway.to/sdk/map`. Filter on them with `["==", ["get", "class"], "<value>"]` or `["match", ["get", "class"], [...], true, false]`.

#### `transportation.class`

| Values | Notes |
| --- | --- |
| `motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `minor`, `service`, `track`, `path` | Roads and paths. |
| `busway`, `raceway`, `bridge`, `pier` | |
| `rail`, `transit`, `ferry`, `aerialway` | |
| `motorway_construction`, `trunk_construction`, `primary_construction`, `secondary_construction`, `tertiary_construction`, `minor_construction`, `service_construction`, `path_construction` | Roads under construction. Present in the tiles; GoWay's styles do not draw them. |

SDK constant: `TRANSPORTATION_CLASSES`.

#### `landcover.class`

| Values |
| --- |
| `farmland`, `grass`, `ice`, `rock`, `sand`, `wetland`, `wood` |

SDK constant: `LANDCOVER_CLASSES`.

#### `landuse.class`

| Values |
| --- |
| `bus_station`, `cemetery`, `college`, `commercial`, `dam`, `education`, `garages`, `grass`, `hospital`, `industrial`, `kindergarten` |
| `library`, `military`, `music_venue`, `neighbourhood`, `official_residence`, `park`, `pitch`, `playground`, `quarry`, `quarter`, `racetrack` |
| `railway`, `recreation_ground`, `residential`, `retail`, `school`, `stadium`, `suburb`, `theme_park`, `track`, `university`, `zoo` |

SDK constant: `LANDUSE_CLASSES`.

#### `place.class`

| Values |
| --- |
| `country`, `state`, `province`, `city`, `town`, `village`, `hamlet`, `isolated_dwelling` |
| `suburb`, `quarter`, `neighbourhood`, `island`, `aboriginal_lands` |

SDK constant: `PLACE_CLASSES`.

#### `water.class`

| Values |
| --- |
| `ocean`, `lake`, `pond`, `river`, `dock`, `swimming_pool` |

SDK constant: `WATER_CLASSES`.

#### `poi.class`

| Initial | Values |
| --- | --- |
| a | `aerialway`, `alcohol_shop`, `aquarium`, `art_gallery`, `athletics`, `atm`, `attraction` |
| b | `bakery`, `bank`, `bar`, `basin`, `basketball`, `beer`, `bicycle`, `bicycle_parking`, `bicycle_rental`, `bollard`, `boules`, `boxing`, `brownfield`, `bus`, `butcher` |
| c | `cafe`, `campsite`, `car`, `castle`, `cemetery`, `chess`, `cinema`, `climbing`, `clothing_store`, `college`, `cycle_barrier`, `cycling` |
| d | `dentist`, `doctors`, `dog_park`, `drinking_water` |
| e | `entrance`, `equestrian`, `escape_game` |
| f | `fast_food`, `ferry_terminal`, `fire_station`, `fuel` |
| g | `garden`, `gate`, `golf`, `grocery`, `gymnastics` |
| h | `hackerspace`, `hairdresser`, `harbor`, `hospital` |
| i | `ice_cream`, `ice_rink`, `information` |
| k | `karting` |
| l | `laundry`, `library`, `lift_gate`, `lodging` |
| m | `monument`, `motorcycle`, `motorcycle_parking`, `multi`, `museum`, `music` |
| o | `office`, `orienteering` |
| p | `park`, `parking`, `pharmacy`, `picnic_site`, `pitch`, `place_of_worship`, `playground`, `police`, `post`, `prison` |
| r | `railway`, `rc_car`, `recycling`, `reservoir`, `restaurant`, `running` |
| s | `sailing`, `sally_port`, `school`, `scuba_diving`, `shelter`, `shooting`, `shop`, `sports_centre`, `stadium`, `stile`, `swimming`, `swimming_pool` |
| t | `table_tennis`, `telephone`, `theatre`, `theme_park`, `toilets`, `toll_booth`, `town_hall` |
| v | `veterinary` |
| w | `waste_basket` |
| y | `yoga` |
| z | `zoo` |

SDK constant: `POI_CLASSES`. `motorcycle` and `zoo` are defined by the OpenMapTiles v3 schema but have not been observed in GoWay's tiles so far.

## Glyphs

Labels use glyph ranges (signed distance field PBFs) served at:

```text
https://goway.to/map/fonts/{fontstack}/{range}.pbf
```

`{range}` is a 256-codepoint block such as `0-255` or `256-511`: the start must be a multiple of 256 and the end exactly 255 more. Any other range is a `404`. The fontstack name contains a space, which MapLibre encodes for you (`Inter%20Regular`).

| Font | SDK `FONT_STACKS` key |
| --- | --- |
| `Inter Regular` | `regular` |
| `Inter Medium` | `medium` |
| `Inter SemiBold` | `semibold` |
| `Inter Bold` | `bold` |

SDK constants: `AVAILABLE_FONTS` (the four names) and `FONT_STACKS` (each as a one-element array, ready for `text-font`).

```json
{ "layout": { "text-font": ["Inter SemiBold"], "text-field": ["get", "name"] } }
```

Always use a single font per `text-font`. MapLibre requests a combined fontstack when `text-font` names more than one, and GoWay does not serve combined stacks.

Inter covers Latin, Greek and Cyrillic. Ranges outside those scripts (CJK, Arabic, Devanagari, Thai and others) are answered with Noto Sans glyphs through the same URL: `Inter Regular` and `Inter Medium` fall back to Noto Sans Regular, `Inter SemiBold` and `Inter Bold` to Noto Sans Bold. Those labels still render, in a different typeface.

## Sprite

GoWay's icons are one sprite:

```text
https://goway.to/map/sprites/goway
```

MapLibre fetches `goway.json` and `goway.png`, or `goway@2x.json` and `goway@2x.png` on high-density screens. The JSON index lists every icon by name; GoWay's icon names start with `goway-`.

## Elevation tiles

Raster elevation tiles (a DEM) are served at:

```text
https://goway.to/map/terrain/{z}/{x}/{y}.webp
```

| Property | Value |
| --- | --- |
| Format | WebP, `image/webp` |
| Encoding | Terrarium (`height = R * 256 + G + B / 256 - 32768`, in metres) |
| Tile size | 512 pixels |
| Zoom levels | 0 to 12; over-zoom above 12 |
| Missing tile | `404` (open ocean, for example), drawn as flat ground |
| Credit | Mapterhorn |

A request above z12 is answered `404`. Use them as a MapLibre `raster-dem` source, exactly as the `outdoors` style does:

```json
{
  "goway-terrain": {
    "type": "raster-dem",
    "tiles": ["https://goway.to/map/terrain/{z}/{x}/{y}.webp"],
    "encoding": "terrarium",
    "tileSize": 512,
    "minzoom": 0,
    "maxzoom": 12,
    "attribution": "<a href=\"https://mapterhorn.com/attribution\" target=\"_blank\">© Mapterhorn</a>"
  }
}
```

A `hillshade` layer, or `map.setTerrain({ source: 'goway-terrain' })` in MapLibre GL JS, can then use it.

## Contour lines

Contour lines are vector tiles traced from the elevation tiles:

```text
https://goway.to/map/contours/{z}/{x}/{y}.pbf
```

They exist from zoom 9 to 14; outside that range the answer is `404`. Each tile has one source layer, `contours`, with line features carrying:

| Field | Meaning |
| --- | --- |
| `ele` | Elevation of the line, in metres. |
| `level` | `1` on an index contour, `0` on any other line. |

The interval depends on the zoom:

| Zoom | Every line | Index lines |
| --- | --- | --- |
| 9, 10 | 200 m | 1000 m |
| 11 | 100 m | 500 m |
| 12 | 50 m | 250 m |
| 13 | 20 m | 100 m |
| 14 | 10 m | 50 m |

The `outdoors` style declares the source like this:

```json
{
  "goway-contours": {
    "type": "vector",
    "tiles": ["https://goway.to/map/contours/{z}/{x}/{y}.pbf"],
    "minzoom": 9,
    "maxzoom": 14,
    "attribution": "<a href=\"https://mapterhorn.com/attribution\" target=\"_blank\">© Mapterhorn</a>"
  }
}
```

A contour tile where no line crosses a level is empty. Contours are ordinary tiles, so they work in MapLibre Native as well as in the browser.

## Not covered here

The Worker at `goway.to/map/*` also answers `/map/satellite/*` (imagery for the `satellite` and `hybrid` styles, which are not offered yet) and `/map/city/*` and `/map/city-roads/*` (the tiles behind GoWay's own 3D city view, an internal format). They are not part of the public tile interface and may change without notice.

For every endpoint with its caching headers, see [Map endpoints](../api-reference.md). For the styles built on these tiles, see [Map styles](../README.md).
