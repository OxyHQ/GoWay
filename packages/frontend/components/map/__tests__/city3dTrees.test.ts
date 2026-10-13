/**
 * The city-3D trees: placed ONLY inside areas the tiles map as wood or park,
 * never on water, buildings, pitches, open lawns or paths; the same tile always
 * grows the same trees; a budget per tile; colours derived from the palette;
 * and the honesty rule that none of this is presented as mapped trees.
 *
 * The decode test encodes its tile by hand over `pbf`'s writer, as the mesher's
 * does, rather than trusting a fixture made by the code under test.
 */
import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PbfWriter } from 'pbf';

import { treeColours } from '@/components/map/city3dTrees';
import type { Point2 } from '@/components/map/engine/city3d/mesher';
import {
  bumpyCanopy,
  CROWN,
  CROWN_FRAMES,
  farConiferShape,
  farPalmShape,
  farTreeShape,
  nearConiferShape,
  nearPalmShape,
  nearTreeShape,
} from '@/components/map/engine/city3d/treeGeometry';
import {
  createTreeMaterials,
  treeMinHeightM,
} from '@/components/map/engine/city3d/tsl/treeMaterial';
import { decodeTreeSources } from '@/components/map/engine/city3d/treeSources';
import {
  crownFromCircumferenceM,
  KIND_CONIFER,
  KIND_MAPPED,
  KIND_PALM,
  KIND_STREET,
  KIND_WOOD,
  landcoverRole,
  MAPPED_TREE_HEIGHT_M,
  mappedTreePoints,
  packTrees,
  shapeOf,
  standTrees,
  TREE_SHAPES,
  landuseRole,
  NONE,
  PARK,
  pathHalfWidthM,
  placeTrees,
  rasterizeTreeAreas,
  STREET_TREE,
  TREES,
  treeForm,
  type TreeInstances,
  type TreeSources,
  WOOD,
} from '@/components/map/engine/city3d/trees';
import { CARTOGRAPHY_PALETTES } from '@/lib/map/style/palette';
import { parseCircumference, parseMetres, treeCrown } from '@/scripts/citygen/treeTags';

/** Extent 4096 over 4096 m: one tile unit is one metre. */
const SIZE = 4096;
const TILE = { x: 8291, y: 6119 };

const square = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

const empty = (): TreeSources => ({
  extent: 4096,
  wood: [],
  park: [],
  lawn: [],
  blocked: [],
  paths: [],
});

/** Tree positions back in metres (tile units here). */
function positions(trees: TreeInstances | null): Point2[] {
  if (!trees) return [];
  const out: Point2[] = [];
  const toMetres = trees.unitM;
  for (let i = 0; i < trees.count; i++) {
    out.push([trees.data[i * 4] * toMetres, trees.data[i * 4 + 1] * toMetres]);
  }
  return out;
}

const inside = ([x, y]: Point2, x0: number, y0: number, x1: number, y1: number) =>
  x >= x0 && x <= x1 && y >= y0 && y <= y1;

describe('what the tiles say about trees', () => {
  test('wood is wood; park-like grass is sparse; open grass and bare ground take none', () => {
    expect(landcoverRole('wood', 'forest')).toBe('wood');
    expect(landcoverRole('wood', 'wood')).toBe('wood');
    for (const sub of ['park', 'garden', 'recreation_ground', 'village_green']) {
      expect(landcoverRole('grass', sub)).toBe('park');
    }
    expect(landcoverRole('grass', 'grass')).toBe('lawn');
    for (const sub of ['meadow', 'grassland', 'heath', 'scrub', 'allotments', 'flowerbed']) {
      expect(landcoverRole('grass', sub)).toBe('blocked');
    }
    for (const cls of ['sand', 'rock', 'wetland', 'ice', 'farmland']) {
      expect(landcoverRole(cls, cls)).toBe('blocked');
    }
    expect(landuseRole('park')).toBe('park');
    expect(landuseRole('pitch')).toBe('blocked');
    expect(landuseRole('playground')).toBe('blocked');
    expect(landuseRole('residential')).toBeNull();
  });

  test('wider roads clear wider strips', () => {
    expect(pathHalfWidthM('path')).toBeLessThan(pathHalfWidthM('minor'));
    expect(pathHalfWidthM('minor')).toBeLessThan(pathHalfWidthM('primary'));
  });
});

describe('placeTrees', () => {
  test('no wood and no park: no trees, whatever else the tile has', () => {
    const sources = empty();
    sources.lawn.push([square(0, 0, 500, 500)]);
    sources.blocked.push([square(0, 0, 100, 100)]);
    expect(placeTrees(sources, TILE, SIZE)).toBeNull();
    expect(rasterizeTreeAreas(sources, SIZE)).toBeNull();
  });

  test('trees stand only inside the mapped areas', () => {
    const sources = empty();
    sources.wood.push([square(100, 100, 400, 400)]);
    sources.park.push([square(1000, 1000, 1400, 1400)]);
    const trees = placeTrees(sources, TILE, SIZE);
    const points = positions(trees);
    expect(points.length).toBeGreaterThan(100);
    for (const p of points) {
      expect(inside(p, 100, 100, 400, 400) || inside(p, 1000, 1000, 1400, 1400)).toBe(true);
    }
  });

  test('the fill stands in woods at the configured density, and in no park or lawn', () => {
    const count = (fill: (s: TreeSources) => void) => {
      const s = empty();
      fill(s);
      return placeTrees(s, TILE, SIZE)?.count ?? 0;
    };
    const area = square(200, 200, 1200, 1200);
    const wood = count((s) => s.wood.push([area]));
    expect(count((s) => s.park.push([area]))).toBe(0);
    expect(
      count((s) => {
        s.park.push([area]);
        s.lawn.push([area]);
      }),
    ).toBe(0);
    // Density near the configured spacing (a 1 km² wood at 7 m ≈ 20,000 lattice cells).
    expect(wood).toBeGreaterThan((1e6 / TREES.woodSpacingM ** 2) * 0.7);
    expect(wood).toBeLessThan(1e6 / TREES.woodSpacingM ** 2);
  });

  test('water, buildings and paths inside a wood stay clear', () => {
    const sources = empty();
    sources.wood.push([square(0, 0, 1000, 1000)]);
    sources.blocked.push([square(200, 200, 400, 400)]); // a pond
    sources.paths.push({
      points: [
        [0, 700],
        [1000, 700],
      ],
      halfWidthM: 3,
    });
    const points = positions(placeTrees(sources, TILE, SIZE));
    expect(points.length).toBeGreaterThan(1000);
    // Nothing in the pond (nor within one raster cell of its shore)…
    expect(points.filter((p) => inside(p, 200, 200, 400, 400)).length).toBe(0);
    // …nor on the path or its verge.
    expect(points.filter(([, y]) => Math.abs(y - 700) <= 3).length).toBe(0);
  });

  test('a lawn outside any park grows nothing; a courtyard hole in a wood stays empty', () => {
    const sources = empty();
    // A wood with a hole (even-odd: the inner ring is a clearing).
    sources.wood.push([square(0, 0, 600, 600), square(200, 200, 400, 400)]);
    sources.lawn.push([square(2000, 2000, 2500, 2500)]);
    const points = positions(placeTrees(sources, TILE, SIZE));
    expect(points.filter((p) => inside(p, 205, 205, 395, 395)).length).toBe(0);
    expect(points.filter((p) => inside(p, 2000, 2000, 2500, 2500)).length).toBe(0);
  });

  test('the same tile always grows the same trees; another tile other trees', () => {
    const sources = empty();
    sources.wood.push([square(0, 0, 800, 800)]);
    const a = placeTrees(sources, TILE, SIZE);
    const b = placeTrees(sources, TILE, SIZE);
    const c = placeTrees(sources, { x: TILE.x + 1, y: TILE.y }, SIZE);
    expect(a?.data).toEqual(b?.data as Uint16Array);
    expect(a?.data).not.toEqual(c?.data as Uint16Array);
  });

  test('an all-forest tile is thinned evenly to the per-tile budget', () => {
    const sources = empty();
    sources.wood.push([square(0, 0, 4096, 4096)]);
    const trees = placeTrees(sources, TILE, SIZE);
    expect(trees?.count).toBeLessThanOrEqual(TREES.maxPerTile);
    expect(trees?.count).toBeGreaterThan(TREES.maxPerTile * 0.9);
    // Evenly: every quadrant keeps roughly a quarter.
    const points = positions(trees);
    const quadrants = [0, 0, 0, 0];
    for (const [x, y] of points) quadrants[(x < 2048 ? 0 : 1) + (y < 2048 ? 0 : 2)]++;
    for (const q of quadrants) expect(q / points.length).toBeGreaterThan(0.2);
  });

  test('sizes are in the stated ranges, kinds follow the area, some are conifers', () => {
    const sources = empty();
    sources.wood.push([square(0, 0, 400, 400)]);
    sources.park.push([square(1000, 1000, 1600, 1600)]);
    const trees = standTrees(sources, TILE, SIZE);
    let conifers = 0;
    for (const tree of trees) {
      const wood = (tree.kind & KIND_WOOD) !== 0;
      const conifer = (tree.kind & KIND_CONIFER) !== 0;
      if (conifer) conifers++;
      const [lo, hi] = conifer
        ? TREES.coniferHeightM
        : wood
          ? TREES.woodHeightM
          : TREES.parkHeightM;
      expect(tree.heightM).toBeGreaterThanOrEqual(lo);
      expect(tree.heightM).toBeLessThanOrEqual(hi);
      expect(wood).toBe(tree.x < 500);
      expect(tree.kind & KIND_MAPPED).toBe(0);
    }
    // A styling mix, roughly the configured shares.
    expect(conifers / trees.length).toBeGreaterThan(0.08);
    expect(conifers / trees.length).toBeLessThan(0.35);
  });

  test('packing sorts trees into one contiguous range per shape', () => {
    const sources = empty();
    sources.wood.push([square(0, 0, 800, 800)]);
    const points = standTrees(sources, TILE, SIZE);
    const packed = packTrees(points, SIZE) as TreeInstances;
    expect(packed.ranges).toHaveLength(TREE_SHAPES.length);
    expect(packed.ranges.reduce((a, b) => a + b, 0)).toBe(points.length);
    // Every broadleaf variant gets a share; conifers sit after them.
    for (let v = 0; v < 3; v++) expect(packed.ranges[v]).toBeGreaterThan(points.length * 0.15);
    let at = 0;
    packed.ranges.forEach((count, shape) => {
      for (let i = at; i < at + count; i++) {
        const kind = packed.data[i * 4 + 3] >> 8;
        expect((kind & KIND_CONIFER) !== 0).toBe(shape === 3);
      }
      at += count;
    });
  });

  test('the fill keeps clear of trees OpenStreetMap records, and of the window’s outside', () => {
    const sources = empty();
    sources.wood.push([square(0, 0, 1000, 1000)]);
    const mapped: Point2[] = [
      [300, 300],
      [600, 600],
    ];
    const window = { x0: 0, y0: 0, x1: 500, y1: 1000 };
    const points = standTrees(sources, TILE, SIZE, { mapped, window });
    expect(points.length).toBeGreaterThan(500);
    for (const { x, y } of points) {
      expect(x).toBeLessThan(500);
      for (const [mx, my] of mapped) {
        expect(Math.hypot(x - mx, y - my)).toBeGreaterThan(TREES.mappedClearanceM - 1);
      }
    }
  });

  test('mapped trees keep their position and crown, and an id-stable seed', () => {
    const points = mappedTreePoints(
      [
        { id: 4_000_000_001, x: 100, y: 200, crown: 'palm', heightM: 9 },
        { id: 7, x: 4096, y: 0 },
        { id: 8, x: 0, y: 0, crown: 'conifer' },
      ],
      4096,
      SIZE,
    );
    expect(points[0]).toMatchObject({ x: 100, y: 200, heightM: 9 });
    expect(points[0].kind).toBe(KIND_MAPPED | KIND_PALM);
    expect(points[1].kind).toBe(KIND_MAPPED);
    expect(points[2].kind).toBe(KIND_MAPPED | KIND_CONIFER);
    // Unrecorded heights are a typical size for the crown.
    const [lo, hi] = MAPPED_TREE_HEIGHT_M.broadleaf;
    expect(points[1].heightM).toBeGreaterThanOrEqual(lo);
    expect(points[1].heightM).toBeLessThanOrEqual(hi);
    const again = mappedTreePoints([{ id: 7, x: 4096, y: 0 }], 4096, SIZE);
    expect(again[0].seed).toBe(points[1].seed);
    expect(shapeOf(points[0])).toBe(4);
    expect(shapeOf(points[2])).toBe(3);
  });

  test('the raster classes: park, then wood over it, then what is blocked', () => {
    const sources = empty();
    sources.park.push([square(0, 0, 100, 100)]);
    sources.wood.push([square(50, 0, 100, 100)]);
    sources.blocked.push([square(80, 80, 100, 100)]);
    const grid = rasterizeTreeAreas(sources, SIZE);
    expect(grid?.at(20, 20)).toBe(PARK);
    expect(grid?.at(60, 20)).toBe(WOOD);
    expect(grid?.at(90, 90)).toBe(NONE);
  });
});

describe('decodeTreeSources', () => {
  // A hand-encoded tile: landcover (one wood), water (one pond), transportation
  // (one path), building (one block). Vector-tile spec, layer = field 3.
  function encodeTile(): Uint8Array {
    const pbf = new PbfWriter();
    const command = (id: number, count: number) => (count << 3) | id;
    const zigzag = (n: number) => (n << 1) ^ (n >> 31);
    const geometry = (rings: Point2[][], closedRing: boolean) => {
      const out: number[] = [];
      let cx = 0;
      let cy = 0;
      for (const ring of rings) {
        const pts = closedRing ? ring.slice(0, -1) : ring;
        out.push(command(1, 1), zigzag(pts[0][0] - cx), zigzag(pts[0][1] - cy));
        [cx, cy] = pts[0];
        out.push(command(2, pts.length - 1));
        for (const [x, y] of pts.slice(1)) {
          out.push(zigzag(x - cx), zigzag(y - cy));
          cx = x;
          cy = y;
        }
        if (closedRing) out.push(command(7, 1));
      }
      return out;
    };
    const layer = (
      name: string,
      keys: string[],
      values: string[],
      features: { tags: number[]; type: number; geometry: number[] }[],
    ) => {
      pbf.writeMessage(
        3,
        (_: unknown, w: PbfWriter) => {
          w.writeVarintField(15, 2);
          w.writeStringField(1, name);
          for (const f of features) {
            w.writeMessage(
              2,
              (__: unknown, fw: PbfWriter) => {
                fw.writePackedVarint(2, f.tags);
                fw.writeVarintField(3, f.type);
                fw.writePackedVarint(4, f.geometry);
              },
              null,
            );
          }
          for (const k of keys) w.writeStringField(3, k);
          for (const v of values)
            w.writeMessage(4, (__: unknown, vw: PbfWriter) => vw.writeStringField(1, v), null);
          w.writeVarintField(5, 4096);
        },
        null,
      );
    };
    // Clockwise as drawn (y down) = positive area in tile coordinates: exteriors.
    const cw = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ];
    layer(
      'landcover',
      ['class', 'subclass'],
      ['wood', 'forest'],
      [{ tags: [0, 0, 1, 1], type: 3, geometry: geometry([cw(0, 0, 1000, 1000)], true) }],
    );
    layer(
      'water',
      ['class'],
      ['lake'],
      [{ tags: [0, 0], type: 3, geometry: geometry([cw(100, 100, 300, 300)], true) }],
    );
    layer(
      'transportation',
      ['class'],
      ['path'],
      [
        {
          tags: [0, 0],
          type: 2,
          geometry: geometry(
            [
              [
                [0, 600],
                [1000, 600],
              ],
            ],
            false,
          ),
        },
      ],
    );
    layer(
      'building',
      ['render_height'],
      ['x'],
      [{ tags: [], type: 3, geometry: geometry([cw(700, 100, 800, 200)], true) }],
    );
    return pbf.finish();
  }

  const LAYERS = {
    landcover: 'landcover',
    landuse: 'landuse',
    water: 'water',
    transportation: 'transportation',
    building: 'building',
  };

  test('reads the wood, and everything that blocks it, from real tile bytes', () => {
    const sources = decodeTreeSources(encodeTile(), LAYERS) as TreeSources;
    expect(sources.wood.length).toBe(1);
    expect(sources.blocked.length).toBe(2); // the pond and the building
    expect(sources.paths.length).toBe(1);
    expect(sources.paths[0].halfWidthM).toBe(pathHalfWidthM('path'));
    const points = positions(placeTrees(sources, TILE, SIZE));
    expect(points.length).toBeGreaterThan(1000);
    expect(points.filter((p) => inside(p, 100, 100, 300, 300)).length).toBe(0);
    expect(points.filter((p) => inside(p, 700, 100, 800, 200)).length).toBe(0);
  });

  test('a tile with no wood or park decodes to nothing', () => {
    expect(decodeTreeSources(encodeTile(), { ...LAYERS, landcover: 'nope' })).toBeNull();
  });
});

describe('tree shapes and shader', () => {
  const SHAPES = {
    broadleaf0: nearTreeShape(0),
    broadleaf1: nearTreeShape(1),
    broadleaf2: nearTreeShape(2),
    broadleafFar: farTreeShape(),
    conifer: nearConiferShape(),
    coniferFar: farConiferShape(),
    palm: nearPalmShape(),
    palmFar: farPalmShape(),
  };

  test('triangle budgets per shape', () => {
    const triangles = Object.fromEntries(
      Object.entries(SHAPES).map(([name, shape]) => [name, shape.indices.length / 3]),
    );
    expect(triangles).toEqual({
      broadleaf0: 98,
      broadleaf1: 98,
      broadleaf2: 98,
      broadleafFar: 20,
      conifer: 34,
      coniferFar: 6,
      palm: 74,
      palmFar: 30,
    });
  });

  test('broadleaf canopies are bumpy, not spheres, and differ from each other', () => {
    const spread = (variant: number) => {
      const { vertices } = bumpyCanopy(variant);
      const radii = vertices.map((v) => Math.hypot(v[0], v[1], v[2]));
      return { min: Math.min(...radii), max: Math.max(...radii), radii };
    };
    for (const variant of [0, 1, 2]) {
      const { min, max } = spread(variant);
      expect(max).toBeCloseTo(1, 10);
      expect(min).toBeLessThan(0.92);
    }
    expect(spread(0).radii).not.toEqual(spread(1).radii);
  });

  test('every triangle faces outward or up', () => {
    for (const [name, shape] of Object.entries(SHAPES)) {
      const { positions: p, indices, part } = shape;
      for (let t = 0; t < indices.length; t += 3) {
        const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => [
          p[i * 3],
          p[i * 3 + 1],
          p[i * 3 + 2],
        ]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const m = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        const kind = part[indices[t]];
        let out: number;
        if (kind === 2 || (name.startsWith('palm') && kind === 1)) {
          out = n[2]; // shadow discs and fronds face up
        } else if (kind === 0 || name.startsWith('conifer')) {
          out = n[0] * m[0] + n[1] * m[1]; // away from the axis
        } else {
          out = n[0] * m[0] + n[1] * m[1] + n[2] * (m[2] - CROWN.centre); // away from the crown's centre
        }
        expect(out).toBeGreaterThan(0);
      }
    }
  });

  test('one shared tree material and its dithered variant, as the buildings have (TSL)', () => {
    const v = () => ({ value: new THREE.Vector3() });
    const materials = createTreeMaterials(
      {
        uCrown: v(),
        uConifer: v(),
        uTrunk: v(),
        uTreeMinHeight: { value: 0 },
        uLightPosition: v(),
        uLightIntensity: { value: 0.5 },
        uLightColor: v(),
        uGrounded: { value: 0 },
      },
      THREE.BackSide,
    );
    const settled = materials.get(false);
    expect(materials.get(false)).toBe(settled);
    const dithered = materials.get(true);
    expect(dithered).not.toBe(settled);
    expect(dithered.colorNode).not.toBe(settled.colorNode);
    for (const material of [settled, dithered]) {
      expect(material.positionNode).toBeTruthy();
      expect(material.side).toBe(THREE.BackSide);
    }
  });

  test('zoomed out the tallest trees show first; from zoom 18 all of them', () => {
    expect(treeMinHeightM(15.5)).toBe(10);
    expect(treeMinHeightM(16.5)).toBeGreaterThan(treeMinHeightM(17));
    expect(treeMinHeightM(18)).toBe(0);
    expect(treeMinHeightM(20)).toBe(0);
  });
});

describe('what OpenStreetMap records about a tree', () => {
  test('crown form from the botanical name, the family or leaf_type; nothing else', () => {
    expect(treeCrown({ genus: 'Phoenix' })).toBe('palm');
    expect(treeCrown({ species: 'Washingtonia robusta' })).toBe('palm');
    expect(treeCrown({ taxon: 'Arecaceae' })).toBe('palm');
    expect(treeCrown({ leaf_type: 'palm' })).toBe('palm');
    expect(treeCrown({ species: 'Pinus pinea' })).toBe('conifer');
    expect(treeCrown({ 'taxon:family': 'Cupressaceae' })).toBe('conifer');
    expect(treeCrown({ leaf_type: 'needleleaved' })).toBe('conifer');
    expect(treeCrown({ leaf_type: 'broadleaved', genus: 'Platanus' })).toBe('broadleaf');
    expect(treeCrown({ genus: 'Platanus' })).toBeUndefined();
    expect(treeCrown({})).toBeUndefined();
  });

  test('lengths are read only when they are lengths', () => {
    expect(parseMetres('12')).toBe(12);
    expect(parseMetres('12.5 m')).toBe(12.5);
    expect(parseMetres('7,5')).toBe(7.5);
    expect(parseMetres('30cm')).toBeUndefined();
    expect(parseMetres('tall')).toBeUndefined();
    expect(parseMetres('999')).toBeUndefined();
  });
});

describe('how a tree is drawn: its form', () => {
  const tree = (kind: number, heightM: number, seed = 0.37, crownDiameterM?: number) => ({
    x: 0,
    y: 0,
    seed,
    kind,
    heightM,
    ...(crownDiameterM === undefined ? {} : { crownDiameterM }),
  });

  test('a park, wood or rural tree keeps the proportions it always had', () => {
    for (const seed of [0.01, 0.37, 0.64, 0.99]) {
      const form = treeForm(tree(KIND_MAPPED, 12, seed));
      // The unit canopy scaled by the height: its foot at 0.2, its reach 0.33,
      // 0.86–1.16 as wide by the seed.
      expect(form.crownBaseM).toBeCloseTo(CROWN_FRAMES.broadleaf.base * 12, 6);
      expect(form.crownDiameterM).toBeGreaterThanOrEqual(2 * 0.33 * 12 * 0.86 - 1e-6);
      expect(form.crownDiameterM).toBeLessThanOrEqual(2 * 0.33 * 12 * 1.16 + 1e-6);
    }
    const conifer = treeForm(tree(KIND_MAPPED | KIND_CONIFER, 15));
    expect(conifer.crownBaseM).toBeCloseTo(CROWN_FRAMES.conifer.base * 15, 6);
  });

  test('a street tree is a modest lollipop: a clear trunk above a bus, a crown that leaves the street', () => {
    const points = mappedTreePoints(
      Array.from({ length: 400 }, (_, i) => ({ id: 1000 + i * 7919, x: 0, y: 0, street: true })),
      4096,
      SIZE,
    );
    for (const point of points) {
      expect(point.kind & KIND_STREET).toBe(KIND_STREET);
      const form = treeForm(point);
      expect(form.heightM).toBeGreaterThanOrEqual(STREET_TREE.heightM[0]);
      expect(form.heightM).toBeLessThanOrEqual(STREET_TREE.heightM[1]);
      // A double-decker is 4.4 m; a city bus 3.2 m.
      expect(form.crownBaseM).toBeGreaterThanOrEqual(3.8);
      expect(form.crownDiameterM).toBeLessThanOrEqual(STREET_TREE.maxCrownM);
      expect(form.crownDiameterM).toBeGreaterThan(3.5);
    }
    // Today's park tree of the same id: lower and wider.
    const park = mappedTreePoints([{ id: 1000, x: 0, y: 0 }], 4096, SIZE)[0];
    const street = mappedTreePoints([{ id: 1000, x: 0, y: 0, street: true }], 4096, SIZE)[0];
    expect(treeForm(park).crownBaseM).toBeLessThan(3);
    expect(treeForm(street).crownBaseM).toBeGreaterThan(treeForm(park).crownBaseM + 1.5);
  });

  test('what OSM records wins: height, crown diameter, a crown from the trunk’s circumference', () => {
    const [height, crown, girth, both] = mappedTreePoints(
      [
        { id: 1, x: 0, y: 0, street: true, heightM: 18 },
        { id: 2, x: 0, y: 0, street: true, crownDiameterM: 11 },
        { id: 3, x: 0, y: 0, circumferenceM: 1.2 },
        { id: 4, x: 0, y: 0, heightM: 7, crownDiameterM: 3, circumferenceM: 2 },
      ],
      4096,
      SIZE,
    );
    expect(height.heightM).toBe(18);
    // 45% of 18 m, held to the 6 m a clear trunk reaches.
    expect(treeForm(height).crownBaseM).toBe(STREET_TREE.clearTrunkM[1]);
    // A recorded crown is drawn as recorded, on a tree tall enough to carry it.
    expect(treeForm(crown).crownDiameterM).toBe(11);
    expect(crown.heightM).toBeGreaterThanOrEqual(3 + 0.8 * 11);
    // 1.2 m round: 38 cm across, so a crown of about 9 m.
    expect(treeForm(girth).crownDiameterM).toBeCloseTo(crownFromCircumferenceM(1.2), 6);
    expect(crownFromCircumferenceM(1.2)).toBeCloseTo(1.5 + (0.2 * 120) / Math.PI, 6);
    // diameter_crown beats the circumference's estimate; the height is kept.
    expect(both.heightM).toBe(7);
    expect(treeForm(both).crownDiameterM).toBe(3);
  });

  test('a palm stays a palm on a street', () => {
    const [palm] = mappedTreePoints(
      [{ id: 9, x: 0, y: 0, crown: 'palm', street: true }],
      4096,
      SIZE,
    );
    expect(palm.kind & KIND_STREET).toBe(0);
    expect(treeForm(palm).crownBaseM).toBeCloseTo(CROWN_FRAMES.palm.base * palm.heightM, 6);
  });

  test('packing carries each tree’s form, in decimetres, in the same order as its instance', () => {
    const points = mappedTreePoints(
      [
        { id: 11, x: 10, y: 10, street: true },
        { id: 12, x: 20, y: 20, crown: 'conifer' },
        { id: 13, x: 30, y: 30, heightM: 20, crownDiameterM: 12 },
      ],
      4096,
      SIZE,
    );
    const packed = packTrees(points, SIZE) as TreeInstances;
    expect(packed.form).toHaveLength(packed.count * 2);
    for (let i = 0; i < packed.count; i++) {
      const x = Math.round(packed.data[i * 4] * packed.unitM);
      const point = points.find((p) => Math.round(p.x) === x) as (typeof points)[number];
      const form = treeForm({ ...point, heightM: Math.round(point.heightM * 2) / 2 });
      expect(packed.form[i * 2]).toBe(Math.round(form.crownBaseM * 10));
      expect(packed.form[i * 2 + 1]).toBe(Math.round(form.crownDiameterM * 10));
    }
  });

  test('the shapes’ crown frames are where the unit trees’ crowns are', () => {
    const lowest = (shape: ReturnType<typeof nearTreeShape>) => {
      let z = Infinity;
      let r = 0;
      for (let i = 0; i < shape.part.length; i++) {
        if (shape.part[i] !== 1) continue;
        z = Math.min(z, shape.positions[i * 3 + 2]);
        r = Math.max(r, Math.hypot(shape.positions[i * 3], shape.positions[i * 3 + 1]));
      }
      return { z, r };
    };
    for (const variant of [0, 1, 2]) {
      const { z, r } = lowest(nearTreeShape(variant));
      expect(z).toBeGreaterThanOrEqual(CROWN_FRAMES.broadleaf.base - 1e-6);
      expect(r).toBeLessThanOrEqual(CROWN_FRAMES.broadleaf.radius + 1e-6);
    }
    const conifer = lowest(nearConiferShape());
    expect(conifer.z).toBeCloseTo(CROWN_FRAMES.conifer.base, 6);
    expect(conifer.r).toBeCloseTo(CROWN_FRAMES.conifer.radius, 6);
  });

  test('a trunk circumference is read in metres or centimetres', () => {
    expect(parseCircumference('1.2')).toBe(1.2);
    expect(parseCircumference('1,2 m')).toBe(1.2);
    expect(parseCircumference('120 cm')).toBe(1.2);
    expect(parseCircumference('huge')).toBeUndefined();
    expect(parseCircumference('0.01')).toBeUndefined();
  });
});

describe('tree colours', () => {
  test('derived from each palette’s park colour: darker on the light map, lighter on the dark', () => {
    const luma = (hex: string) => {
      const v = Number.parseInt(hex.slice(1), 16);
      return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
    };
    const light = treeColours(CARTOGRAPHY_PALETTES.light);
    const dark = treeColours(CARTOGRAPHY_PALETTES.dark);
    for (const c of [light.crown, light.trunk, dark.crown, dark.trunk]) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(luma(light.crown)).toBeLessThan(luma(CARTOGRAPHY_PALETTES.light.park));
    expect(luma(dark.crown)).toBeGreaterThan(luma(CARTOGRAPHY_PALETTES.dark.park));
    expect(luma(light.trunk)).toBeLessThan(luma(light.crown));
  });
});

describe('honesty', () => {
  test('the design note says the trees are styling, and how to turn them off', () => {
    const doc = readFileSync(join(import.meta.dir, '../../../../../docs/MAP_3D_CITY.md'), 'utf8');
    expect(doc).toMatch(/^### .*Trees/m);
    expect(doc).toMatch(/no individual\s+trees/i);
    expect(doc).toContain('city3dTrees=0');
  });
});
