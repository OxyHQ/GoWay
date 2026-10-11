/**
 * The model library's airliner, built with the landmark kit
 * (`scripts/landmarks/kit.ts`) because none of the CC0 kits GoWay uses has
 * one. Drawn in the Kenney kits' language like the bus (`bus.ts`): faceted
 * cylinders and slabs, colour blocking, no markings. A narrow-body's size —
 * 37.6 m long, 35.8 m span, 11.8 m to the fin — standing on its wheels,
 * glTF frame (+Y up, nose +Z).
 *
 * `paint` is the fuselage and fin (the livery's colour); wings, engines and
 * glass are fixed vertex colours.
 */
import { linearChannel } from '../landmarks/glb';
import { Builder, box, cylinder, prism, THREE } from '../landmarks/kit';

const WING = [0.8, 0.82, 0.86] as const;
const ENGINE = [0.56, 0.58, 0.64] as const;
const GLASS = [0.24, 0.29, 0.36] as const;
const GEAR = [0.22, 0.22, 0.25] as const;

function coloured(geometry: THREE.BufferGeometry, rgb: readonly [number, number, number]) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const colours = new Float32Array(g.attributes.position.count * 3);
  const linear = rgb.map(linearChannel);
  for (let i = 0; i < g.attributes.position.count; i++) colours.set(linear, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return g;
}

/** A cylinder lying along z, from `z0` to `z1`, centred on (x, y). */
function along(
  r0: number,
  r1: number,
  z0: number,
  z1: number,
  x: number,
  y: number,
  segments: number,
) {
  const g = cylinder(r0, r1, z0, z1, segments);
  // The kit's cylinder stands along y: lay it down, y → z.
  g.rotateX(Math.PI / 2);
  g.translate(x, y, 0);
  return g;
}

export function aircraftLods(): { near: Builder; far: Builder } {
  const lods = {
    near: new Builder(new Set(['paint', 'body'])),
    far: new Builder(new Set(['paint', 'body'])),
  };
  const axis = 3.2;
  const radius = 2;
  for (const [name, b] of Object.entries(lods)) {
    const near = name === 'near';
    const segments = near ? 10 : 6;
    // Fuselage, nose cone and tail cone. Laid down, a cylinder's +y end is −z.
    b.add('paint', along(radius, radius, -13, 15, 0, axis, segments));
    b.add('paint', along(radius, 0.5, -15, -18.8, 0, axis, segments));
    b.add('paint', along(0.5, radius, 18.8, 13, 0, axis + 0.5, segments));
    // Swept wings and tailplane, one slab each (the plan is x, z).
    b.add(
      'body',
      coloured(
        prism(
          [
            [-1.9, 4.5],
            [-17.9, -4],
            [-17.9, -6],
            [-1.9, -2],
            [1.9, -2],
            [17.9, -6],
            [17.9, -4],
            [1.9, 4.5],
          ],
          axis - 1.3,
          axis - 0.9,
        ),
        WING,
      ),
    );
    b.add(
      'body',
      coloured(
        prism(
          [
            [-0.5, -14.5],
            [-6.2, -17.6],
            [-6.2, -18.6],
            [0, -17.4],
            [6.2, -18.6],
            [6.2, -17.6],
            [0.5, -14.5],
          ],
          axis + 0.4,
          axis + 0.7,
        ),
        WING,
      ),
    );
    // The fin: a swept slab standing on the tail (its plan is z, y, built flat and stood up).
    const fin = prism(
      [
        [-13.6, axis + 1],
        [-18.4, 11.8],
        [-16.4, 11.8],
        [-10.6, axis + 1],
      ],
      -0.2,
      0.2,
    );
    // Plan (x, z) → (z, y): the slab's x becomes z, its z becomes y, its y becomes x.
    fin.applyMatrix4(new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1));
    b.add('paint', fin);
    if (!near) continue;
    // Cockpit glass and a cabin window band either side.
    b.add('body', coloured(box([-1.2, axis + 0.6, 14.6], [1.2, axis + 1.3, 16.2]), GLASS));
    for (const side of [-1, 1]) {
      b.add(
        'body',
        coloured(
          box([side * 1.96 - 0.05, axis + 0.45, -11], [side * 1.96 + 0.05, axis + 0.85, 12.5]),
          GLASS,
        ),
      );
    }
    // Two engines under the wings.
    for (const x of [-5.8, 5.8]) {
      b.add('body', coloured(along(1.05, 1.05, -1.5, 3.6, x, axis - 2.1, 8), ENGINE));
    }
    // Gear: nose and mains.
    b.add('body', coloured(box([-0.25, 0, 11.5], [0.25, axis - radius + 0.2, 12.3]), GEAR));
    for (const x of [-2.4, 2.4])
      b.add('body', coloured(box([x - 0.4, 0, -1.4], [x + 0.4, axis - radius + 0.2, -0.2]), GEAR));
  }
  return lods;
}
