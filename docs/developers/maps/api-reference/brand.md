# `@goway.to/maps/brand` API reference

The GoWay mark as geometry: SVG path data, inks and view boxes, for drawing the logo where the `GowayLogo` component does not fit (a native canvas, a generated image, a non-React page). The `GowayLogo` component itself is exported from [`@goway.to/maps`](index.md#gowaylogo).

| Export | What it is |
| --- | --- |
| `GOWAY_WORDMARK` | `{ viewBox, paths }`: the full lockup ("GO" over "WAY") |
| `GOWAY_MARK` | `{ viewBox, paths }`: the "G" bubble alone, for small sizes |
| `GOWAY_PATHS` | every path of the wordmark, in draw order |
| `GOWAY_INK` | the colours: `outline` `#004aad`, `go` `#acd0ff`, `way` `#ffffff` |
| `aspectRatio(artwork)` | width over height of an artwork's `viewBox` |

| Type | Shape |
| --- | --- |
| `GowayArtwork` | `{ viewBox: string; paths: readonly GowayPath[] }` |
| `GowayPath` | `{ part: GowayPart; layer: 'outline' \| 'fill'; ink: GowayInk; d: string }` |
| `GowayPart` | `'g' \| 'o' \| 'w' \| 'a' \| 'y'` |
| `GowayInk` | `'outline' \| 'go' \| 'way'` |

Draw the paths in order (each `outline` before its `fill`), each filled with `GOWAY_INK[path.ink]`, inside the artwork's `viewBox`:

```tsx
import { GOWAY_INK, GOWAY_MARK } from '@goway.to/maps/brand';

<svg viewBox={GOWAY_MARK.viewBox} width={48} role="img" aria-label="GoWay">
  {GOWAY_MARK.paths.map((path, index) => (
    <path key={index} d={path.d} fill={GOWAY_INK[path.ink]} />
  ))}
</svg>;
```
