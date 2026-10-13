import { expect, test } from 'bun:test';
import { buildingSources } from '../engine/city3d/buildingSources';
import { buildingFromProperties } from '../engine/city3d/osmTiles';
import type { Point2 } from '../engine/city3d/mesher';
import type { Lod2Surface } from '../engine/city3d/lod2Tiles';

const box = (x: number, width: number): Point2[][] => [
  [
    [x, 0],
    [x + width, 0],
    [x + width, 20],
    [x, 20],
    [x, 0],
  ],
];
const roof = (sourceId: string, x: number, width: number): Lod2Surface => ({
  rings: box(x, width),
  source: 'es-catastro',
  sourceId,
  top: 20,
  plane: { h: 20, dx: 0, dy: 0, x0: x, y0: 0 },
});

test('roof-only models cannot fill recorded undercrofts; neighbouring buildings keep their source', () => {
  const props = {
    render_height: 20,
    render_min_height: 0,
    height_source: 'cadastre',
    drawn_by: 'es-catastro',
    levels: 10,
    official_levels: 6,
    part: true,
  };
  const support = buildingFromProperties(1, box(0, 10), props);
  const cantilever = buildingFromProperties(2, box(10, 20), {
    ...props,
    render_min_height: 11,
    min_level: 3,
  });
  const neighbour = buildingFromProperties(3, box(30, 20), props);
  const selected = buildingSources(
    [support, cantilever, neighbour],
    [roof('A', 0, 30), roof('B', 30, 20)],
  );
  expect(selected.buildings.map((b) => b.id)).toEqual([1, 2]);
  expect(selected.buildings[1]).toMatchObject({ base: 11, top: 36.6, levels: 10 });
  expect(selected.surfaces.map((s) => s.sourceId)).toEqual(['B']);
});

test('ordinary ground-standing parts retain the official model and its measured height', () => {
  const b = buildingFromProperties(1, box(0, 30), {
    render_height: 20,
    render_min_height: 0,
    drawn_by: 'es-catastro',
    part: true,
  });
  const model = roof('A', 0, 30);
  const selected = buildingSources([b], [model]);
  expect(selected.buildings).toHaveLength(0);
  expect(selected.surfaces).toEqual([model]);
});
