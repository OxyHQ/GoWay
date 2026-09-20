# Ground-truth fixture

`noto-sans-regular-0-255.pbf` is **not** GoWay's. It is a glyph range produced
by Mapbox's own `sdf-glyph-foundry` and served by OpenFreeMap, fetched with:

```bash
curl -s 'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf' \
  -o packages/frontend/scripts/mapgen/fixtures/noto-sans-regular-0-255.pbf
```

76 580 bytes, 223 glyphs, one fontstack. Font: Noto Sans, SIL Open Font
License 1.1.

It is committed, and it is never served to a browser. It exists so that
`build-map-glyphs.ts` can check two things offline, on every run:

1. **That our `glyphs.proto` reader is right.** A decoder that parses a file
   written by the reference implementation has its field numbers and wire types
   proven by something other than our own encoder. Without it, encoder and
   decoder could agree perfectly on a format MapLibre does not read.

2. **That our SDF encoding still matches upstream's.** `U+006C` (`l`) is a
   plain vertical stem, so the middle row of its bitmap crosses exactly one
   straight edge, and the step per pixel is `255 / radius`. Measured:

   ```
   110 142 174 206 212 180 148 116
       +32 +32 +32      -32 -32 -32
   ```

   32 per pixel, i.e. `255 / 8`. That number is the reason `mapgen/sdf.ts`
   encodes `alpha = 255 - 255 * (d / 8 + 0.25)` and not one of the several
   similar-looking formulas that would put the outline at byte 191 but scale
   the field differently — those render text that is subtly too thin, with
   halos at the wrong width, and nothing anywhere reports an error.

The same file is where the `top = bitmapTop - ascender` convention was read
off: every `top` in it is negative, and all 223 of them are consistent with an
ascender of 26px, which is FreeType's `size->metrics.ascender` for Noto Sans at
24ppem. See the header of `build-map-glyphs.ts`.

Refetch it only if upstream's toolchain changes and the check starts failing
for a reason that has been understood first.

## `fallback/` — what the Worker's fallback would have drawn

Also not GoWay's, also fetched from OpenFreeMap, and — unlike the file above —
**served to browsers**. `NOTICE` records the licence and the measurement behind
it.

```bash
bun run --cwd packages/frontend map:glyphs:fallback   # writes everything here
bun run --cwd packages/frontend map:glyphs            # offline, consumes it
```

Two artefacts, both committed so the build and its `--check` gate stay offline:

- **`fallback/coverage.json`** — for each upstream fontstack, the code points it
  serves in each range (hex runs) and the pixel ascender its `top` values are
  measured from. This is what makes "is this range complete?" a measurement.
  The Worker's fallback is per RANGE and keys on whether the asset exists, so a
  range file that exists and is short is not a partial answer — it is the whole
  answer, and the fallback can never fire for it. `build-map-glyphs.ts` uses
  this manifest to decide which ranges it is allowed to publish at all.

  A code point upstream does not draw either is not a hole, which is why this is
  measured against upstream rather than against Unicode: dropping `7680-7935`
  over U+1E9C would set every Vietnamese label in Noto to fix a letter nobody
  can draw. Controls and `Default_Ignorable_Code_Point`s are excluded for the
  same reason in reverse — Noto's cmap maps the C0 controls, and counting those
  as holes would have condemned the Latin-1 range.

- **`fallback/<stack>/<range>.pbf`** — only the glyphs Inter lacks, and only for
  the ranges `COMPLETED_RANGES` names. ~78 kB in total, against ~1.7 MB for a
  mirror of the same ranges. `build-map-glyphs.ts` merges these into GoWay's
  own ranges and re-bases each `top` from Noto's 26px ascender onto Inter's
  24px one, so a merged range has ONE baseline rather than two 2px apart.

Refetch when the build asks for it: it says so by name when a range is not in
the manifest (Inter's coverage moved) or when the pack cannot complete a range
(`COMPLETED_RANGES` grew). The third reason — upstream changing what it serves
— nothing here can detect, and it can only matter if upstream ADDS code points
to a range Inter partly covers.
