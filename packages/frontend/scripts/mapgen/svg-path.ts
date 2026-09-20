/**
 * An SVG `d` attribute, parsed into the same command shape fontkit emits.
 *
 * Both halves of this toolkit end up in `flattenPath`, so the cheapest way to
 * give icons and glyphs one distance-field implementation is to make an SVG
 * path look like a font path. That is all this file does.
 *
 * ## Scope, and why the gaps throw instead of guessing
 *
 * Measured across all 461 icons Bloom vendors in
 * `@oxy.so/bloom/src/icons/remix/`, the commands actually used are exactly:
 *
 *     M (461 files)   L (309)   H (349)   V (349)   C (389)   Z (461)
 *
 * and nothing else — no relative forms, no arcs, no quadratics, no smooth
 * curves. Relative forms and `S`/`Q`/`T` are implemented anyway because they
 * are four lines each and a future icon could use them.
 *
 * `A` (elliptical arc) is NOT implemented, and asks for the icon to be
 * reauthored rather than being approximated. Two reasons. First, nothing needs
 * it: zero of 461 icons contain one. Second, converting an arc to cubics
 * requires `sin`, `cos` and `atan2`, and those are the only functions in this
 * whole pipeline whose results IEEE 754 does not pin down exactly — a
 * different engine build could legitimately return a different last bit, and
 * the sprite is a COMMITTED artefact whose `--check` gate compares bytes.
 * Keeping transcendentals out of the generator is what makes "deterministic"
 * a property rather than a hope.
 *
 * **What breaks silently if this is wrong:** a mis-parsed path does not throw,
 * it draws. A dropped `Z` leaves a contour open and `flattenPath` closes it
 * with a straight line across the shape; an `H` read as absolute when it was
 * relative puts a limb in the wrong place. Both produce a plausible-looking
 * icon that is not the icon. Hence: a strict tokeniser, an explicit argument
 * count per command, and a throw on anything unexpected.
 */
import type { PathCommand } from './sdf';

/** How many numbers each command consumes per repetition. */
const ARITY: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  Z: 0,
};

/**
 * Split a `d` string into numbers and command letters.
 *
 * Handles the two things that make SVG numbers annoying: a sign or a decimal
 * point can start the next number with no separator (`10-4`, `.5.5`), and
 * exponents exist (`1e-3`).
 */
function tokenise(d: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  let i = 0;
  while (i < d.length) {
    const ch = d[i];
    if (ch === ' ' || ch === ',' || ch === '\n' || ch === '\r' || ch === '\t') {
      i += 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    const match = /^[+-]?(\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/.exec(d.slice(i));
    if (!match) throw new Error(`unparsable character "${ch}" at offset ${i} of path data`);
    tokens.push(Number.parseFloat(match[0]));
    i += match[0].length;
  }
  return tokens;
}

/**
 * Parse `d` into absolute `moveTo` / `lineTo` / `quadraticCurveTo` /
 * `bezierCurveTo` / `closePath` commands.
 */
export function parseSvgPath(d: string): PathCommand[] {
  const tokens = tokenise(d);
  const out: PathCommand[] = [];

  let x = 0;
  let y = 0;
  // Sub-path start, for Z and for the point an M after a Z resumes from.
  let startX = 0;
  let startY = 0;
  // Reflected control point for S / T. Null when the previous command was not
  // a curve of the matching kind — the spec says the control point then
  // coincides with the current point.
  let lastCubicControl: [number, number] | null = null;
  let lastQuadControl: [number, number] | null = null;

  let at = 0;
  let command = '';
  let relative = false;

  while (at < tokens.length) {
    const token = tokens[at];
    if (typeof token === 'string') {
      const upper = token.toUpperCase();
      if (!(upper in ARITY)) {
        if (upper === 'A') {
          throw new Error(
            'path uses an elliptical arc (A); mapgen does not implement arcs — reauthor the icon with cubics',
          );
        }
        throw new Error(`unknown SVG path command "${token}"`);
      }
      command = upper;
      relative = token !== upper;
      at += 1;
    } else if (command === '') {
      throw new Error('path data starts with a number rather than a command');
    } else if (command === 'M') {
      // A repeated M argument pair is an implicit L, per the spec.
      command = 'L';
    }

    const arity = ARITY[command];
    const args: number[] = [];
    for (let k = 0; k < arity; k += 1) {
      const value = tokens[at + k];
      if (typeof value !== 'number') throw new Error(`command ${command} wants ${arity} numbers`);
      args.push(value);
    }
    at += arity;

    switch (command) {
      case 'M': {
        x = relative ? x + args[0] : args[0];
        y = relative ? y + args[1] : args[1];
        startX = x;
        startY = y;
        out.push({ command: 'moveTo', args: [x, y] });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'L': {
        x = relative ? x + args[0] : args[0];
        y = relative ? y + args[1] : args[1];
        out.push({ command: 'lineTo', args: [x, y] });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'H': {
        x = relative ? x + args[0] : args[0];
        out.push({ command: 'lineTo', args: [x, y] });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'V': {
        y = relative ? y + args[0] : args[0];
        out.push({ command: 'lineTo', args: [x, y] });
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      case 'C': {
        const c1x = relative ? x + args[0] : args[0];
        const c1y = relative ? y + args[1] : args[1];
        const c2x = relative ? x + args[2] : args[2];
        const c2y = relative ? y + args[3] : args[3];
        x = relative ? x + args[4] : args[4];
        y = relative ? y + args[5] : args[5];
        out.push({ command: 'bezierCurveTo', args: [c1x, c1y, c2x, c2y, x, y] });
        lastCubicControl = [c2x, c2y];
        lastQuadControl = null;
        break;
      }
      case 'S': {
        const c1x: number = lastCubicControl ? 2 * x - lastCubicControl[0] : x;
        const c1y: number = lastCubicControl ? 2 * y - lastCubicControl[1] : y;
        const c2x = relative ? x + args[0] : args[0];
        const c2y = relative ? y + args[1] : args[1];
        x = relative ? x + args[2] : args[2];
        y = relative ? y + args[3] : args[3];
        out.push({ command: 'bezierCurveTo', args: [c1x, c1y, c2x, c2y, x, y] });
        lastCubicControl = [c2x, c2y];
        lastQuadControl = null;
        break;
      }
      case 'Q': {
        const cx = relative ? x + args[0] : args[0];
        const cy = relative ? y + args[1] : args[1];
        x = relative ? x + args[2] : args[2];
        y = relative ? y + args[3] : args[3];
        out.push({ command: 'quadraticCurveTo', args: [cx, cy, x, y] });
        lastQuadControl = [cx, cy];
        lastCubicControl = null;
        break;
      }
      case 'T': {
        // Annotated: without it TypeScript follows `lastQuadControl` back into
        // this same assignment and reports a circular inference.
        const cx: number = lastQuadControl ? 2 * x - lastQuadControl[0] : x;
        const cy: number = lastQuadControl ? 2 * y - lastQuadControl[1] : y;
        x = relative ? x + args[0] : args[0];
        y = relative ? y + args[1] : args[1];
        out.push({ command: 'quadraticCurveTo', args: [cx, cy, x, y] });
        lastQuadControl = [cx, cy];
        lastCubicControl = null;
        break;
      }
      case 'Z': {
        out.push({ command: 'closePath', args: [] });
        x = startX;
        y = startY;
        lastCubicControl = null;
        lastQuadControl = null;
        break;
      }
      default:
        throw new Error(`unreachable command ${command}`);
    }
  }

  return out;
}
