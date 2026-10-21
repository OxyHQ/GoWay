/**
 * The street's vertex shader stands every vertex on the ground the CPU
 * measures against MapLibre's terrain mesh (`city3dTerrainSampler.test.ts`):
 * the shader's ground IS `streetGroundFacet` in TSL (`TSL_GROUND_MATH`), so
 * here its node graph is EVALUATED on the CPU — a small interpreter of the
 * nodes it is made of — and compared with `streetGroundAt` at points all over
 * a tile and its margin. A flipped diagonal, a dropped margin, a swapped
 * select or a wrong clamp in either instance shows up as metres.
 */
import { describe, expect, test } from 'bun:test';
import { uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';

import {
  CPU_GROUND_MATH,
  STREET_GROUND_MARGIN,
  type StreetGround,
  streetGroundAt,
  streetGroundFacet,
} from '@/components/map/engine/city3d/terrainGround';
import { TSL_GROUND_MATH } from '@/components/map/engine/cityStreets/streetMaterials';

type AnyNode = {
  constructor: { name: string };
  node?: AnyNode;
  op?: string;
  method?: string;
  aNode?: AnyNode;
  bNode?: AnyNode;
  cNode?: AnyNode;
  condNode?: AnyNode;
  ifNode?: AnyNode;
  elseNode?: AnyNode;
  value?: number;
  /** The test's own marker: a corner of the ground grid, at these node coordinates. */
  corner?: { i: AnyNode; j: AnyNode };
};

/** Evaluate the nodes the ground is built of; anything else is an error, never a guess. */
function evaluate(node: AnyNode, read: (i: number, j: number) => number): number | boolean {
  const kind = node.constructor.name;
  const num = (n: AnyNode | undefined) => evaluate(n as AnyNode, read) as number;
  if (node.corner) return read(num(node.corner.i), num(node.corner.j));
  switch (kind) {
    case 'VarNode':
      return evaluate(node.node as AnyNode, read);
    case 'ConstNode':
    case 'UniformNode':
      return node.value as number;
    case 'ConditionalNode':
      return evaluate(node.condNode as AnyNode, read)
        ? evaluate(node.ifNode as AnyNode, read)
        : evaluate(node.elseNode as AnyNode, read);
    case 'OperatorNode': {
      const a = num(node.aNode);
      const b = num(node.bNode);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '>=':
          return a >= b;
        case '>':
          return a > b;
        case '<=':
          return a <= b;
        case '<':
          return a < b;
      }
      throw new Error(`operator ${node.op}`);
    }
    case 'MathNode':
      switch (node.method) {
        case 'floor':
          return Math.floor(num(node.aNode));
        case 'min':
          return Math.min(num(node.aNode), num(node.bNode));
        case 'max':
          return Math.max(num(node.aNode), num(node.bNode));
        case 'clamp':
          return Math.max(num(node.bNode), Math.min(num(node.cNode), num(node.aNode)));
      }
      throw new Error(`math ${node.method}`);
  }
  throw new Error(`node ${kind}`);
}

/** A street ground over a 4-square tile: a tilted, twisted surface, so a wrong facet or offset is metres off. */
function ground(): StreetGround {
  const cells = 4;
  const m = STREET_GROUND_MARGIN;
  const size = cells + 1 + 2 * m;
  const values = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) values[j * size + i] = 30 + 2.5 * i - 1.25 * j + 3 * ((i * 7 + j * 3) % 5);
  }
  return { values, cells, size };
}

describe("the shader's street ground", () => {
  const street = ground();
  const u = uniform(0);
  const v = uniform(0);
  const graph = streetGroundFacet(TSL_GROUND_MATH, u, v, street.cells, (i, j) => {
    const marker = uniform(0) as unknown as AnyNode;
    marker.corner = { i: i as unknown as AnyNode, j: j as unknown as AnyNode };
    return marker as unknown as Node<'float'>;
  }) as unknown as AnyNode;
  const read = (i: number, j: number) => {
    expect(Number.isInteger(i) && Number.isInteger(j)).toBe(true);
    return street.values[j * street.size + i];
  };

  test('is the CPU street ground at every point of the tile and its margin', () => {
    let worst = 0;
    let points = 0;
    for (let b = -0.9; b <= 1.9; b += 0.037) {
      for (let a = -0.9; a <= 1.9; a += 0.041) {
        u.value = a;
        v.value = b;
        const gpu = evaluate(graph, read) as number;
        worst = Math.max(worst, Math.abs(gpu - streetGroundAt(street, a, b)));
        points++;
      }
    }
    expect(points).toBeGreaterThan(4000);
    expect(worst).toBeLessThan(1e-4);
  });

  test("reads the north-west/south-east facets, the margin's corners, and holds the last corner past it", () => {
    const at = (a: number, b: number) => {
      u.value = a;
      v.value = b;
      return evaluate(graph, read) as number;
    };
    const m = STREET_GROUND_MARGIN;
    const s = street.size;
    const corner = (i: number, j: number) => street.values[(j + m) * s + i + m];
    // A corner of the tile is its own value; one past the edge, the margin's.
    expect(at(0, 0)).toBeCloseTo(corner(0, 0), 4);
    expect(at(-1 / 4, 0)).toBeCloseTo(corner(-1, 0), 4);
    expect(at(-2 / 4, -2 / 4)).toBeCloseTo(corner(-2, -2), 4);
    // Past the margin: held at the last corner.
    expect(at(-5, 1 / 4)).toBeCloseTo(corner(-2, 1), 4);
    // A point below the square's NW–SE diagonal reads the south-west triangle (tl, bl, br).
    const fx = 0.2;
    const fy = 0.7;
    const expected =
      corner(1, 1) + (corner(1, 2) - corner(1, 1)) * fy + (corner(2, 2) - corner(1, 2)) * fx;
    expect(at((1 + fx) / 4, (1 + fy) / 4)).toBeCloseTo(expected, 4);
    const other =
      corner(1, 1) + (corner(2, 1) - corner(1, 1)) * fy + (corner(2, 2) - corner(2, 1)) * fx;
    expect(Math.abs(at((1 + fy) / 4, (1 + fx) / 4) - other)).toBeLessThan(1e-4);
    expect(Math.abs(expected - other)).toBeGreaterThan(0.1);
  });

  test('the CPU instance is plain arithmetic', () => {
    expect(CPU_GROUND_MATH.clamp(5, 0, 3)).toBe(3);
    expect(CPU_GROUND_MATH.select(CPU_GROUND_MATH.atLeast(1, 1), 2, 3)).toBe(2);
  });
});
