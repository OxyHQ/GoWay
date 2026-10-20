import {
  mercatorXFromLng,
  mercatorYFromLat,
  tileSizeMetres,
  type TileId,
} from '../city3d/tileMath';
import { STREET_LIFT_M, type PackedSurfaces, type PackedMarkings } from './meshBuffers';
import { groundStreetMesh } from './groundMesh';
import { groundMarkings } from './groundMarkings';

/** CPU view of the very triangles drawn by the street material, for contact. */
export class StreetSurface {
  private tiles = new Map<
    string,
    {
      tile: TileId;
      sizeM: number;
      mesh: PackedSurfaces;
      cells: Map<string, number[]>;
      ground: ((x: number, y: number) => number) | null;
      source: PackedSurfaces;
    }
  >();
  private active = new Set<string>();
  version = 0;

  set(key: string, tile: TileId, mesh: PackedSurfaces): void {
    const cells = this.index(mesh);
    this.tiles.set(key, {
      tile,
      mesh,
      cells,
      sizeM: tileSizeMetres(tile),
      ground: null,
      source: { ...mesh },
    });
    this.version++;
  }

  private index(mesh: PackedSurfaces) {
    const cells = new Map<string, number[]>();
    const p = mesh.positions;
    for (let t = 0; t < mesh.simpleCount; t += 3) {
      const ids = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
      const xs = ids.map((id) => p[id * 3]);
      const ys = ids.map((id) => p[id * 3 + 1]);
      for (let x = Math.floor(Math.min(...xs) / 20); x <= Math.floor(Math.max(...xs) / 20); x++) {
        for (let y = Math.floor(Math.min(...ys) / 20); y <= Math.floor(Math.max(...ys) / 20); y++) {
          const cell = `${x}/${y}`;
          const list = cells.get(cell);
          if (list) list.push(t);
          else cells.set(cell, [t]);
        }
      }
    }
    return cells;
  }

  setGround(
    key: string,
    ground: ((x: number, y: number) => number) | null,
    refinement?: { errorM: number; minEdgeM: number },
  ): PackedSurfaces | null {
    const tile = this.tiles.get(key);
    if (!tile || tile.ground === ground) return null;
    tile.ground = ground;
    const mesh = groundStreetMesh(tile.source, (x, y) => this.terrainAt(key, x, y), refinement);
    Object.assign(tile.mesh, mesh);
    tile.cells = this.index(tile.mesh);
    this.version++;
    return tile.mesh;
  }

  activate(keys: string[]): void {
    if (keys.length === this.active.size && keys.every((key) => this.active.has(key))) return;
    this.active = new Set(keys);
    this.version++;
  }

  markings(key: string, source: PackedMarkings): PackedMarkings | null {
    const entry = this.tiles.get(key);
    if (!entry) return null;
    return groundMarkings(source, entry.mesh, (minX, minY, maxX, maxY) => {
      const found = new Set<number>();
      for (let x = Math.floor(minX / 20); x <= Math.floor(maxX / 20); x++)
        for (let y = Math.floor(minY / 20); y <= Math.floor(maxY / 20); y++)
          for (const t of entry.cells.get(`${x}/${y}`) ?? []) found.add(t);
      return found;
    });
  }

  delete(key: string): void {
    this.tiles.delete(key);
    if (this.active.delete(key)) this.version++;
  }

  /** Metres at the drawn triangle, including the street's physical terrain clearance. */
  sample(lng: number, lat: number, bridge?: boolean): number | null {
    const fx = mercatorXFromLng(lng) * 2 ** 15;
    const fy = mercatorYFromLat(lat) * 2 ** 15;
    let height: number | null = null;
    // Ownership is by the primitive's anchor, so a junction may extend into a neighbour.
    for (let tx = Math.floor(fx) - 1; tx <= Math.floor(fx) + 1; tx++) {
      for (let ty = Math.floor(fy) - 1; ty <= Math.floor(fy) + 1; ty++) {
        const key = `15/${tx}/${ty}`;
        if (!this.active.has(key)) continue;
        const entry = this.tiles.get(key);
        if (!entry) continue;
        const z = this.at(key, (fx - tx) * entry.sizeM, (ty - fy) * entry.sizeM, bridge);
        if (z !== null) height = height === null ? z : Math.max(height, z);
      }
    }
    return height;
  }

  at(key: string, x: number, y: number, bridge?: boolean): number | null {
    const entry = this.tiles.get(key);
    if (!entry) return null;
    let height: number | null = null;
    const { mesh } = entry;
    const p = mesh.positions;
    const elevation = (id: number) => p[id * 3 + 2] + STREET_LIFT_M;
    for (const t of entry.cells.get(`${Math.floor(x / 20)}/${Math.floor(y / 20)}`) ?? []) {
      const a = mesh.indices[t],
        b = mesh.indices[t + 1],
        c = mesh.indices[t + 2];
      if (bridge !== undefined && Boolean(mesh.attrs[a * 4 + 3]) !== bridge) continue;
      const ax = p[a * 3],
        ay = p[a * 3 + 1];
      const bx = p[b * 3] - ax,
        by = p[b * 3 + 1] - ay;
      const cx = p[c * 3] - ax,
        cy = p[c * 3 + 1] - ay;
      const det = bx * cy - by * cx;
      if (Math.abs(det) < 1e-9) continue;
      const v = ((x - ax) * cy - (y - ay) * cx) / det;
      const w = (bx * (y - ay) - by * (x - ax)) / det;
      if (v < -1e-6 || w < -1e-6 || v + w > 1.000001) continue;
      const z = (1 - v - w) * elevation(a) + v * elevation(b) + w * elevation(c);
      height = height === null ? z : Math.max(height, z);
    }
    return height;
  }

  terrainAt(key: string, x: number, y: number): number {
    const value = this.tiles.get(key)?.ground?.(x, y) ?? 0;
    return Number.isFinite(value) ? value : 0;
  }
}
