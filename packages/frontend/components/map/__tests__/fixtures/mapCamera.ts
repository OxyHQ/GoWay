/**
 * A MapLibre-shaped camera for tests: the mercator → clip matrix, bounds and
 * centre a `CityView` carries, from a centre, zoom, pitch and bearing — the
 * same construction MapLibre's transform makes (36.87° field of view, eye one
 * focal length from the centre, far plane just past the top of the screen).
 * Shared by the LOD tests and the CI budget gate.
 */
import { invertMat4 } from '@/components/map/engine/city3d/lod';
import {
  latFromMercatorY,
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
  multiplyMat4,
} from '@/components/map/engine/city3d/tileMath';

export const FOV = (36.87 * Math.PI) / 180;

export type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function lookAt(eye: V3, target: V3, up: V3): number[] {
  const f = norm(sub(target, eye));
  const s = norm(cross(f, up));
  const u = cross(s, f);
  // biome-ignore format: a 4×4 matrix reads as four columns.
  return [
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ];
}

export function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2);
  // biome-ignore format: a 4×4 matrix reads as four columns.
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
}

export interface Camera {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing?: number;
  width?: number;
  height?: number;
  /** The ground's elevation under the camera, metres (3D terrain). */
  groundM?: number;
}

/** The camera's matrix, bounds and centre, as the engine's `CityView` carries them. */
export function camera(c: Camera) {
  const width = c.width ?? 1280;
  const height = c.height ?? 800;
  const pitch = (c.pitch * Math.PI) / 180;
  const bearing = ((c.bearing ?? 0) * Math.PI) / 180;
  const focal = 0.5 / Math.tan(FOV / 2);
  // The eye is one focal length (in pixels) from the centre; in mercator units:
  const distance = (focal * height) / (512 * 2 ** c.zoom);
  const groundZ = (c.groundM ?? 0) * mercatorPerMetre(c.lat);
  const centre: V3 = [mercatorXFromLng(c.lng), mercatorYFromLat(c.lat), groundZ];
  // Mercator y grows south: "north" is -y. Bearing turns clockwise from north.
  const north: V3 = [Math.sin(bearing), -Math.cos(bearing), 0];
  const eye: V3 = [
    centre[0] - north[0] * distance * Math.sin(pitch),
    centre[1] - north[1] * distance * Math.sin(pitch),
    groundZ + distance * Math.cos(pitch),
  ];
  // Far plane just past the top of the screen, or the horizon, as MapLibre does.
  const topAngle = pitch + FOV / 2;
  const far = topAngle < Math.PI / 2 - 0.01 ? (1.01 * eye[2]) / Math.cos(topAngle) : distance * 100;
  const matrix = multiplyMat4(
    perspective(FOV, width / height, distance / 50, far),
    lookAt(eye, centre, north),
  );

  // Bounds: the ground under the four screen corners (or as far as the far plane).
  const inverse = invertMat4(matrix) as number[];
  const unproject = (x: number, y: number, z: number): V3 => {
    const v = [0, 1, 2, 3].map(
      (row) => inverse[row] * x + inverse[4 + row] * y + inverse[8 + row] * z + inverse[12 + row],
    );
    return [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
  };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const a = unproject(sx, sy, -1);
    const b = unproject(sx, sy, 1);
    const t = b[2] < groundZ ? (a[2] - groundZ) / (a[2] - b[2]) : 1;
    xs.push(a[0] + (b[0] - a[0]) * t);
    ys.push(a[1] + (b[1] - a[1]) * t);
  }
  const lngOf = (x: number) => x * 360 - 180;
  return {
    mercatorToClip: matrix,
    zoom: c.zoom,
    center: { lng: c.lng, lat: c.lat },
    bounds: {
      west: lngOf(Math.min(...xs)),
      east: lngOf(Math.max(...xs)),
      north: latFromMercatorY(Math.min(...ys)),
      south: latFromMercatorY(Math.max(...ys)),
    },
    eye,
    groundCorners: xs.map((x, i) => [x, ys[i]] as [number, number]),
  };
}
