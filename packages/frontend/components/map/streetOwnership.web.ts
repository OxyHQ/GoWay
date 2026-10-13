import type { FilterSpecification, Map as MapLibreMap } from 'maplibre-gl';

type Tile = { x: number; y: number };
type Point = [number, number];

/** Join tile boundaries, so a road crossing two loaded tiles stays inside. */
export function streetCoverage(tiles: readonly Tile[]) {
  const edges = new Map<string, { a: Point; b: Point }>();
  const key = (a: Point, b: Point) => `${a[0]},${a[1]}/${b[0]},${b[1]}`;
  for (const { x, y } of tiles) {
    const ring: Point[] = [
      [x, y],
      [x + 1, y],
      [x + 1, y + 1],
      [x, y + 1],
    ];
    for (let i = 0; i < 4; i++) {
      const a = ring[i],
        b = ring[(i + 1) % 4];
      if (!edges.delete(key(b, a))) edges.set(key(a, b), { a, b });
    }
  }
  const rings: Point[][] = [];
  while (edges.size) {
    const first = edges.values().next().value;
    if (!first) break;
    const ring: Point[] = [first.a];
    let edge = first;
    do {
      edges.delete(key(edge.a, edge.b));
      ring.push(edge.b);
      const next = [...edges.values()].find((e) => e.a[0] === edge.b[0] && e.a[1] === edge.b[1]);
      if (!next) break;
      edge = next;
    } while (
      edge !== first &&
      (ring.at(-1)?.[0] !== ring[0][0] || ring.at(-1)?.[1] !== ring[0][1])
    );
    rings.push(ring);
  }
  const area = (ring: Point[]) =>
    ring.reduce((sum, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return sum + p[0] * q[1] - q[0] * p[1];
    }, 0);
  const outer = rings.filter((r) => area(r) > 0).map((r) => [r]);
  for (const hole of rings.filter((r) => area(r) < 0)) {
    const [hx, hy] = hole[0];
    const owner = outer.find(([ring]) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i],
          b = ring[j];
        if (a[1] > hy !== b[1] > hy && hx < ((b[0] - a[0]) * (hy - a[1])) / (b[1] - a[1]) + a[0])
          inside = !inside;
      }
      return inside;
    });
    owner?.push(hole);
  }
  return {
    type: 'MultiPolygon' as const,
    coordinates: outer.map((polygon) =>
      polygon.map((ring) =>
        ring.map(([x, y]) => [
          (x / 2 ** 15) * 360 - 180,
          (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** 15))) * 180) / Math.PI,
        ]),
      ),
    ),
  };
}

/** Basemap fallback yields only where complete road features have a drawn replacement. */
export function mountStreetOwnership(map: MapLibreMap) {
  const previous = new Map<string, FilterSpecification | undefined>();
  for (const layer of map.getStyle().layers) {
    if (
      (layer.id.startsWith('road-') &&
        ![
          'road-tunnel',
          'road-tunnel-casing',
          'road-ferry',
          'road-rail',
          'road-rail-hatch',
        ].includes(layer.id)) ||
      layer.id.startsWith('label-road-')
    ) {
      previous.set(layer.id, map.getFilter(layer.id) ?? undefined);
    }
  }
  return {
    set(tiles: readonly Tile[]) {
      const coverage = streetCoverage(tiles);
      for (const [id, filter] of previous) {
        if (!map.getLayer(id)) continue;
        map.setFilter(
          id,
          tiles.length
            ? ([
                'all',
                filter ?? true,
                ['any', ['==', ['get', 'brunnel'], 'tunnel'], ['!', ['within', coverage]]],
              ] as FilterSpecification)
            : (filter ?? null),
        );
      }
    },
    remove() {
      for (const [id, filter] of previous) if (map.getLayer(id)) map.setFilter(id, filter ?? null);
    },
  };
}
