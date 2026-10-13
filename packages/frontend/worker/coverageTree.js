/**
 * Coverage trees: which tiles of the web-mercator grid a set of city-tile
 * archives OWNS, as a quadtree, and its compact text encoding.
 *
 * ## Why a quadtree and not boxes
 *
 * The city tiles are built per region (a Geofabrik extract — a country, a
 * state, a province; `docs/MAP_CITY_PLANET.md`), and a region is a polygon,
 * not a box: Portugal's bounding box holds half of Galicia. The archives must
 * nevertheless partition the ground exactly, because the client draws a tile
 * either from the city tiles or from the basemap, never both (`sources.ts`),
 * and the Worker must know which region's archive answers a given tile. So a
 * region OWNS a set of z15 tiles — those wholly inside its polygon
 * (`scripts/citygen/ownership.ts`) — and that set is what this module stores.
 *
 * A quadtree is the natural shape for it: a country's interior collapses into
 * a few large cells and only its border costs anything. Measured on Portugal
 * (`docs/MAP_CITY_PLANET.md` → "Coverage"), the whole ownership set is a few
 * kilobytes of text.
 *
 * ## The node model
 *
 * A node is {@link EMPTY} (0: no tile under it is owned), {@link FULL} (1:
 * every tile under it is), or an array of its four children (mixed), in the
 * order `(dy << 1) | dx` — child `i` of `(z, x, y)` is
 * `(z + 1, 2x + (i & 1), 2y + (i >> 1))`. The root is the z0 tile. Nothing is
 * mixed at `maxZoom`: a tile there is owned or not.
 *
 * ## The encoding
 *
 * Pre-order, two bits a node (0 empty, 1 full, 2 mixed — whose four children
 * follow), packed from the low bits of each byte up, base64. Decoding is
 * strict: an unknown code, a mixed node at `maxZoom`, a stream that ends early
 * or carries anything after the root's last node is refused rather than read
 * as something smaller, because a wrong coverage tree does not fail loudly —
 * it silently draws the wrong source for whole countries.
 *
 * Plain JavaScript for the same reason as `pmtiles.js`: the Worker bundle has
 * no TypeScript step, and the Worker, the compiler and the client must all
 * read the SAME code.
 */

/** No tile under this node is owned. */
export const EMPTY = 0;
/** Every tile under this node is owned. */
export const FULL = 1;
/** Some are: what {@link coverageAt} answers for a tile coarser than the leaves. */
export const MIXED = 2;

/** The deepest tree this module will build or read (2^30 tiles a side). */
const MAX_TREE_ZOOM = 24;

/** @typedef {0 | 1 | CoverageNode[]} CoverageNode */

/**
 * The tree's answer for one tile: {@link FULL}, {@link EMPTY}, or — for a tile
 * coarser than the leaves that is partly owned — {@link MIXED}. A tile finer
 * than `maxZoom` takes its ancestor's answer.
 *
 * @param {CoverageNode} tree
 * @param {number} maxZoom
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {0 | 1 | 2}
 */
export function coverageAt(tree, maxZoom, z, x, y) {
  let tx = x;
  let ty = y;
  let tz = z;
  if (tz > maxZoom) {
    tx = Math.floor(tx / 2 ** (tz - maxZoom));
    ty = Math.floor(ty / 2 ** (tz - maxZoom));
    tz = maxZoom;
  }
  const span = 2 ** tz;
  if (!(tx >= 0 && ty >= 0 && tx < span && ty < span)) return EMPTY;
  let node = tree;
  for (let level = tz - 1; level >= 0; level--) {
    if (!Array.isArray(node)) return node;
    const bit = 2 ** level;
    const dx = Math.floor(tx / bit) % 2;
    const dy = Math.floor(ty / bit) % 2;
    node = node[(dy << 1) | dx];
  }
  return Array.isArray(node) ? MIXED : node;
}

/**
 * Build a tree by asking `classify` about tiles, from z0 down: it answers
 * {@link EMPTY}, {@link FULL} or {@link MIXED} (look closer). `MIXED` at
 * `maxZoom` counts as empty — a tile partly owned is not owned.
 *
 * `context` is threaded through so a classifier can narrow what it tests per
 * branch (the polygon edges that cross this tile, say) instead of starting
 * from everything at every tile.
 *
 * @template C
 * @param {number} maxZoom
 * @param {(z: number, x: number, y: number, context: C) => { state: 0 | 1 | 2, context: C }} classify
 * @param {C} context
 * @returns {CoverageNode}
 */
export function buildCoverageTree(maxZoom, classify, context) {
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > MAX_TREE_ZOOM) {
    throw new Error(`coverage tree zoom ${maxZoom} is outside 0–${MAX_TREE_ZOOM}`);
  }
  const visit = (z, x, y, parentContext) => {
    const { state, context: narrowed } = classify(z, x, y, parentContext);
    if (state !== MIXED) return state;
    if (z === maxZoom) return EMPTY;
    const children = [];
    for (let i = 0; i < 4; i++) {
      children.push(visit(z + 1, x * 2 + (i & 1), y * 2 + (i >> 1), narrowed));
    }
    return normalise(children);
  };
  return visit(0, 0, 0, context);
}

/** Four children that agree are their parent. */
function normalise(children) {
  if (children.every((child) => child === FULL)) return FULL;
  if (children.every((child) => child === EMPTY)) return EMPTY;
  return children;
}

/**
 * Tiles owned by EITHER tree. Both must have the same `maxZoom`.
 *
 * @param {CoverageNode} a
 * @param {CoverageNode} b
 * @returns {CoverageNode}
 */
export function unionCoverageTrees(a, b) {
  if (a === FULL || b === FULL) return FULL;
  if (a === EMPTY) return b;
  if (b === EMPTY) return a;
  return normalise(a.map((child, i) => unionCoverageTrees(child, b[i])));
}

/**
 * Tiles owned by BOTH trees. Both must have the same `maxZoom`.
 *
 * @param {CoverageNode} a
 * @param {CoverageNode} b
 * @returns {CoverageNode}
 */
export function intersectCoverageTrees(a, b) {
  if (a === EMPTY || b === EMPTY) return EMPTY;
  if (a === FULL) return b;
  if (b === FULL) return a;
  return normalise(a.map((child, i) => intersectCoverageTrees(child, b[i])));
}

/**
 * Tiles owned by `a` and NOT by `b`. Both must have the same `maxZoom`. (The
 * satellite manifest takes a rebuild's cells out of the stamp it replaces.)
 *
 * @param {CoverageNode} a
 * @param {CoverageNode} b
 * @returns {CoverageNode}
 */
export function subtractCoverageTrees(a, b) {
  if (a === EMPTY || b === FULL) return EMPTY;
  if (b === EMPTY) return a;
  const children = a === FULL ? [FULL, FULL, FULL, FULL] : a;
  return normalise(children.map((child, i) => subtractCoverageTrees(child, b[i])));
}

/**
 * The same tree with its leaves at `zoom` (≤ its own): a tile at `zoom` is
 * owned only if EVERY tile under it was. Conservative by construction, which
 * is the direction a client's coverage must err in — a tile it thinks is
 * covered and is not would be drawn empty.
 *
 * @param {CoverageNode} tree
 * @param {number} zoom
 * @returns {CoverageNode}
 */
export function coarsenCoverageTree(tree, zoom) {
  const visit = (node, z) => {
    if (!Array.isArray(node)) return node;
    if (z === zoom) return EMPTY;
    return normalise(node.map((child) => visit(child, z + 1)));
  };
  return visit(tree, 0);
}

/**
 * How many tiles at `zoom` (≥ the tree's own leaves is fine) the tree owns.
 *
 * @param {CoverageNode} tree
 * @param {number} zoom
 * @returns {number}
 */
export function countCoverageTiles(tree, zoom) {
  const visit = (node, z) => {
    if (node === EMPTY) return 0;
    if (node === FULL) return 4 ** Math.max(0, zoom - z);
    if (z >= zoom) return 0;
    let total = 0;
    for (const child of node) total += visit(child, z + 1);
    return total;
  };
  return visit(tree, 0);
}

/**
 * Every owned cell, as `[z, x, y]` — the full nodes, at whatever zoom each
 * collapsed to. For tests and receipts; a planet-scale tree is large.
 *
 * @param {CoverageNode} tree
 * @returns {[number, number, number][]}
 */
export function coverageCells(tree) {
  const out = [];
  const visit = (node, z, x, y) => {
    if (node === FULL) out.push([z, x, y]);
    else if (Array.isArray(node)) {
      for (let i = 0; i < 4; i++) visit(node[i], z + 1, x * 2 + (i & 1), y * 2 + (i >> 1));
    }
  };
  visit(tree, 0, 0, 0);
  return out;
}

const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/**
 * The bounding box of the owned tiles, `[west, south, east, north]` in
 * degrees, or `null` for an empty tree.
 *
 * @param {CoverageNode} tree
 * @returns {[number, number, number, number] | null}
 */
export function coverageTreeBounds(tree) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  // In unit (z0) mercator coordinates, then converted once.
  for (const [z, x, y] of coverageCells(tree)) {
    const size = 1 / 2 ** z;
    x0 = Math.min(x0, x * size);
    y0 = Math.min(y0, y * size);
    x1 = Math.max(x1, (x + 1) * size);
    y1 = Math.max(y1, (y + 1) * size);
  }
  if (x0 === Infinity) return null;
  return [tileLon(x0, 0), tileLat(y1, 0), tileLon(x1, 0), tileLat(y0, 0)];
}

/**
 * The tree as text: `{ maxZoom, nodes, bits }`, `bits` being the base64 of
 * the two-bit pre-order stream described in the module header.
 *
 * @param {CoverageNode} tree
 * @param {number} maxZoom
 * @returns {{ maxZoom: number, nodes: number, bits: string }}
 */
export function encodeCoverageTree(tree, maxZoom) {
  const codes = [];
  const visit = (node, z) => {
    if (!Array.isArray(node)) {
      codes.push(node);
      return;
    }
    if (z >= maxZoom) throw new Error(`a mixed node at z${z} is below the tree's z${maxZoom}`);
    codes.push(MIXED);
    for (const child of node) visit(child, z + 1);
  };
  visit(tree, 0);
  const bytes = new Uint8Array(Math.ceil(codes.length / 4));
  for (let i = 0; i < codes.length; i++) bytes[i >> 2] |= codes[i] << ((i & 3) * 2);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return { maxZoom, nodes: codes.length, bits: btoa(binary) };
}

/**
 * Read {@link encodeCoverageTree}'s text back. Throws on anything that is not
 * exactly one well-formed tree.
 *
 * @param {{ maxZoom: unknown, bits: unknown }} encoded
 * @returns {CoverageNode}
 */
export function decodeCoverageTree(encoded) {
  const maxZoom = encoded?.maxZoom;
  const bits = encoded?.bits;
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > MAX_TREE_ZOOM) {
    throw new Error('coverage tree: maxZoom is not a zoom');
  }
  if (typeof bits !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(bits)) {
    throw new Error('coverage tree: bits is not base64');
  }
  const binary = atob(bits);
  const total = binary.length * 4;
  let at = 0;
  const next = () => {
    if (at >= total) throw new Error('coverage tree: the stream ends inside the tree');
    const code = (binary.charCodeAt(at >> 2) >> ((at & 3) * 2)) & 3;
    at++;
    return code;
  };
  const visit = (z) => {
    const code = next();
    if (code === EMPTY || code === FULL) return code;
    if (code !== MIXED) throw new Error('coverage tree: unknown node code');
    if (z >= maxZoom) throw new Error(`coverage tree: a mixed node at z${z}, its leaf zoom`);
    return [visit(z + 1), visit(z + 1), visit(z + 1), visit(z + 1)];
  };
  const tree = visit(0);
  // The padding of the last byte is zeros; a whole byte more is a second tree
  // or garbage, and either means this is not what the writer wrote.
  if (Math.ceil(at / 4) !== binary.length) {
    throw new Error('coverage tree: bytes after the end of the tree');
  }
  for (let i = at; i < total; i++) {
    if (((binary.charCodeAt(i >> 2) >> ((i & 3) * 2)) & 3) !== 0) {
      throw new Error('coverage tree: bits after the end of the tree');
    }
  }
  return tree;
}

/**
 * A tree decoded for lookups only, in five bytes a node: its code
 * (`Uint8Array`) and its subtree's node count (`Uint32Array`, to step over a
 * sibling). The nested-array form above costs ~20 bytes a node in V8 —
 * measured, the planet's 430 regional ownership trees are 4.58 M nodes, 91.6
 * MB that way — which a Worker isolate (128 MB) cannot hold; this form is
 * 23 MB for all of them, and the Worker keeps only the regions it is asked
 * about, within a byte budget. Decoding is as strict as
 * {@link decodeCoverageTree}.
 *
 * @param {{ maxZoom: unknown, bits: unknown }} encoded
 * @returns {{ maxZoom: number, codes: Uint8Array, skip: Uint32Array, bytes: number }}
 */
export function compactCoverageTree(encoded) {
  const maxZoom = encoded?.maxZoom;
  const bits = encoded?.bits;
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > MAX_TREE_ZOOM) {
    throw new Error('coverage tree: maxZoom is not a zoom');
  }
  if (typeof bits !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(bits)) {
    throw new Error('coverage tree: bits is not base64');
  }
  const binary = atob(bits);
  const total = binary.length * 4;
  const codes = new Uint8Array(total);
  const skip = new Uint32Array(total);
  // Open mixed nodes: their index, their depth, and children still to come.
  const open = [];
  let n = 0;
  for (;;) {
    if (n >= total) throw new Error('coverage tree: the stream ends inside the tree');
    const code = (binary.charCodeAt(n >> 2) >> ((n & 3) * 2)) & 3;
    const depth = open.length === 0 ? 0 : open[open.length - 1].depth + 1;
    codes[n] = code;
    if (code === MIXED) {
      if (depth >= maxZoom)
        throw new Error(`coverage tree: a mixed node at z${depth}, its leaf zoom`);
      open.push({ index: n, depth, left: 4 });
      n += 1;
      continue;
    }
    if (code !== EMPTY && code !== FULL) throw new Error('coverage tree: unknown node code');
    skip[n] = 1;
    const last = n;
    n += 1;
    // Close every mixed node this leaf completes.
    while (open.length > 0) {
      const top = open[open.length - 1];
      top.left -= 1;
      if (top.left > 0) break;
      open.pop();
      skip[top.index] = last - top.index + 1;
    }
    if (open.length === 0) break;
  }
  if (Math.ceil(n / 4) !== binary.length) {
    throw new Error('coverage tree: bytes after the end of the tree');
  }
  for (let i = n; i < total; i++) {
    if (((binary.charCodeAt(i >> 2) >> ((i & 3) * 2)) & 3) !== 0) {
      throw new Error('coverage tree: bits after the end of the tree');
    }
  }
  return { maxZoom, codes: codes.slice(0, n), skip: skip.slice(0, n), bytes: n * 5 };
}

/**
 * {@link coverageAt} over a {@link compactCoverageTree}.
 *
 * @returns {0 | 1 | 2}
 */
export function compactCoverageAt(tree, z, x, y) {
  const { maxZoom, codes, skip } = tree;
  let tx = x;
  let ty = y;
  let tz = z;
  if (tz > maxZoom) {
    tx = Math.floor(tx / 2 ** (tz - maxZoom));
    ty = Math.floor(ty / 2 ** (tz - maxZoom));
    tz = maxZoom;
  }
  const span = 2 ** tz;
  if (!(tx >= 0 && ty >= 0 && tx < span && ty < span)) return EMPTY;
  let node = 0;
  for (let level = tz - 1; level >= 0; level--) {
    if (codes[node] !== MIXED) return codes[node];
    const bit = 2 ** level;
    const child = ((Math.floor(ty / bit) % 2) << 1) | (Math.floor(tx / bit) % 2);
    let at = node + 1;
    for (let c = 0; c < child; c++) at += skip[at];
    node = at;
  }
  return codes[node] === MIXED ? MIXED : codes[node];
}
