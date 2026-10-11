/**
 * Small geometry helpers shared by the Barcelona modern landmarks (Torre
 * Glòries, W Barcelona, Arc de Triomf). Build-time only, like `../kit.ts`.
 */
import { THREE, type V3 } from '../kit';

/** Positions + normals accumulated as triangles; turned into a geometry at the end. */
export class Tris {
  readonly positions: number[] = [];
  readonly normals: number[] = [];

  /** A quad a→b→c→d (counter-clockwise seen from outside), with per-vertex normals or a flat one. */
  quad(a: V3, b: V3, c: V3, d: V3, n?: [V3, V3, V3, V3]): void {
    this.tri(a, b, c, n ? [n[0], n[1], n[2]] : undefined);
    this.tri(a, c, d, n ? [n[0], n[2], n[3]] : undefined);
  }

  tri(a: V3, b: V3, c: V3, n?: [V3, V3, V3]): void {
    this.positions.push(...a, ...b, ...c);
    if (n) {
      this.normals.push(...n[0], ...n[1], ...n[2]);
    } else {
      const u = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const v = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const f = u.cross(v).normalize();
      for (let i = 0; i < 3; i++) this.normals.push(f.x, f.y, f.z);
    }
  }

  get empty(): boolean {
    return this.positions.length === 0;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    return g;
  }
}

/** A bag of `Tris` by material name. */
export class TrisByMaterial {
  readonly map = new Map<string, Tris>();

  get(material: string): Tris {
    let t = this.map.get(material);
    if (!t) {
      t = new Tris();
      this.map.set(material, t);
    }
    return t;
  }
}

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
