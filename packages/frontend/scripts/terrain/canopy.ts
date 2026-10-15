/**
 * The canopy signal of the contamination gate: tree cover from ESA
 * WorldCover 2021 (10 m, CC BY 4.0, AWS Open Data), as STANDS — connected
 * groups of tree pixels — each judged like a footprint: a surface model keeps
 * the canopy, a bare-earth model does not.
 *
 * Only stands small enough to have open ground on every side within reach are
 * judged (`MAX_STAND_M`): a park's trees, a row along an avenue. A forest
 * kilometres across has no ground around it to compare with — and is not
 * where the map's buildings stand.
 */
import { type PixelWindow, TERRAIN_TILE_SIZE } from './grid';

/** WorldCover's class for tree cover. */
export const WORLDCOVER_TREES = 10;

/** The widest stand judged (m along either axis). */
export const MAX_STAND_M = 150;

const WORLDCOVER_MAP =
  'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_';

/** The window's lon/lat bounds. */
function windowLonLat(window: PixelWindow): [number, number, number, number] {
  const n = TERRAIN_TILE_SIZE * 2 ** window.zoom;
  const lon = (px: number) => (px / n) * 360 - 180;
  const lat = (py: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI;
  return [
    lon(window.x0),
    lat(window.y0 + window.height),
    lon(window.x0 + window.width),
    lat(window.y0),
  ];
}

/** WorldCover's 3° map tiles under a window (names; a tile over open sea does not exist). */
export function worldCoverTiles(window: PixelWindow): string[] {
  const [w, s, e, n] = windowLonLat(window);
  const out: string[] = [];
  for (let lat = Math.floor(s / 3) * 3; lat < n; lat += 3) {
    for (let lon = Math.floor(w / 3) * 3; lon < e; lon += 3) {
      const ns = `${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}`;
      const ew = `${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}`;
      out.push(`${WORLDCOVER_MAP}${ns}${ew}_Map.tif`);
    }
  }
  return out;
}

/**
 * Tree stands: connected (4-neighbour) tree pixels not inside a footprint
 * (`taken`), labelled `first`, `first + 1`, … into `labels`; a stand wider or
 * taller than `maxSpanPx` is left unlabelled. Returns how many were labelled.
 */
export function labelStands(
  classes: Uint8Array,
  width: number,
  height: number,
  labels: Int32Array,
  first: number,
  maxSpanPx: number,
): number {
  const visited = new Uint8Array(classes.length);
  const stack: number[] = [];
  const members: number[] = [];
  let next = first;
  for (let start = 0; start < classes.length; start++) {
    if (visited[start] || classes[start] !== WORLDCOVER_TREES || labels[start]) continue;
    members.length = 0;
    stack.push(start);
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    while (stack.length) {
      const i = stack.pop() as number;
      members.push(i);
      const x = i % width;
      const y = (i / width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const push = (j: number) => {
        if (!visited[j] && classes[j] === WORLDCOVER_TREES && !labels[j]) {
          visited[j] = 1;
          stack.push(j);
        }
      };
      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (y > 0) push(i - width);
      if (y < height - 1) push(i + width);
    }
    if (maxX - minX + 1 > maxSpanPx || maxY - minY + 1 > maxSpanPx) continue;
    for (const i of members) labels[i] = next;
    next++;
  }
  return next - first;
}
