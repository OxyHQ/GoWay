#!/usr/bin/env bash
# Put the planet build's objects in R2 with `wrangler r2 object`, the way the
# Worker needs them (docs/MAP_CITY_PLANET.md → "Keys"). Used by
# .github/workflows/build-city-tiles.yml and, unchanged, by hand — and by
# .github/workflows/build-satellite-tiles.yml for the imagery
# (docs/MAP_SATELLITE.md), with OBJECT_PREFIXES=satellite and
# MANIFEST_KEY=satellite/manifest.json: the same three rules hold for both.
#
#   city-r2.sh put-tree <dir>              every <prefix>/<…> file under <dir>
#   city-r2.sh get-manifest <out-file>     the live manifest; exit 3 when there is none
#   city-r2.sh publish-manifest <file> <stamp>
#
# Needs CLOUDFLARE_API_TOKEN (with R2 write on the bucket) and
# CLOUDFLARE_ACCOUNT_ID. Bucket: R2_BUCKET (default goway-map-tiles).
#
# Three rules, each from a way this goes wrong without a sound:
#
#  * A key is never overwritten. A PMTiles archive is read by byte offset, so
#    replacing one a Worker is reading serves another tile's bytes. A key that
#    already holds EXACTLY this file (a re-run of a job that died after
#    uploading) is skipped; one that holds anything else stops the run.
#  * Every upload is read back and hashed. `put` succeeding says the request
#    was accepted, not that the bytes in the bucket are the bytes built.
#  * "No manifest yet" and "could not read the manifest" are different
#    answers. Treating a failed read as "none" would publish a manifest of
#    this run's regions only and silently drop every region published before.
set -euo pipefail

BUCKET="${R2_BUCKET:-goway-map-tiles}"
MANIFEST_KEY="${MANIFEST_KEY:-city/manifest.json}"
# The top-level key prefixes `put-tree` uploads (space-separated).
OBJECT_PREFIXES="${OBJECT_PREFIXES:-city city-roads}"
# Every manifest ever published, beside the live one: city/manifests/<stamp>.json.
MANIFESTS_DIR="${MANIFEST_KEY%/*}/manifests"
# `wrangler r2 object put` refuses larger objects (MAX_UPLOAD_SIZE_BYTES in
# wrangler 4: 300 MiB). The catalogue's largest part is 1 GB of extract,
# measured at ≤ 0.22 bytes of archive per byte of extract (~220 MB).
MAX_BYTES=$((300 * 1024 * 1024))

wrangler() { bunx wrangler@4 "$@"; }

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"

remote_sha() {
  ( wrangler r2 object get "$BUCKET/$1" --remote --pipe 2>/dev/null || true ) | sha256sum | cut -d' ' -f1
}

remote_exists() {
  local out
  if out=$(wrangler r2 object get "$BUCKET/$1" --remote --file /dev/null 2>&1); then return 0; fi
  if grep -q "does not exist" <<<"$out"; then return 1; fi
  echo "::error::cannot tell whether $1 exists: $(tail -3 <<<"$out")" >&2
  exit 1
}

put_one() {
  local key=$1 file=$2 type size local_sha
  case "$key" in
    *.json) type=application/json ;;
    *.pmtiles) type=application/vnd.pmtiles ;;
    *) echo "::error::$key is neither an archive nor a receipt" >&2; exit 1 ;;
  esac
  size=$(stat -c %s "$file")
  if (( size > MAX_BYTES )); then
    echo "::error::$key is $size bytes, over wrangler's $MAX_BYTES; build its region in more parts (MIN_PARTS)." >&2
    exit 1
  fi
  local_sha=$(sha256sum < "$file" | cut -d' ' -f1)
  if remote_exists "$key"; then
    if [ "$(remote_sha "$key")" = "$local_sha" ]; then
      echo "same    $key (already uploaded)"
      return 0
    fi
    echo "::error::$key already exists in $BUCKET with other bytes; refusing to overwrite it." >&2
    exit 1
  fi
  # The Cloudflare API answers a large put with a 524 now and then (measured
  # in the planet run), and a read-back can come back short. The key is new
  # and no manifest names it yet, so trying again is safe; four tries, then
  # the job fails and the region keeps its previous entry.
  local attempt
  for attempt in 1 2 3 4; do
    wrangler r2 object put "$BUCKET/$key" --remote --file "$file" --content-type "$type" \
      >/dev/null 2>&1 || true
    if [ "$(remote_sha "$key")" = "$local_sha" ]; then
      echo "put     $key $size ${local_sha:0:12} (try $attempt)"
      return 0
    fi
    echo "$key: try $attempt did not land; retrying" >&2
    sleep $((attempt * 30))
  done
  echo "::error::$key: the bytes read back from R2 are not the bytes uploaded, after 4 tries." >&2
  exit 1
}

case "${1:-}" in
  put-tree)
    dir=${2:?put-tree <dir>}
    # Receipts after their archives: a receipt in the bucket then always
    # describes an archive that is there.
    keys=$(cd "$dir" && for prefix in $OBJECT_PREFIXES; do
      [ -d "./$prefix" ] && find "./$prefix" -type f \( -name '*.pmtiles' -o -name '*.receipt.json' \)
    done | sed 's|^\./||')
    if [ -z "$keys" ]; then
      echo "::error::$dir holds no objects under: $OBJECT_PREFIXES" >&2
      exit 1
    fi
    while read -r key; do put_one "$key" "$dir/$key"; done < <(
      grep '\.pmtiles$' <<<"$keys" | sort || true
      grep '\.receipt\.json$' <<<"$keys" | sort || true
    )
    ;;
  get-manifest)
    out=${2:?get-manifest <out-file>}
    if res=$(wrangler r2 object get "$BUCKET/$MANIFEST_KEY" --remote --file "$out" 2>&1); then
      echo "previous manifest: $(stat -c %s "$out") bytes"
    elif grep -q "does not exist" <<<"$res"; then
      rm -f "$out"
      echo "no manifest in $BUCKET yet"
      exit 3
    else
      echo "::error::could not read $MANIFEST_KEY: $(tail -3 <<<"$res")" >&2
      exit 1
    fi
    ;;
  publish-manifest)
    file=${2:?publish-manifest <file> <stamp>}
    stamp=${3:?publish-manifest <file> <stamp>}
    sha=$(sha256sum < "$file" | cut -d' ' -f1)
    # The dated copy first: it is the rollback, and it must exist before the
    # live key moves.
    put_one "$MANIFESTS_DIR/$stamp.json" "$file"
    landed=no
    for attempt in 1 2 3 4; do
      wrangler r2 object put "$BUCKET/$MANIFEST_KEY" --remote --file "$file" \
        --content-type application/json --cache-control no-cache >/dev/null 2>&1 || true
      if [ "$(remote_sha "$MANIFEST_KEY")" = "$sha" ]; then landed=yes; break; fi
      sleep $((attempt * 30))
    done
    if [ "$landed" != yes ]; then
      echo "::error::$MANIFEST_KEY: the bytes read back are not the manifest built." >&2
      exit 1
    fi
    echo "published $MANIFEST_KEY = $MANIFESTS_DIR/$stamp.json (${sha:0:12})"
    ;;
  *)
    echo "usage: city-r2.sh put-tree <dir> | get-manifest <out> | publish-manifest <file> <stamp>" >&2
    exit 2
    ;;
esac
