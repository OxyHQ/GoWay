/** A contact plane sampled at the footprint, in world east/north metres. */
export function groundPose(
  sample: (x: number, y: number) => number,
  x: number,
  y: number,
  heading: number,
  halfLength: number,
  halfWidth: number,
): [number, number, number] {
  const c = Math.cos(heading),
    s = Math.sin(heading);
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const heights = corners.map(([f, l]) =>
    sample(x + c * halfLength * f - s * halfWidth * l, y + s * halfLength * f + c * halfWidth * l),
  );
  const forward = (heights[1] + heights[2] - heights[0] - heights[3]) / (4 * halfLength);
  const left = (heights[2] + heights[3] - heights[0] - heights[1]) / (4 * halfWidth);
  const anchor = Math.max(
    sample(x, y),
    ...heights.map(
      (h, i) => h - corners[i][0] * halfLength * forward - corners[i][1] * halfWidth * left,
    ),
  );
  return [anchor, forward * c - left * s, forward * s + left * c];
}
