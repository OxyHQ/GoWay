/**
 * A shelf packer for the sprite atlas.
 *
 * ## Why not `@mapbox/shelf-pack`
 *
 * Because the input is 35 icons that are all the same size. `@mapbox/shelf-pack`
 * is a good library solving a problem GoWay does not have — incremental packing
 * of thousands of differently-sized bins with reference counting and eviction —
 * and adding it would put a dependency in `bun.lock` to run a loop that fits in
 * forty lines. If the sprite ever grows into something that needs real bin
 * packing, that is the moment to reach for the library.
 *
 * ## The algorithm and why it is enough
 *
 * Sort by descending height, then fill horizontal shelves left to right,
 * opening a new shelf when the current one is full. For uniformly-sized input
 * this is optimal; for mixed sizes it wastes the height difference within a
 * shelf, which is the well-known and acceptable cost of shelf packing.
 *
 * Sorting is by `(-height, -width, name)` — the name breaks ties — so the
 * layout is a pure function of the icon set and not of the order the icons
 * happened to be read off disk. That is what keeps the committed `.png` and
 * `.json` byte-identical across runs.
 *
 * ## The atlas is power-of-two
 *
 * MapLibre does not mipmap the sprite, so this is not strictly required. It is
 * done anyway because non-power-of-two textures with `REPEAT` wrapping are
 * still a hazard on older GLES2 drivers that React Native's MapLibre reaches,
 * and a 256x256 atlas that is 65% full costs 20 KB.
 */

export interface PackInput {
  /** Sprite id, e.g. `goway-park`. Also the deterministic tie-break key. */
  name: string;
  width: number;
  height: number;
}

export interface PackedBox extends PackInput {
  x: number;
  y: number;
}

export interface PackResult {
  atlasWidth: number;
  atlasHeight: number;
  boxes: PackedBox[];
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/**
 * Pack boxes into an atlas of the given width, growing the height as needed.
 *
 * Throws rather than silently dropping when a box is wider than the atlas: a
 * missing icon in a sprite is invisible at build time and only shows up as a
 * gap on the map.
 */
export function shelfPack(inputs: readonly PackInput[], atlasWidth: number): PackResult {
  const ordered = [...inputs].sort(
    (a, b) => b.height - a.height || b.width - a.width || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const boxes: PackedBox[] = [];
  let shelfY = 0;
  let shelfHeight = 0;
  let cursorX = 0;

  for (const input of ordered) {
    if (input.width > atlasWidth) {
      throw new Error(`"${input.name}" is ${input.width}px wide, wider than the ${atlasWidth}px atlas`);
    }
    if (cursorX + input.width > atlasWidth) {
      shelfY += shelfHeight;
      shelfHeight = 0;
      cursorX = 0;
    }
    boxes.push({ ...input, x: cursorX, y: shelfY });
    cursorX += input.width;
    if (input.height > shelfHeight) shelfHeight = input.height;
  }

  const used = shelfY + shelfHeight;
  return { atlasWidth, atlasHeight: Math.max(1, nextPowerOfTwo(used)), boxes };
}
