#!/usr/bin/env bash
#
# Build GoWay's Valhalla routing tiles from an OpenStreetMap extract.
#
# Everything happens inside the upstream Valhalla image, so the only thing this
# script needs on the host is docker and disk. It is the same command CI runs
# (.github/workflows/build-routing-tiles.yml), which is the point: a tile set
# built on a laptop and one built in CI have to be the same tile set, or the
# thing you tested is not the thing that routes.
#
#   REGION=europe/spain ./build-tiles.sh
#
# REGION is a path under https://download.geofabrik.de/, without the
# `-latest.osm.pbf` suffix. `europe/spain/cataluna` builds in well under a
# minute and is the right choice while iterating on the Dockerfile.
set -euo pipefail

REGION="${REGION:-europe/spain}"
OUT="${OUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build}"
VALHALLA_IMAGE="${VALHALLA_IMAGE:-ghcr.io/valhalla/valhalla:latest}"
DOCKER="${DOCKER:-docker}"

extract="$(basename "$REGION")-latest.osm.pbf"
url="https://download.geofabrik.de/${REGION}-latest.osm.pbf"

mkdir -p "$OUT"

# RESUMED, not restarted. These extracts are gigabytes and Geofabrik will drop
# a connection; without `-C -` a drop at 90 % costs the whole download, which is
# exactly how a 5-minute build becomes a 40-minute one.
echo "==> extract: $url"
expected="$(curl -sIL "$url" | awk 'BEGIN{IGNORECASE=1} /^content-length:/ {v=$2} END {gsub(/\r/,"",v); print v}')"
for attempt in 1 2 3 4 5; do
  curl -fsSL -C - --retry 5 --retry-delay 5 -o "$OUT/$extract" "$url" || true
  actual="$(stat -c %s "$OUT/$extract" 2>/dev/null || echo 0)"
  echo "    attempt $attempt: $actual / ${expected:-?} bytes"
  [[ -n "$expected" && "$actual" -ge "$expected" ]] && break
  if [[ "$attempt" == 5 ]]; then
    echo "!! could not fetch the whole extract; refusing to build tiles from a truncated file" >&2
    # A TRUNCATED PBF DOES NOT FAIL THE BUILD, it builds a smaller map — roads
    # simply stop existing partway through the country, and every route that
    # crosses the gap comes back "no route found". That is indistinguishable
    # from honest coverage, so it has to fail here instead.
    exit 1
  fi
  sleep 3
done

echo "==> building tiles from $extract"
"$DOCKER" run --rm -v "$OUT:/data" "$VALHALLA_IMAGE" bash -euo pipefail -c "
  cd /data
  valhalla_build_config \
    --mjolnir-tile-dir /data/tiles \
    --mjolnir-tile-extract /data/tiles.tar \
    --mjolnir-timezone /data/timezones.sqlite \
    --mjolnir-admin /data/admins.sqlite \
    > /data/valhalla.json
  # Timezones and admins FIRST: admin areas decide which side of the road a
  # country drives on and what its default speeds are, and tiles built without
  # them route Spain like Britain.
  valhalla_build_timezones > /data/timezones.sqlite
  valhalla_build_admins -c /data/valhalla.json /data/$extract
  valhalla_build_tiles -c /data/valhalla.json /data/$extract
  # One mmap-able archive instead of ~1800 loose files: a tar is one page cache
  # and one COPY layer, where a directory tree is thousands of tiny image files.
  find /data/tiles | sort -n | valhalla_build_extract -c /data/valhalla.json -v
"

# The loose tiles are now inside tiles.tar and are pure weight in the image.
rm -rf "$OUT/tiles" "$OUT/$extract"

echo
echo "==> built:"
ls -la "$OUT"
