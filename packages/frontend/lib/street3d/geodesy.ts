/**
 * Placing a WGS 84 coordinate inside a Street 3D scene.
 *
 * A published scene is metric and local: `worldTransform.enuFromScene` is a
 * column-major 4×4 similarity taking a SCENE point to East-North-Up metres
 * around `worldTransform.anchor`. A place has a latitude and longitude. The
 * path between the two is the textbook one, done exactly rather than with a
 * flat-earth shortcut:
 *
 *     geodetic (φ, λ, h) ──▶ ECEF ──▶ ENU around the anchor ──▶ scene
 *                                                     (inverse of enuFromScene)
 *
 * Exact, because the shortcut (`metres = degrees × 111 km`) is wrong by a
 * metre or more across a street-sized scene at mid latitudes, and a label a
 * metre off sits on the wrong shop front.
 *
 * Pure numbers in, pure numbers out: no renderer, no three.js, so the maths is
 * unit-tested here and the engine only multiplies.
 */

/** WGS 84 semi-major axis, metres. */
export const WGS84_A = 6_378_137;
/** WGS 84 flattening. */
export const WGS84_F = 1 / 298.257223563;
/** First eccentricity squared. */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

export type Vec3 = [number, number, number];

/** A geodetic position: degrees, degrees, metres above the ellipsoid. */
export interface Geodetic {
  latitude: number;
  longitude: number;
  altitudeMeters: number;
}

const DEG = Math.PI / 180;

/** Geodetic → Earth-Centred, Earth-Fixed metres. */
export function geodeticToEcef({ latitude, longitude, altitudeMeters }: Geodetic): Vec3 {
  const phi = latitude * DEG;
  const lambda = longitude * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  // Prime-vertical radius of curvature.
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  return [
    (n + altitudeMeters) * cosPhi * Math.cos(lambda),
    (n + altitudeMeters) * cosPhi * Math.sin(lambda),
    (n * (1 - WGS84_E2) + altitudeMeters) * sinPhi,
  ];
}

/** ECEF → local East-North-Up metres around `origin`. */
export function ecefToEnu(ecef: Vec3, origin: Geodetic): Vec3 {
  const [x0, y0, z0] = geodeticToEcef(origin);
  const dx = ecef[0] - x0;
  const dy = ecef[1] - y0;
  const dz = ecef[2] - z0;
  const phi = origin.latitude * DEG;
  const lambda = origin.longitude * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);
  return [
    -sinLambda * dx + cosLambda * dy,
    -sinPhi * cosLambda * dx - sinPhi * sinLambda * dy + cosPhi * dz,
    cosPhi * cosLambda * dx + cosPhi * sinLambda * dy + sinPhi * dz,
  ];
}

/** Geodetic → ENU around `origin`, in one step. */
export function geodeticToEnu(point: Geodetic, origin: Geodetic): Vec3 {
  return ecefToEnu(geodeticToEcef(point), origin);
}

/**
 * A column-major 4×4 matrix, as `StreetSceneWorldTransform.enuFromScene` is
 * published: element `(row r, column c)` lives at index `c * 4 + r`, so the
 * translation is at 12, 13, 14.
 */
export type Mat4 = readonly number[];

const at = (m: Mat4, row: number, column: number): number => m[column * 4 + row];

/** `m · [x y z 1]ᵀ`, dropping w (an affine matrix keeps it at 1). */
export function transformPoint(m: Mat4, [x, y, z]: Vec3): Vec3 {
  return [
    at(m, 0, 0) * x + at(m, 0, 1) * y + at(m, 0, 2) * z + at(m, 0, 3),
    at(m, 1, 0) * x + at(m, 1, 1) * y + at(m, 1, 2) * z + at(m, 1, 3),
    at(m, 2, 0) * x + at(m, 2, 1) * y + at(m, 2, 2) * z + at(m, 2, 3),
  ];
}

/** `m · [x y z 0]ᵀ` — a direction, untouched by translation. */
export function transformDirection(m: Mat4, [x, y, z]: Vec3): Vec3 {
  return [
    at(m, 0, 0) * x + at(m, 0, 1) * y + at(m, 0, 2) * z,
    at(m, 1, 0) * x + at(m, 1, 1) * y + at(m, 1, 2) * z,
    at(m, 2, 0) * x + at(m, 2, 1) * y + at(m, 2, 2) * z,
  ];
}

/** How far a matrix may stray from a similarity before it is refused. */
const SIMILARITY_TOLERANCE = 1e-4;

/**
 * Invert a similarity `[sR | t]` exactly: `[Rᵀ/s | −Rᵀt/s]`.
 *
 * A general 4×4 inverse would also work, and would also silently accept a
 * shear or a projective row that the contract says cannot be there — the
 * result is labels placed by a matrix nobody published. So the shape is
 * checked (finite, 16 entries, affine bottom row, orthogonal columns of equal
 * length) and `null` comes back for anything else. A caller with `null` draws
 * no labels rather than wrong ones.
 */
export function invertSimilarity(m: Mat4): number[] | null {
  if (m.length !== 16 || !m.every(Number.isFinite)) return null;
  if (
    Math.abs(at(m, 3, 0)) > SIMILARITY_TOLERANCE ||
    Math.abs(at(m, 3, 1)) > SIMILARITY_TOLERANCE ||
    Math.abs(at(m, 3, 2)) > SIMILARITY_TOLERANCE ||
    Math.abs(at(m, 3, 3) - 1) > SIMILARITY_TOLERANCE
  ) {
    return null;
  }

  const columns: Vec3[] = [0, 1, 2].map((c) => [at(m, 0, c), at(m, 1, c), at(m, 2, c)]);
  const norms = columns.map((c) => Math.hypot(c[0], c[1], c[2]));
  const scale = norms[0];
  if (!(scale > 0)) return null;
  for (const norm of norms) {
    if (Math.abs(norm - scale) > SIMILARITY_TOLERANCE * Math.max(1, scale)) return null;
  }
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const s2 = scale * scale;
  if (
    Math.abs(dot(columns[0], columns[1])) > SIMILARITY_TOLERANCE * s2 ||
    Math.abs(dot(columns[0], columns[2])) > SIMILARITY_TOLERANCE * s2 ||
    Math.abs(dot(columns[1], columns[2])) > SIMILARITY_TOLERANCE * s2
  ) {
    return null;
  }

  // Inverse linear part: (sR)⁻¹ = Rᵀ/s = (sR)ᵀ/s².
  const inv: number[] = new Array(16).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      inv[column * 4 + row] = at(m, column, row) / s2;
    }
  }
  const t: Vec3 = [at(m, 0, 3), at(m, 1, 3), at(m, 2, 3)];
  for (let row = 0; row < 3; row += 1) {
    inv[12 + row] = -(inv[row] * t[0] + inv[4 + row] * t[1] + inv[8 + row] * t[2]);
  }
  inv[15] = 1;
  return inv;
}

/** Normalise, or `null` for a zero vector. */
export function normalize([x, y, z]: Vec3): Vec3 | null {
  const length = Math.hypot(x, y, z);
  return length > 0 ? [x / length, y / length, z / length] : null;
}

/**
 * The world-up direction expressed in scene coordinates.
 *
 * Reconstruction frames have no reason to be Y-up or Z-up; the transform is
 * the only thing that knows where the sky is. A viewer that assumes an axis
 * shows a street lying on its side.
 */
export function sceneUp(enuFromScene: Mat4): Vec3 | null {
  const inverse = invertSimilarity(enuFromScene);
  return inverse ? normalize(transformDirection(inverse, [0, 0, 1])) : null;
}
