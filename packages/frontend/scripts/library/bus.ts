/**
 * The model library's city buses — single-deck and double-deck — built with
 * the landmark kit (`scripts/landmarks/kit.ts`) because no CC0 kit GoWay uses
 * has one. Drawn in the Kenney kits' language so the fleet reads as one
 * family: chunky chamfered blocks, a dark skirt, deep window bands wrapping
 * the front, slightly oversized wheels, colour blocking rather than detail.
 * 12 × 2.55 m, 3.1 m tall (4.3 m with two decks), glTF frame (+Y up, front +Z).
 *
 * Returns geometry per library material — `paint` (the tintable body) and
 * `body` (fixed colours as vertex colours) — at two levels of detail.
 */
import { linearChannel } from '../landmarks/glb';
import { Builder, box, cylinder, THREE } from '../landmarks/kit';

const SKIRT = [0.32, 0.34, 0.4] as const;
const GLASS = [0.24, 0.29, 0.36] as const;
const ROOF = [0.82, 0.83, 0.86] as const;
const TYRE = [0.17, 0.17, 0.19] as const;
const HUB = [0.62, 0.64, 0.69] as const;
const LAMP = [0.98, 0.94, 0.8] as const;

function coloured(geometry: THREE.BufferGeometry, rgb: readonly [number, number, number]) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const count = g.attributes.position.count;
  const colours = new Float32Array(count * 3);
  // `COLOR_0` is linear light; the constants above are sRGB.
  const linear = rgb.map(linearChannel);
  for (let i = 0; i < count; i++) colours.set(linear, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return g;
}

export function busLods(decks: 1 | 2 = 1): { near: Builder; far: Builder } {
  const lods = {
    near: new Builder(new Set(['paint', 'body'])),
    far: new Builder(new Set(['paint', 'body'])),
  };
  const halfW = 1.275;
  const halfL = 6;
  for (const [name, b] of Object.entries(lods)) {
    const near = name === 'near';
    const bevel = near ? 0.1 : 0;
    // Skirt, body, window band, roof.
    b.add('body', coloured(box([-halfW, 0.3, -halfL], [halfW, 0.75, halfL], bevel), SKIRT));
    b.add('paint', box([-halfW, 0.72, -halfL], [halfW, 1.45, halfL], bevel));
    const inset = near ? 0.06 : 0;
    b.add(
      'body',
      coloured(
        box([-halfW + 0.03, 1.42, -halfL + 0.03], [halfW - 0.03, 2.55, halfL - 0.03], inset),
        GLASS,
      ),
    );
    // The upper deck: a belt of paint, a second window band.
    const lift = decks === 2 ? 1.2 : 0;
    if (decks === 2) {
      b.add('paint', box([-halfW, 2.52, -halfL], [halfW, 2.75, halfL], bevel));
      b.add(
        'body',
        coloured(
          box([-halfW + 0.03, 2.72, -halfL + 0.03], [halfW - 0.03, 3.75, halfL - 0.03], inset),
          GLASS,
        ),
      );
    }
    b.add('paint', box([-halfW, 2.52 + lift, -halfL], [halfW, 2.95 + lift, halfL], bevel));
    b.add(
      'body',
      coloured(
        box(
          [-halfW + 0.25, 2.92 + lift, -halfL + 1.2],
          [halfW - 0.25, 3.12 + lift, halfL - 2.5],
          inset,
        ),
        ROOF,
      ),
    );
    if (!near) continue;
    // Doors on the kerb side (right of travel: glTF −X), as darker glass panels.
    for (const [z0, z1] of [
      [3.9, 5.1],
      [-0.6, 0.6],
    ]) {
      b.add('body', coloured(box([-halfW - 0.02, 0.4, z0], [-halfW + 0.01, 2.5, z1]), GLASS));
    }
    // Headlamps and the wheels: oversized, as the kits draw them.
    for (const x of [-0.85, 0.85]) {
      b.add(
        'body',
        coloured(box([x - 0.22, 0.95, halfL - 0.02], [x + 0.22, 1.15, halfL + 0.03], 0.02), LAMP),
      );
    }
    for (const z of [3.9, -3.7]) {
      for (const side of [-1, 1]) {
        const tyre = cylinder(0.55, 0.55, -0.17, 0.17, 12);
        tyre.rotateZ(Math.PI / 2);
        tyre.translate(side * (halfW - 0.12), 0.55, z);
        b.add('body', coloured(tyre, TYRE));
        const hub = cylinder(0.28, 0.28, -0.03, 0.03, 8);
        hub.rotateZ(Math.PI / 2);
        hub.translate(side * (halfW + 0.04), 0.55, z);
        b.add('body', coloured(hub, HUB));
      }
    }
  }
  return lods;
}
