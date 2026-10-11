/**
 * Where the camera is and where each screen corner looks, in ENU metres round
 * the map centre — recovered from the projection matrix the host hands over.
 *
 * The sky and the ground passes (`sky.ts`) need, per pixel, the direction of
 * the view ray: above the horizon it picks the sky colour, below it finds the
 * point of the map under the pixel (for haze and shadow). MapLibre hands a
 * custom layer only a matrix, never a camera; so the camera is read back out
 * of it, in float64, here.
 *
 *  - The camera centre is the one point every clip-space ray passes through:
 *    for any perspective `P = Proj · View`, `P · C = (0, 0, c, 0)`, so `C` is
 *    `P⁻¹ · (0, 0, 1, 0)` dehomogenised.
 *  - A corner's ray is that corner on the FAR plane minus the camera. Points
 *    on one plane are an affine function of the screen position, so the four
 *    corners, interpolated linearly across the screen by the GPU, give every
 *    pixel's exact ray — no matrix inverse per pixel, nothing in float32
 *    that needs float64.
 *
 * Pure, tested by `__tests__/city3dViewRays.test.ts`.
 */

/** Column-major 4×4 inverse (float64), or `null` when singular. */
export function invertMat4(m: ArrayLike<number>): number[] | null {
  const a00 = m[0];
  const a01 = m[1];
  const a02 = m[2];
  const a03 = m[3];
  const a10 = m[4];
  const a11 = m[5];
  const a12 = m[6];
  const a13 = m[7];
  const a20 = m[8];
  const a21 = m[9];
  const a22 = m[10];
  const a23 = m[11];
  const a30 = m[12];
  const a31 = m[13];
  const a32 = m[14];
  const a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det || !Number.isFinite(det)) return null;
  const d = 1 / det;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}

function transform(m: readonly number[], v: readonly [number, number, number, number]): number[] {
  return [0, 1, 2, 3].map(
    (row) => m[row] * v[0] + m[4 + row] * v[1] + m[8 + row] * v[2] + m[12 + row] * v[3],
  );
}

export type Vec3 = [number, number, number];

export interface ViewRays {
  /** The camera, ENU metres from the map centre (z is its height above the ground). */
  camera: Vec3;
  /**
   * Far-plane corner minus camera, ENU metres, in the order the full-screen
   * quad's vertices are: (−1,−1), (1,−1), (−1,1), (1,1) in clip space.
   */
  corners: [Vec3, Vec3, Vec3, Vec3];
}

/**
 * The camera and the four corner rays for `centredProjection` (centre-relative
 * mercator → clip, as `tileMath.centeredProjection` builds it), with
 * `metresPerMercator` the scale at the centre's latitude. `null` for a matrix
 * that is singular or not a perspective one.
 */
export function viewRays(
  centredProjection: ArrayLike<number>,
  metresPerMercator: number,
): ViewRays | null {
  const inverse = invertMat4(centredProjection);
  if (!inverse) return null;
  const c = transform(inverse, [0, 0, 1, 0]);
  if (Math.abs(c[3]) < 1e-30) return null;
  const toEnu = (x: number, y: number, z: number): Vec3 => [
    x * metresPerMercator,
    -y * metresPerMercator,
    z * metresPerMercator,
  ];
  const camera = toEnu(c[0] / c[3], c[1] / c[3], c[2] / c[3]);
  const corner = (x: number, y: number): Vec3 => {
    const p = transform(inverse, [x, y, 1, 1]);
    const q = toEnu(p[0] / p[3], p[1] / p[3], p[2] / p[3]);
    return [q[0] - camera[0], q[1] - camera[1], q[2] - camera[2]];
  };
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    corner(-1, -1),
    corner(1, -1),
    corner(-1, 1),
    corner(1, 1),
  ];
  if (!corners.every((v) => v.every(Number.isFinite)) || !camera.every(Number.isFinite)) {
    return null;
  }
  return { camera, corners };
}
