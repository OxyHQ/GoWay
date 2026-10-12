/**
 * The imagery build's own pieces (`docs/MAP_SATELLITE.md`): the cell grid,
 * the catalogue's rules, and the packer — read back with the Worker's reader.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IMAGERY_TIERS } from '../../lib/map/imagery';
import { countCoverageTiles } from '../../worker/coverageTree.js';
import { PMTiles, TILE_TYPE } from '../../worker/pmtiles.js';
import { mergeEntries, mergeManifest } from '../build-satellite-manifest';
import { withWaterMask } from '../build-satellite-set';
import { checkSet, IMAGERY_SETS, type ImagerySetDefinition } from '../imagery/catalogue';
import {
  cellLonLat,
  cellMercator,
  cellsInBox,
  cellsTree,
  cellTileRange,
  MERCATOR_HALF,
  mercatorResolution,
  parseCellKey,
} from '../imagery/cells';
import { packTileDirectory } from '../imagery/pmtilesStream';

describe('cells', () => {
  test('the z13 cells over central Barcelona', () => {
    const cells = cellsInBox([2.11, 41.315, 2.28, 41.44], 13);
    expect(cells[0]).toEqual({ z: 13, x: 4144, y: 3058 });
    expect(cells.at(-1)).toEqual({ z: 13, x: 4147, y: 3061 });
  });

  test('a cell holds 4^k tiles of the zoom k below it, and its boxes agree', () => {
    expect(cellTileRange({ z: 13, x: 4144, y: 3058 }, 18)).toEqual([132608, 97856, 132639, 97887]);
    const [w, s, e, n] = cellLonLat({ z: 0, x: 0, y: 0 });
    expect([w, e]).toEqual([-180, 180]);
    expect(n).toBeCloseTo(85.0511, 3);
    expect(s).toBeCloseTo(-85.0511, 3);
    expect(cellMercator({ z: 1, x: 1, y: 0 })).toEqual([0, 0, MERCATOR_HALF, MERCATOR_HALF]);
    // z18 at 512 px is 0.30 m at the equator, 0.22 m at Barcelona.
    expect(mercatorResolution(18, 512)).toBeCloseTo(0.2986, 4);
  });

  test('a tree of cells counts exactly them', () => {
    const cells = ['13/4144/3058', '13/4145/3058', '13/4147/3061'].map(parseCellKey);
    expect(countCoverageTiles(cellsTree(cells, 13), 13)).toBe(3);
    expect(() => parseCellKey('13/9000/1')).toThrow();
  });
});

describe('the catalogue', () => {
  test('every set is buildable and named after sources the registry allows', () => {
    for (const set of IMAGERY_SETS) expect(() => checkSet(set)).not.toThrow();
  });

  test('a source the registry does not list is refused', () => {
    const bad = {
      ...IMAGERY_SETS[0],
      sources: ['google-satellite'],
    } as unknown as ImagerySetDefinition;
    expect(() => checkSet(bad)).toThrow(/imagerySources/);
  });

  test('every set fits its tiers and the upload limit’s six zooms a cell', () => {
    for (const set of IMAGERY_SETS) {
      expect(set.maxZoom - set.cellZoom).toBeLessThanOrEqual(7);
      for (const tier of set.tiers) {
        expect(set.maxZoom).toBeGreaterThanOrEqual(IMAGERY_TIERS[tier].minZoom);
      }
    }
  });

  test('a set rebuilt with another cell zoom is refused by the manifest', () => {
    const entry = (stamp: string, cellZoom: number, cell: string) => ({
      id: 'icgc-ortofoto-2025',
      stamp,
      name: 'x',
      tiers: ['detail'],
      minZoom: 13,
      maxZoom: 18,
      cellZoom,
      sources: ['icgc-ortofoto'],
      vintage: '2025',
      format: 'webp' as const,
      bbox: [2, 41, 3, 42] as [number, number, number, number],
      cellKeys: [cell],
      tiles: 1,
      bytes: 1,
      builtAt: '2026-10-13T00:00:00.000Z',
    });
    const { manifest } = mergeManifest(
      null,
      mergeEntries([entry('20261012-a', 13, '13/4144/3058')]),
      'now',
    );
    expect(() =>
      mergeManifest(manifest, mergeEntries([entry('20261013-b', 12, '12/2072/1529')]), 'later'),
    ).toThrow(/cell zoom/);
  });
});

describe('the water mask', () => {
  test('a dataset mask from green and NIR replaces the bands’ nodata', () => {
    const vrt = `<VRTDataset rasterXSize="2" rasterYSize="2">
  <VRTRasterBand dataType="Byte" band="1">
    <NoDataValue>0</NoDataValue>
  </VRTRasterBand>
</VRTDataset>`;
    const out = withWaterMask(vrt, '/x/raw.vrt');
    expect(out).not.toContain('NoDataValue');
    expect(out).toContain('<MaskBand>');
    expect(out).toContain('<PixelFunctionType>expression</PixelFunctionType>');
    // NDWI > 0 and NIR < 800 is water (masked); B1 green, B2 NIR, from the raw VRT.
    expect(out).toContain('(B1 - B2) / (B1 + B2)) &gt; 0');
    expect(out).toContain('(B2 &lt; 800)');
    expect(out.match(/<SourceBand>(\d)<\/SourceBand>/g)).toEqual([
      '<SourceBand>2</SourceBand>',
      '<SourceBand>4</SourceBand>',
    ]);
    expect(out.trim().endsWith('</VRTDataset>')).toBe(true);
    expect(() => withWaterMask('<nope/>', 'x')).toThrow();
  });
});

describe('the packer', () => {
  test('a tile directory becomes one clustered WebP archive the Worker reads back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goway-pack-'));
    const tiles: [number, number, number, string][] = [
      [13, 4144, 3058, 'parent'],
      [14, 8288, 6116, 'a'],
      [14, 8289, 6116, 'sea'],
      [14, 8288, 6117, 'sea'],
      [14, 8289, 6117, 'b'],
    ];
    for (const [z, x, y, body] of tiles) {
      await mkdir(join(dir, 'tiles', String(z), String(x)), { recursive: true });
      await writeFile(join(dir, 'tiles', String(z), String(x), `${y}.webp`), body);
    }
    await writeFile(join(dir, 'tiles', 'openlayers.html'), 'not a tile');
    const out = join(dir, 'cell.pmtiles');
    const packed = await packTileDirectory({
      dir: join(dir, 'tiles'),
      ext: 'webp',
      out,
      bounds: [2.1, 41.4, 2.15, 41.44],
      metadata: { 'goway:set': 'test' },
    });
    expect(packed).toMatchObject({ tiles: 5, contents: 4, minZoom: 13, maxZoom: 14 });
    expect(packed?.perZoom).toEqual({ 13: 1, 14: 4 });

    const handle = await open(out, 'r');
    try {
      const archive = new PMTiles({
        async read(offset: number, length: number) {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return new Uint8Array(buffer.subarray(0, bytesRead));
        },
      });
      const header = await archive.header();
      expect(header.tileType).toBe(TILE_TYPE.WEBP);
      expect(header.clustered).toBe(true);
      for (const [z, x, y, body] of tiles) {
        const tile = await archive.getTile(z, x, y);
        expect(new TextDecoder().decode(tile?.bytes)).toBe(body);
      }
      expect(await archive.getTile(14, 8290, 6116)).toBeNull();
      expect((await archive.metadata())['goway:set']).toBe('test');
    } finally {
      await handle.close();
    }
  });
});
