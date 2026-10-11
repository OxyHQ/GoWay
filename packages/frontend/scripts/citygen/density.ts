/**
 * Where an extract's data is: its nodes counted per tile at a coarse zoom.
 *
 * The region builder splits a region too large for one machine into parts of
 * even WEIGHT (`ownership.ts` → `splitByDensity`), and nodes are the weight:
 * both compilers' memory is dominated by what they keep per node and per way,
 * and both are where the nodes are. One pass over the node blobs, a counter
 * per tile — no ids are kept, so this costs a few megabytes whatever the
 * extract's size.
 */
import { closeSync, openSync } from 'node:fs';

import { readBlob, readBlock, scanBlobs } from './osmPbf';

/** Nodes per tile at `zoom`, keyed `x/y`. */
export function nodeDensity(pbf: string, zoom: number): Map<string, number> {
  const span = 2 ** zoom;
  const counts = new Map<number, number>();
  const fd = openSync(pbf, 'r');
  try {
    for (const blob of scanBlobs(pbf)) {
      if (blob.type !== 'OSMData') continue;
      readBlock(readBlob(fd, blob), {
        wantNodes: true,
        onNode(_id, lon, lat) {
          const x = Math.min(span - 1, Math.max(0, Math.floor(((lon + 180) / 360) * span)));
          const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
          const y = Math.min(
            span - 1,
            Math.max(
              0,
              Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * span),
            ),
          );
          const key = y * span + x;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        },
      });
    }
  } finally {
    closeSync(fd);
  }
  const out = new Map<string, number>();
  for (const [key, count] of counts) out.set(`${key % span}/${Math.floor(key / span)}`, count);
  return out;
}
