/**
 * Signed distance fields, computed exactly from outline geometry.
 *
 * Both deliverables that this toolkit produces — the glyph PBFs and the icon
 * sprite — are the *same* artefact in two wrappers: an 8-bit alpha image whose
 * value encodes how far each pixel centre is from a vector outline. MapLibre
 * reconstructs a crisp edge at any scale by thresholding that value in the
 * fragment shader. Everything here exists to get that one number right.
 *
 * ## The encoding, measured rather than assumed
 *
 * MapLibre's `symbol_sdf.fragment.glsl` reads:
 *
 * ```glsl
 * #define SDF_PX 8.0
 * float dist = texture2D(u_texture, tex).a;              // 0..1
 * float alpha = smoothstep(buff - gamma_scaled, buff + gamma_scaled, dist);
 * ```
 *
 * with `buff = (6.0 - halo_width / fontScale) / SDF_PX`. Two facts fall out of
 * that expression and they fix the encoding completely:
 *
 *  - With no halo, the fill edge is at `dist = 6/8 = 0.75`, i.e. byte value
 *    `191.25`. So the outline itself must land on ~191, which means a cutoff
 *    of `0.25` of full scale.
 *  - A halo of `w` pixels moves the threshold by `w / 8` of full scale. So one
 *    unit of `dist` spans exactly `SDF_PX = 8` pixels — the radius.
 *
 * Therefore `alpha = 255 - 255 * (d / 8 + 0.25)`, with `d` in pixels and
 * negative inside. This was then checked against a real file from Mapbox's own
 * `sdf-glyph-foundry` (`tiles.openfreemap.org/fonts/Noto Sans Regular/0-255.pbf`):
 * the middle row of `l`, a 2px stem, reads
 *
 * ```
 * 110 142 174 206 212 180 148 116
 *     +32 +32 +32      -32 -32 -32
 * ```
 *
 * A step of 32 per pixel across a straight vertical edge is `255 / 8 = 31.875`.
 * Had the scale been `255 * (1 - cutoff) / 8 = 23.9` — a plausible-looking
 * alternative — the step would have been 24. It is 32. The gradient is the
 * measurement that decides it, and it agrees with the shader.
 *
 * **What breaks silently if this is wrong:** nothing throws. A field scaled by
 * `(1 - cutoff)` renders text that is uniformly too thin, with halos at ~3/4
 * of the requested width, and `text-halo-blur` that never quite closes. A
 * field with the wrong sign convention renders the *negative* of every letter,
 * which at small sizes reads as "the font looks a bit heavy".
 *
 * ## Why exact distance, not rasterise-then-EDT
 *
 * The conventional pipeline (TinySDF, `sdf-glyph-foundry`) rasterises the
 * glyph to a bitmap and then runs a Euclidean distance transform over the
 * pixels. That quantises the outline to the pixel grid *before* measuring
 * distance, so at 24px the diagonal of an `A` becomes a staircase and the
 * field inherits ~0.5px of stair-step error. It is invisible at the size the
 * field was authored for and very visible when MapLibre scales the glyph up.
 *
 * Measuring the distance from the flattened outline segments directly skips
 * the quantisation entirely: every pixel centre gets its true distance to the
 * true curve, to within the flattening tolerance (0.01px, three times finer
 * than the 1/32px that one alpha step is worth). It is also *simpler* — no
 * two-pass EDT, no inner/outer bookkeeping — and fast enough, because a 24px
 * glyph is at most a few hundred segments over a few hundred pixels.
 *
 * ## Geometry conventions
 *
 * Everything in this module is **y-up**, origin at the text baseline / icon
 * box bottom-left, in the same pixel units as the output bitmap. Callers
 * convert (`flattenGlyphPath` scales font units; `flattenSvgPath` flips SVG's
 * y-down). Row 0 of the output is the TOP row, because that is what both the
 * glyph PBF and PNG scanlines want.
 */

/** A closed polygon: flattened outline points as `[x0, y0, x1, y1, ...]`. */
export type Contour = Float64Array;

/** How a set of contours decides what is inside. */
export type FillRule = 'nonzero' | 'evenodd';

/** The 8-bit field plus the ink box it was measured over. */
export interface SdfImage {
  /** Ink width in pixels, WITHOUT the buffer. */
  width: number;
  /** Ink height in pixels, WITHOUT the buffer. */
  height: number;
  /** x of the ink box's left edge, relative to the origin. `floor(minX)`. */
  left: number;
  /** y of the ink box's top edge, relative to the origin. `ceil(maxY)`. */
  top: number;
  /** `(width + 2*buffer) * (height + 2*buffer)` alpha bytes, row-major, top row first. */
  data: Uint8Array;
  /** The buffer this was rendered with, so callers need not carry it separately. */
  buffer: number;
}

export interface SdfOptions {
  /** Pixels of margin on every side. 3 for glyphs (MapLibre's GLYPH_PBF_BORDER). */
  buffer: number;
  /** Pixels one full unit of the field spans. 8 — the shader's `SDF_PX`. */
  radius: number;
  /** Fraction of the range that sits inside the outline. 0.25 — the shader's `buff`. */
  cutoff: number;
  fillRule: FillRule;
  /**
   * Force the ink box instead of measuring it from the outline.
   *
   * Glyphs want the measured box: a tight box is what `left`/`top`/`advance`
   * are defined against, and a comma has no business being as tall as a `W`.
   *
   * Icons want the opposite. A sprite whose cells are each cropped to their
   * own ink has a different footprint for every category, so swapping
   * `icon-image` between a wide icon and a tall one moves the mark on the map
   * and changes how much it overlaps its neighbours in collision detection.
   * Forcing every icon into the same 24x24 box makes the set interchangeable,
   * which is the entire reason it is a set.
   */
  bounds?: { left: number; top: number; width: number; height: number };
}

/** Glyphs and icons alike. Changing any of these three is a rendering change. */
export const SDF_DEFAULTS = { radius: 8, cutoff: 0.25 } as const;

/**
 * An outline bigger than this is refused rather than rendered.
 *
 * A variable-font instancing bug or a malformed SVG can produce coordinates in
 * the millions, and `(width + 6) * (height + 6)` bytes of that is an
 * out-of-memory kill in a build script with no useful stack. 512px is already
 * twenty times the 24px em these fields are authored at.
 */
const MAX_INK_EXTENT = 512;

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/**
 * Max deviation, in output pixels, allowed between a curve and its polyline.
 *
 * One step of the 8-bit field is `8 / 255 = 0.031px`, so 0.01px of flattening
 * error cannot move a single alpha value by more than one unit. Tightening it
 * further buys nothing and costs segments quadratically.
 */
export const FLATTEN_TOLERANCE = 0.01;

/** Subdivision counts are capped so a degenerate control point cannot hang the build. */
const MAX_SUBDIVISIONS = 64;

/** One path command, in the shape fontkit's `glyph.path.commands` uses. */
export interface PathCommand {
  command: string;
  args: number[];
}

/** Maps a source coordinate into the y-up pixel space the SDF is measured in. */
export type PointTransform = (x: number, y: number) => [number, number];

class ContourBuilder {
  private readonly contours: Contour[] = [];
  private current: number[] = [];

  moveTo(x: number, y: number): void {
    this.flushContour();
    this.current.push(x, y);
  }

  lineTo(x: number, y: number): void {
    const n = this.current.length;
    // Drop exact repeats: a zero-length segment has no direction, contributes
    // nothing to the distance field, and would be counted twice by the
    // scanline crossing test at its own y.
    if (n >= 2 && this.current[n - 2] === x && this.current[n - 1] === y) return;
    this.current.push(x, y);
  }

  lastPoint(): [number, number] {
    const n = this.current.length;
    if (n < 2) return [0, 0];
    return [this.current[n - 2], this.current[n - 1]];
  }

  flushContour(): void {
    // Fewer than three points cannot enclose area; such a "contour" is either
    // a stray moveTo or a hairline, and both are invisible in a filled shape.
    if (this.current.length >= 6) this.contours.push(Float64Array.from(this.current));
    this.current = [];
  }

  finish(): Contour[] {
    this.flushContour();
    return this.contours;
  }
}

function quadraticSteps(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): number {
  // Max deviation of an n-segment chord approximation is |P0 - 2P1 + P2| / (8 n^2).
  const dx = x0 - 2 * cx + x1;
  const dy = y0 - 2 * cy + y1;
  const deviation = Math.sqrt(dx * dx + dy * dy);
  const n = Math.ceil(Math.sqrt(deviation / (8 * FLATTEN_TOLERANCE)));
  return Math.min(MAX_SUBDIVISIONS, Math.max(1, n));
}

function cubicSteps(
  x0: number,
  y0: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x1: number,
  y1: number,
): number {
  // Deviation bound is (3 / 4 n^2) * max(|P0 - 2P1 + P2|, |P1 - 2P2 + P3|).
  const d1x = x0 - 2 * ax + bx;
  const d1y = y0 - 2 * ay + by;
  const d2x = ax - 2 * bx + x1;
  const d2y = ay - 2 * by + y1;
  const deviation = Math.sqrt(Math.max(d1x * d1x + d1y * d1y, d2x * d2x + d2y * d2y));
  const n = Math.ceil(Math.sqrt((3 * deviation) / (4 * FLATTEN_TOLERANCE)));
  return Math.min(MAX_SUBDIVISIONS, Math.max(1, n));
}

/**
 * Turn path commands into closed polygons in SDF pixel space.
 *
 * Contours are closed implicitly whether or not the source emitted
 * `closePath`. A filled shape with an open contour is not a thing — the
 * renderer would close it anyway — and leaving the closing edge out would put
 * a gap in the distance field along an edge that visibly exists.
 */
export function flattenPath(commands: readonly PathCommand[], transform: PointTransform): Contour[] {
  const builder = new ContourBuilder();

  for (const { command, args } of commands) {
    switch (command) {
      case 'moveTo': {
        const [x, y] = transform(args[0], args[1]);
        builder.moveTo(x, y);
        break;
      }
      case 'lineTo': {
        const [x, y] = transform(args[0], args[1]);
        builder.lineTo(x, y);
        break;
      }
      case 'quadraticCurveTo': {
        const [cx, cy] = transform(args[0], args[1]);
        const [x, y] = transform(args[2], args[3]);
        const [x0, y0] = builder.lastPoint();
        const steps = quadraticSteps(x0, y0, cx, cy, x, y);
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          const u = 1 - t;
          builder.lineTo(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y);
        }
        break;
      }
      case 'bezierCurveTo': {
        const [ax, ay] = transform(args[0], args[1]);
        const [bx, by] = transform(args[2], args[3]);
        const [x, y] = transform(args[4], args[5]);
        const [x0, y0] = builder.lastPoint();
        const steps = cubicSteps(x0, y0, ax, ay, bx, by, x, y);
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          const u = 1 - t;
          const uu = u * u;
          const tt = t * t;
          builder.lineTo(
            uu * u * x0 + 3 * uu * t * ax + 3 * u * tt * bx + tt * t * x,
            uu * u * y0 + 3 * uu * t * ay + 3 * u * tt * by + tt * t * y,
          );
        }
        break;
      }
      case 'closePath':
        builder.flushContour();
        break;
      default:
        throw new Error(`unsupported path command "${command}"`);
    }
  }

  return builder.finish();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Flat segment soup, as typed arrays, so the inner loops stay monomorphic. */
interface Segments {
  readonly x0: Float64Array;
  readonly y0: Float64Array;
  readonly x1: Float64Array;
  readonly y1: Float64Array;
  readonly count: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function toSegments(contours: readonly Contour[]): Segments | null {
  let count = 0;
  for (const contour of contours) count += contour.length / 2;
  if (count === 0) return null;

  const x0 = new Float64Array(count);
  const y0 = new Float64Array(count);
  const x1 = new Float64Array(count);
  const y1 = new Float64Array(count);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let at = 0;

  for (const contour of contours) {
    const n = contour.length / 2;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      const ax = contour[i * 2];
      const ay = contour[i * 2 + 1];
      const bx = contour[j * 2];
      const by = contour[j * 2 + 1];
      x0[at] = ax;
      y0[at] = ay;
      x1[at] = bx;
      y1[at] = by;
      at += 1;
      if (ax < minX) minX = ax;
      if (ax > maxX) maxX = ax;
      if (ay < minY) minY = ay;
      if (ay > maxY) maxY = ay;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }
  return { x0, y0, x1, y1, count: at, minX, minY, maxX, maxY };
}

function pointSegmentDistanceSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/**
 * Inside/outside for every pixel centre, by scanline crossing.
 *
 * One pass per row over every segment, rather than a winding number per pixel,
 * which would be the same work multiplied by the row width. Crossings use the
 * half-open rule `(y0 <= y) !== (y1 <= y)` so a vertex that lands exactly on a
 * scanline is counted once, not zero or twice — the classic source of a single
 * wrongly-filled pixel column in an otherwise perfect glyph.
 */
function computeInside(
  segments: Segments,
  columns: number,
  rows: number,
  originX: number,
  originY: number,
  rule: FillRule,
): Uint8Array {
  const inside = new Uint8Array(columns * rows);
  const crossX = new Float64Array(segments.count);
  const crossDir = new Int8Array(segments.count);
  const order = new Int32Array(segments.count);

  for (let row = 0; row < rows; row += 1) {
    const y = originY - row - 0.5;
    let hits = 0;
    for (let s = 0; s < segments.count; s += 1) {
      const ay = segments.y0[s];
      const by = segments.y1[s];
      if (ay <= y === by <= y) continue;
      const ax = segments.x0[s];
      const bx = segments.x1[s];
      crossX[hits] = ax + ((y - ay) / (by - ay)) * (bx - ax);
      crossDir[hits] = by > ay ? 1 : -1;
      hits += 1;
    }
    if (hits === 0) continue;

    for (let i = 0; i < hits; i += 1) order[i] = i;
    const sorted = order.subarray(0, hits);
    sorted.sort((a, b) => crossX[a] - crossX[b]);

    const rowBase = row * columns;
    let cursor = 0;
    let winding = 0;
    let parity = 0;
    for (let column = 0; column < columns; column += 1) {
      const x = originX + column + 0.5;
      while (cursor < hits && crossX[sorted[cursor]] <= x) {
        winding += crossDir[sorted[cursor]];
        parity ^= 1;
        cursor += 1;
      }
      const isIn = rule === 'evenodd' ? parity === 1 : winding !== 0;
      if (isIn) inside[rowBase + column] = 1;
    }
  }

  return inside;
}

/**
 * Render contours to a signed distance field.
 *
 * Returns `null` when the outline encloses nothing — a space, an empty SVG, a
 * hairline. Callers turn that into the format's blank representation rather
 * than a 6x6 bitmap of zeroes.
 */
export function renderSdf(contours: readonly Contour[], options: SdfOptions): SdfImage | null {
  const segments = toSegments(contours);
  if (segments === null) return null;

  const { buffer, radius, cutoff, fillRule } = options;

  const left = options.bounds ? options.bounds.left : Math.floor(segments.minX);
  const top = options.bounds ? options.bounds.top : Math.ceil(segments.maxY);
  const width = options.bounds ? options.bounds.width : Math.ceil(segments.maxX) - left;
  const height = options.bounds ? options.bounds.height : top - Math.floor(segments.minY);
  if (width <= 0 || height <= 0) return null;
  if (width > MAX_INK_EXTENT || height > MAX_INK_EXTENT) {
    throw new Error(`outline ink box is ${width}x${height}px, beyond the ${MAX_INK_EXTENT}px sanity limit`);
  }

  const columns = width + 2 * buffer;
  const rows = height + 2 * buffer;
  // Pixel centre of column c is originX + c + 0.5; of row r, originY - r - 0.5.
  const originX = left - buffer;
  const originY = top + buffer;

  const inside = computeInside(segments, columns, rows, originX, originY, fillRule);

  // Beyond `radius` px the field is saturated at 0 or 255, so distances are
  // only ever computed for pixels a segment could plausibly reach. That turns
  // an O(pixels * segments) loop into a scatter bounded by each segment's own
  // neighbourhood, which is what keeps ~11k glyph renders to a few seconds.
  const distanceSquared = new Float64Array(columns * rows).fill(Infinity);
  const reach = radius;

  for (let s = 0; s < segments.count; s += 1) {
    const ax = segments.x0[s];
    const ay = segments.y0[s];
    const bx = segments.x1[s];
    const by = segments.y1[s];

    const loX = Math.min(ax, bx) - reach;
    const hiX = Math.max(ax, bx) + reach;
    const loY = Math.min(ay, by) - reach;
    const hiY = Math.max(ay, by) + reach;

    let columnStart = Math.floor(loX - originX - 0.5);
    let columnEnd = Math.ceil(hiX - originX - 0.5);
    let rowStart = Math.floor(originY - hiY - 0.5);
    let rowEnd = Math.ceil(originY - loY - 0.5);
    if (columnStart < 0) columnStart = 0;
    if (rowStart < 0) rowStart = 0;
    if (columnEnd > columns - 1) columnEnd = columns - 1;
    if (rowEnd > rows - 1) rowEnd = rows - 1;

    for (let row = rowStart; row <= rowEnd; row += 1) {
      const py = originY - row - 0.5;
      const rowBase = row * columns;
      for (let column = columnStart; column <= columnEnd; column += 1) {
        const px = originX + column + 0.5;
        const d2 = pointSegmentDistanceSquared(px, py, ax, ay, bx, by);
        if (d2 < distanceSquared[rowBase + column]) distanceSquared[rowBase + column] = d2;
      }
    }
  }

  const data = new Uint8Array(columns * rows);
  for (let i = 0; i < data.length; i += 1) {
    const isIn = inside[i] === 1;
    const d2 = distanceSquared[i];
    if (d2 === Infinity) {
      data[i] = isIn ? 255 : 0;
      continue;
    }
    const distance = isIn ? -Math.sqrt(d2) : Math.sqrt(d2);
    const value = Math.round(255 - 255 * (distance / radius + cutoff));
    data[i] = value < 0 ? 0 : value > 255 ? 255 : value;
  }

  return { width, height, left, top, data, buffer };
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

const ASCII_RAMP = ' .:-=+*#%@';

/**
 * An SDF as ASCII, for eyeballing in a terminal or a code review.
 *
 * The `-` in the ramp sits at roughly the 191 that the shader thresholds on,
 * so the letter's true outline is the boundary between `-` and `=`. That makes
 * it possible to see, without a renderer, whether the mid-grey contour follows
 * the shape or has been shifted by an encoding mistake.
 */
export function sdfToAscii(width: number, height: number, buffer: number, data: Uint8Array): string {
  const columns = width + 2 * buffer;
  const rows = height + 2 * buffer;
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    let line = '';
    for (let column = 0; column < columns; column += 1) {
      const v = data[row * columns + column];
      line += ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor((v / 256) * ASCII_RAMP.length))];
    }
    lines.push(line);
  }
  return lines.join('\n');
}
