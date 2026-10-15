/**
 * The terrain archive's arithmetic (`docs/MAP_TERRAIN_GLOBE.md` → "The
 * archive"): Terrarium round trips at each zoom's step, the pyramid's
 * registration, the membrane, the contamination gate's verdicts (a kept
 * building fails, a hill under houses does not), the feather at a set's
 * edge on land (and none at the coast), and the readers of GDAL's and GSI's
 * rasters.
 */
import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';

import { tilesOf } from '../build-terrain-set';
import { blendIntoFallback, distanceToSeeds, WORLDCOVER_WATER } from '../terrain/blend';
import { labelStands, WORLDCOVER_TREES } from '../terrain/canopy';
import { TERRAIN_MAX_ZOOM, TERRAIN_SETS } from '../terrain/catalogue';
import { gateWindow, labelWindow, ringBand } from '../terrain/gate';
import { downsample, type PixelWindow, windowOfTile } from '../terrain/grid';
import {
  footprintGround,
  membraneFill,
  type PixelRing,
  rasterizePolygons,
} from '../terrain/ground';
import { decodeGsiHeights, decodePngRgb } from '../terrain/gsi';
import { decodeTerrarium, encodeTerrarium, quantise, terrainStepM } from '../terrain/terrarium';
import { PLAUSIBLE_HEIGHT_M, readTiff, withPlausibilityMask } from '../terrain/warp';
import { decodeWebp, encodeLosslessWebp } from '../terrain/webp';
import { TERRAIN_SOURCES } from '../../lib/map/terrainSources';

const square = (x0: number, y0: number, x1: number, y1: number): PixelRing[] => [
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ],
];

describe('Terrarium at each zoom', () => {
  test('the step is 1/8 m at z12, doubling per zoom coarser, never over 1 m, always exact in 1/256 m', () => {
    expect(terrainStepM(12)).toBe(1 / 8);
    expect(terrainStepM(11)).toBe(1 / 4);
    expect(terrainStepM(10)).toBe(1 / 2);
    expect(terrainStepM(9)).toBe(1);
    expect(terrainStepM(7)).toBe(1);
    expect(terrainStepM(3)).toBe(1);
    for (let z = 0; z <= TERRAIN_MAX_ZOOM; z++) expect((terrainStepM(z) * 256) % 1).toBe(0);
  });

  test('a height comes back as MapLibre decodes it, within half a step, across the range', () => {
    const heights = Float32Array.from([-10_994.3, -0.01, 0, 0.015, 31.4159, 8_848.86, 32_000]);
    for (const z of [7, 10, 12]) {
      const step = terrainStepM(z);
      const back = decodeTerrarium(encodeTerrarium(heights, step));
      for (let i = 0; i < heights.length; i++) {
        expect(Math.abs(back[i] - heights[i])).toBeLessThanOrEqual(step / 2 + 1e-6);
        expect(back[i]).toBeCloseTo(quantise(heights[i], step), 9);
      }
    }
  });

  test('a height outside Terrarium or a missing one is an error, never a clamp', () => {
    expect(() => encodeTerrarium(Float32Array.from([40_000]), 1 / 32)).toThrow();
    expect(() => encodeTerrarium(Float32Array.from([-40_000]), 1 / 32)).toThrow();
    expect(() => encodeTerrarium(Float32Array.from([Number.NaN]), 1 / 32)).toThrow();
  });

  test('lossless WebP keeps every byte', async () => {
    const size = 64;
    const heights = new Float32Array(size * size);
    for (let i = 0; i < heights.length; i++)
      heights[i] = 30 + Math.sin(i / 7) * 5 + (i % size) * 0.01;
    const rgba = encodeTerrarium(heights, 1 / 32);
    const back = await decodeWebp(await encodeLosslessWebp(rgba, size, size));
    expect(Buffer.compare(Buffer.from(back.data), Buffer.from(rgba))).toBe(0);
  });
});

describe('the pyramid', () => {
  test('a coarser pixel is the mean of the four under it, centred on them', () => {
    // A plane: the mean of four pixel centres is the plane at their centre,
    // so every level is the same plane sampled at its own pixel centres.
    const w = 16;
    const plane = (x: number, y: number) => 10 + 0.5 * x - 0.25 * y;
    const data = new Float32Array(w * w);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) data[y * w + x] = plane(x + 0.5, y + 0.5);
    const half = downsample(data, w, w, 2);
    for (let y = 0; y < w / 2; y++) {
      for (let x = 0; x < w / 2; x++) {
        expect(half.data[y * (w / 2) + x]).toBeCloseTo(plane(2 * x + 1, 2 * y + 1), 5);
      }
    }
  });

  test('a block with no data stays no data; one with some averages what it has', () => {
    const data = Float32Array.from([
      Number.NaN,
      Number.NaN,
      1,
      3,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      5,
    ]);
    const out = downsample(data, 4, 2, 2);
    expect(Number.isNaN(out.data[0])).toBe(true);
    expect(out.data[1]).toBe(3);
  });

  test('tiles cut from one grid meet edge to edge: the step across an edge is the step inside', () => {
    // A 2 × 2-tile block of a tilted plane, cut into its tiles and averaged a zoom up.
    const size = 1024;
    const data = new Float32Array(size * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) data[y * size + x] = 100 + 0.07 * x - 0.03 * y;
    const tiles = tilesOf(data, size, 12, 10, 20);
    expect(tiles.map((t) => [t.x, t.y])).toEqual([
      [10, 20],
      [11, 20],
      [10, 21],
      [11, 21],
    ]);
    const [a, b, c] = tiles.map((t) => t.heights);
    for (const row of [0, 100, 511]) {
      // East edge of (10, 20) to the west edge of (11, 20): one pixel's step, as inside.
      expect(b[row * 512] - a[row * 512 + 511]).toBeCloseTo(a[row * 512 + 1] - a[row * 512], 4);
      // South edge of (10, 20) to the north edge of (10, 21).
      expect(c[row] - a[511 * 512 + row]).toBeCloseTo(a[512 + row] - a[row], 4);
    }
    // The zoom above, from the same grid, is the same plane at its own pixel centres.
    const up = downsample(data, size, size, 2);
    const top = tilesOf(up.data, up.width, 11, 5, 10)[0].heights;
    expect(top[0]).toBeCloseTo(100 + 0.07 * 0.5 - 0.03 * 0.5, 4);
    expect(top[511 * 512 + 511]).toBeCloseTo(100 + 0.07 * 1022.5 - 0.03 * 1022.5, 3);
  });

  test("a block's window covers its tile's pixels at the analysis zoom, plus the margin", () => {
    const w = windowOfTile({ z: 10, x: 523, y: 381 }, 14, 100);
    expect(w).toEqual({
      zoom: 14,
      x0: 523 * 8192 - 100,
      y0: 381 * 8192 - 100,
      width: 8392,
      height: 8392,
    });
  });
});

describe('the membrane', () => {
  test('a hole in a plane is filled with the plane', () => {
    const w = 40;
    const grid = new Float32Array(w * w);
    const hole = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        grid[y * w + x] = 5 + 0.3 * x + 0.1 * y;
        if (x >= 10 && x < 30 && y >= 12 && y < 28) {
          hole[y * w + x] = 1;
          grid[y * w + x] = 999; // a building kept as ground
        }
      }
    }
    const { data } = membraneFill({ width: w, height: w, data: grid }, hole);
    for (let y = 12; y < 28; y++) {
      for (let x = 10; x < 30; x++)
        expect(Math.abs(data[y * w + x] - (5 + 0.3 * x + 0.1 * y))).toBeLessThan(0.02);
    }
  });

  test('never above the highest edge nor below the lowest (maximum principle)', () => {
    const w = 30;
    const grid = new Float32Array(w * w);
    const hole = new Uint8Array(w * w);
    for (let i = 0; i < grid.length; i++) grid[i] = (i * 7919) % 13; // rough ground
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) hole[y * w + x] = 1;
    const { data } = membraneFill({ width: w, height: w, data: grid }, hole);
    for (let i = 0; i < data.length; i++) {
      if (!hole[i]) continue;
      expect(data[i]).toBeGreaterThanOrEqual(-1e-3);
      expect(data[i]).toBeLessThanOrEqual(12 + 1e-3);
    }
  });
});

describe('footprints', () => {
  test('a pixel is in a polygon when its centre is; a courtyard is not; the first polygon keeps a shared pixel', () => {
    const labels = rasterizePolygons(10, 10, [
      [...square(1, 1, 9, 9), ...square(3, 3, 7, 7)],
      square(0, 0, 2, 2),
    ]);
    expect(labels[1 * 10 + 1]).toBe(1);
    expect(labels[5 * 10 + 5]).toBe(0); // the courtyard
    expect(labels[8 * 10 + 8]).toBe(1);
    expect(labels[9 * 10 + 9]).toBe(0); // centre 9.5 is outside
    expect(labels[0]).toBe(2);
  });
});

/** A window-sized test ground: `height(x, y)` on a w × w grid at z14. */
function testWindow(w: number): PixelWindow {
  return { zoom: 14, x0: 0, y0: 0, width: w, height: w };
}

describe('the contamination gate', () => {
  const w = 120;
  const band = ringBand(3.5, 5);

  test('a building kept as ground fails; the same footprint on clean ground passes', () => {
    const kept = new Float32Array(w * w);
    const clean = new Float32Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const ground = 30 + 0.03 * x * 3.5; // 3% to the east
        clean[y * w + x] = ground;
        kept[y * w + x] = ground + (x >= 50 && x < 70 && y >= 50 && y < 70 ? 25 : 0);
      }
    }
    const labels = labelWindow(testWindow(w), [square(50, 50, 70, 70)], null, 3.5);
    const failed = gateWindow(kept, testWindow(w), labels, band);
    const passed = gateWindow(clean, testWindow(w), labels, band);
    expect(failed.buildings.failed.length).toBe(1);
    expect(failed.buildings.judged[0].p90AboveM).toBeCloseTo(25, 0);
    expect(passed.buildings.failed.length).toBe(0);
    expect(Math.abs(passed.buildings.judged[0].p90AboveM)).toBeLessThan(0.05);
  });

  test('houses on a hill: the streets climb it too, so no house fails', () => {
    // A round hill 20 m high and 200 m across, a grid of 8 × 8 px houses with 4 px streets.
    const ground = new Float32Array(w * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - w / 2, y - w / 2) * 3.5;
        ground[y * w + x] = 20 * Math.exp(-((r / 70) ** 2));
      }
    }
    const houses: PixelRing[][] = [];
    for (let y = 8; y + 8 < w - 8; y += 12)
      for (let x = 8; x + 8 < w - 8; x += 12) houses.push(square(x, y, x + 8, y + 8));
    const result = gateWindow(
      ground,
      testWindow(w),
      labelWindow(testWindow(w), houses, null, 3.5),
      band,
    );
    expect(result.buildings.judged.length).toBeGreaterThan(40);
    expect(result.buildings.failed.length).toBe(0);
  });

  test('a stand of trees a surface model kept fails; a forest too wide to judge is not judged', () => {
    const classes = new Uint8Array(w * w);
    const ground = new Float32Array(w * w).fill(12);
    for (let y = 40; y < 60; y++) {
      for (let x = 40; x < 60; x++) {
        classes[y * w + x] = WORLDCOVER_TREES;
        ground[y * w + x] = 12 + 15;
      }
    }
    const labels = labelWindow(testWindow(w), [], classes, 3.5);
    expect(labels.stands).toBe(1);
    expect(gateWindow(ground, testWindow(w), labels, band).stands.failed.length).toBe(1);
    const forest = new Uint8Array(w * w).fill(WORLDCOVER_TREES);
    expect(labelStands(forest, w, w, new Int32Array(w * w), 1, 43)).toBe(0);
  });

  test('a footprint walled in by others, with no open ground of its own, is not judged', () => {
    const ground = new Float32Array(w * w).fill(5);
    const stats = footprintGround(ground, w, w, new Int32Array(w * w).fill(1), 1, band);
    expect(stats).toEqual([]);
  });
});

describe('the seam', () => {
  test('inside the feather the set fades into the fallback; past it the set is untouched', () => {
    const w = 200;
    const set = new Float32Array(w * w);
    const fallback = new Float32Array(w * w).fill(100);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) set[y * w + x] = x < 50 ? Number.NaN : 99;
    const out = blendIntoFallback(set, fallback, w, w, 40, null);
    const row = 100 * w;
    expect(out[row + 10]).toBe(100); // the set has no ground: the fallback's
    expect(out[row + 50]).toBeCloseTo(100, 1); // its edge: still the fallback
    expect(out[row + 70]).toBeGreaterThan(99);
    expect(out[row + 70]).toBeLessThan(100);
    expect(out[row + 120]).toBe(99); // past the feather: the set exactly
    // Monotone across the seam: no step, no overshoot.
    for (let x = 51; x < w; x++) expect(out[row + x]).toBeLessThanOrEqual(out[row + x - 1] + 1e-6);
  });

  test('a set ending at the sea keeps its own shore', () => {
    const w = 100;
    const set = new Float32Array(w * w);
    const classes = new Uint8Array(w * w).fill(50);
    for (let i = 0; i < set.length; i++) {
      const x = i % w;
      set[i] = x < 30 ? Number.NaN : 3;
      if (x < 30) classes[i] = WORLDCOVER_WATER;
    }
    const out = blendIntoFallback(set, new Float32Array(w * w).fill(-1), w, w, 40, classes);
    expect(out[50 * w + 30]).toBe(3);
    expect(out[50 * w + 10]).toBe(-1);
  });

  test('chamfer distance is within 8% of Euclidean', () => {
    const w = 101;
    const seeds = new Uint8Array(w * w);
    seeds[50 * w + 50] = 1;
    const d = distanceToSeeds(seeds, w, w, 1000);
    for (const [x, y] of [
      [90, 50],
      [80, 80],
      [60, 95],
    ]) {
      const e = Math.hypot(x - 50, y - 50);
      expect(Math.abs(d[y * w + x] - e) / e).toBeLessThan(0.08);
    }
  });
});

describe('readers', () => {
  test("GSI's 24-bit centimetres, negative heights and no data", () => {
    const rgb = Uint8Array.from([0, 0x0c, 0x80, 0xff, 0xff, 0x9c, 128, 0, 0]);
    const h = decodeGsiHeights(rgb);
    expect(h[0]).toBeCloseTo(32, 5);
    expect(h[1]).toBeCloseTo(-1, 5);
    expect(Number.isNaN(h[2])).toBe(true);
  });

  test('an 8-bit RGB PNG with every filter type decodes', () => {
    const width = 3;
    const rows = [
      [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
      [1, 1, 2, 3, 1, 1, 1, 1, 1, 1],
      [2, 5, 5, 5, 5, 5, 5, 5, 5, 5],
      [3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [4, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ];
    const raw = Uint8Array.from(rows.flat());
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(rows.length, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const chunk = (type: string, data: Uint8Array) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4);
      return Buffer.concat([head, Buffer.from(data), Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array()),
    ]);
    const out = decodePngRgb(new Uint8Array(png));
    expect([...out.rgb.subarray(0, 9)]).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    // Sub: each byte adds the one a pixel to its left.
    expect([...out.rgb.subarray(9, 18)]).toEqual([1, 2, 3, 2, 3, 4, 3, 4, 5]);
    // Up: each adds the row above.
    expect([...out.rgb.subarray(18, 27)]).toEqual([6, 7, 8, 7, 8, 9, 8, 9, 10]);
    expect(out.rgb.length).toBe(width * rows.length * 3);
  });

  test('a source pixel no terrain has is masked before the warp, its own no-data value with it', () => {
    const vrt = `<VRTDataset rasterXSize="2" rasterYSize="2">
  <VRTRasterBand dataType="Float32" band="1">
    <NoDataValue>-999999</NoDataValue>
    <ComplexSource><SourceFilename>a.tif</SourceFilename></ComplexSource>
  </VRTRasterBand>
</VRTDataset>`;
    const masked = withPlausibilityMask(vrt, '/x/mosaic.vrt');
    expect(masked).not.toContain('<NoDataValue>');
    expect(masked).toContain('<MaskBand>');
    expect(masked).toContain('<SourceFilename relativeToVRT="0">/x/mosaic.vrt</SourceFilename>');
    expect(masked).toContain(`B1 &gt;= ${PLAUSIBLE_HEIGHT_M[0]}`);
    expect(masked).toContain(`B1 &lt;= ${PLAUSIBLE_HEIGHT_M[1]}`);
    expect(masked.trim().endsWith('</VRTDataset>')).toBe(true);
    expect(() => withPlausibilityMask('<nope/>', 'x')).toThrow();
  });

  test("GDAL's uncompressed float TIFF: strips concatenated, anything else refused", () => {
    // A 2 × 2 float32 TIFF, one strip, little-endian.
    const pixels = Float32Array.from([1.5, -2, 3.25, Number.NaN]);
    const entries: [number, number, number, number][] = [
      [256, 3, 1, 2],
      [257, 3, 1, 2],
      [258, 3, 1, 32],
      [259, 3, 1, 1],
      [273, 4, 1, 8 + 2 + 8 * 12 + 4],
      [277, 3, 1, 1],
      [279, 4, 1, 16],
      [339, 3, 1, 3],
    ];
    const ifdSize = 2 + entries.length * 12 + 4;
    const buffer = new ArrayBuffer(8 + ifdSize + 16);
    const view = new DataView(buffer);
    view.setUint8(0, 0x49);
    view.setUint8(1, 0x49);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, entries.length, true);
    entries.forEach(([tag, type, count, value], k) => {
      const at = 10 + k * 12;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (type === 3) view.setUint16(at + 8, value, true);
      else view.setUint32(at + 8, value, true);
    });
    new Uint8Array(buffer).set(new Uint8Array(pixels.buffer), 8 + ifdSize);
    const read = readTiff(new Uint8Array(buffer), 'float32');
    expect([...read.subarray(0, 3)]).toEqual([1.5, -2, 3.25]);
    expect(Number.isNaN(read[3])).toBe(true);
    expect(() => readTiff(new Uint8Array(buffer), 'uint8')).toThrow();
  });
});

describe('the catalogue', () => {
  test('every set names known sources, a compound CRS and a positive source pixel; none corrects', () => {
    const ids = new Set<string>();
    for (const set of TERRAIN_SETS) {
      expect(ids.has(set.id)).toBe(false);
      ids.add(set.id);
      for (const source of set.sources) expect(Object.hasOwn(TERRAIN_SOURCES, source)).toBe(true);
      expect(set.crs).toMatch(/^EPSG:\d+\+\d+$/);
      expect(set.pixelM).toBeGreaterThan(0);
      expect(set.extent[0]).toBeLessThan(set.extent[2]);
      expect(set.extent[1]).toBeLessThan(set.extent[3]);
      // The correction is for sources with no clean alternative, measured first.
      expect(set.correct).toBe(false);
    }
  });
});
