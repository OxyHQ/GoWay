type Pose = [number, number, number];

export function groundPose(
  sample: (x: number, y: number) => number,
  x: number,
  y: number,
  heading: number,
  halfLength: number,
  halfWidth: number,
): Pose;
export function groundPose(
  sample: (x: number, y: number) => number | null,
  x: number,
  y: number,
  heading: number,
  halfLength: number,
  halfWidth: number,
): Pose | null;
/** Fit a rigid contact plane to supported points, never to the floor under a missing deck. */
export function groundPose(
  sample: (x: number, y: number) => number | null,
  x: number,
  y: number,
  heading: number,
  halfLength: number,
  halfWidth: number,
): Pose | null {
  const c = Math.cos(heading),
    s = Math.sin(heading);
  const points: [number, number, number][] = [];
  for (const [f, l] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [0, 0],
  ]) {
    const a = f * halfLength,
      b = l * halfWidth;
    const height = sample(x + c * a - s * b, y + s * a + c * b);
    if (height !== null && Number.isFinite(height)) points.push([a, b, height]);
  }
  if (!points.length) return null;
  const mean = [0, 0, 0];
  for (const p of points)
    for (let axis = 0; axis < 3; axis++) mean[axis] += p[axis] / points.length;
  let xx = 0,
    yy = 0,
    xy = 0,
    xz = 0,
    yz = 0;
  for (const p of points) {
    const dx = p[0] - mean[0],
      dy = p[1] - mean[1],
      dz = p[2] - mean[2];
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
    xz += dx * dz;
    yz += dy * dz;
  }
  const det = xx * yy - xy * xy;
  const trace = xx + yy;
  // Collinear support determines only the slope along that line; choose the
  // minimum-norm plane instead of inventing a crossfall in the missing axis.
  const forward = det > 1e-9 ? (xz * yy - yz * xy) / det : trace > 1e-9 ? xz / trace : 0;
  const left = det > 1e-9 ? (yz * xx - xz * xy) / det : trace > 1e-9 ? yz / trace : 0;
  const anchor = Math.max(...points.map(([a, b, h]) => h - a * forward - b * left));
  return [anchor, forward * c - left * s, forward * s + left * c];
}
