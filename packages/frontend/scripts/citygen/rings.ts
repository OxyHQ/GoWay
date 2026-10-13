/**
 * Rings of OpenStreetMap areas, shared by every compiler that reads them
 * (buildings, the LOD2 conflation, park areas for the road compiler).
 *
 * A ring is an open interleaved `[x0, y0, x1, y1, …]` (no closing duplicate);
 * ways are joined into rings by the node refs they share.
 */

/** Join way segments into closed rings by matching endpoints. Unclosable pieces are dropped. */
export function assembleRings(segments: number[][]): number[][] {
  const rings: number[][] = [];
  const remaining = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  while (remaining.length > 0) {
    const ring = remaining.pop() as number[];
    let progress = true;
    while (ring[0] !== ring[ring.length - 1] && progress) {
      progress = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        if (candidate[0] === end) {
          ring.push(...candidate.slice(1));
        } else if (candidate[candidate.length - 1] === end) {
          ring.push(...candidate.slice(0, -1).reverse());
        } else {
          continue;
        }
        remaining.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

/** Point in an open interleaved ring (even–odd). */
export function insideRing(ring: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
