/**
 * Facade rhythm and surface colour for the OSM city tiles — the two places
 * where the renderer draws detail, and therefore where the honesty rule
 * (`docs/MAP_3D_CITY.md` → Honesty) is enforced.
 *
 * ## Window rows only where floors are recorded
 *
 * {@link facadeFor} returns a storey rhythm ONLY when the building carries
 * `building:levels` (and, for a part that starts in the air,
 * `building:min_level`) and the count agrees with the building's height to
 * within a plausible storey. Otherwise it returns `null` and the wall is
 * plain: no count means no pattern, never a guessed one. The rhythm is
 * abstract — evenly spaced rows of identical openings, no doors, no
 * storefronts, no ground-floor treatment — because the count is all the data
 * says. The columns ({@link bayCount}) are styling: an even division of each
 * facade so a row reads as windows rather than a stripe, at a fixed
 * {@link FACADE.bayM}, and never more than that claims.
 *
 * ## Colour from tags, tempered
 *
 * `building:colour`/`roof:colour` and `building:material`/`roof:material` are
 * recorded facts and are drawn — but blended into the cartographic palette,
 * not painted over it (`TAG_TEMPER`, `tsl/buildingSurface.ts`): `buildings3d.ts` refused raw
 * `colour` because a city painted from it is "a patchwork with black towers in
 * it", and the blend is what keeps the fact without the patchwork. A material
 * draws as its typical colour, weaker than a tagged colour (it is a
 * description of what a wall is made of, not of what colour it is).
 */
import type { RoofMaterial, WallMaterial } from '@/lib/map/cityTiles';

export const FACADE = {
  /** Width of one window bay along a facade, metres. */
  bayM: 3.2,
  /** Facades shorter than this get no openings (a sliver between two parts). */
  minFacadeM: 2,
  /** A storey outside this range means the count and the height disagree: draw no rhythm. */
  minStoreyM: 2.2,
  maxStoreyM: 6.5,
} as const;

/** How a wall's storeys are laid out, in metres above the ground. */
export interface FacadeRhythm {
  /** Height of the lowest recorded storey's floor. */
  base: number;
  /** Height of one storey. */
  storey: number;
  /** Storeys drawn, from `base` up. */
  count: number;
}

/**
 * The storey rhythm for a wall from `base` to `eaves`, or `null` when the
 * floors are not recorded (or do not fit the height).
 *
 * `levels` is `building:levels` — storeys above the GROUND, roof excluded —
 * and `minLevel` is `building:min_level`, the storeys a raised part skips.
 */
export function facadeFor(
  levels: number | undefined,
  minLevel: number | undefined,
  base: number,
  eaves: number,
): FacadeRhythm | null {
  if (levels === undefined) return null;
  const count = levels - (minLevel ?? 0);
  if (count <= 0) return null;
  const storey = (eaves - base) / count;
  if (!(storey >= FACADE.minStoreyM && storey <= FACADE.maxStoreyM)) return null;
  return { base, storey, count };
}

/** Window bays on a facade `lengthM` long: an even division, 0 when it is too short. */
export function bayCount(lengthM: number): number {
  if (!(lengthM >= FACADE.minFacadeM)) return 0;
  return Math.max(1, Math.round(lengthM / FACADE.bayM));
}

/** Typical colour of a wall material, `0xRRGGBB`. Muted on purpose: it is a hint, not paint. */
export const WALL_MATERIAL_COLOURS: Readonly<Record<WallMaterial, number>> = {
  brick: 0xb5735a,
  concrete: 0xbdbab3,
  glass: 0x8fa7b8,
  stone: 0xc9bfae,
  sandstone: 0xd6c29a,
  limestone: 0xddd5c3,
  marble: 0xe8e4dc,
  plaster: 0xe3dccd,
  wood: 0xa98260,
  metal: 0xa7adb3,
  steel: 0x9aa1a8,
  timber_framing: 0xd9cdb3,
  mud: 0xb39572,
  adobe: 0xc19a72,
};

/** Typical colour of a roof material, `0xRRGGBB`. */
export const ROOF_MATERIAL_COLOURS: Readonly<Record<RoofMaterial, number>> = {
  roof_tiles: 0xb5654a,
  slate: 0x5e6670,
  concrete: 0xb0aca5,
  metal: 0x8f979e,
  copper: 0x6fa58f,
  glass: 0x9fb6c4,
  tar_paper: 0x5f5f5f,
  gravel: 0xa39e94,
  grass: 0x7f9a5e,
  thatch: 0xb39b68,
  wood: 0x8c6b4e,
  stone: 0x9b958b,
  asbestos: 0xa4a29c,
  plastic: 0xc8c8c8,
  solar_panels: 0x34435a,
};

/** Weight (0–255) a surface colour gets against the palette: a tag outweighs a material. */
export const COLOUR_WEIGHT = { tagged: 255, material: 190, none: 0 } as const;

/** A surface's colour as `[r, g, b, weight]` bytes; weight 0 means "the palette's ramp". */
export function surfaceColour(
  colour: number | undefined,
  material: number | undefined,
): [number, number, number, number] {
  const value = colour ?? material;
  if (value === undefined) return [0, 0, 0, COLOUR_WEIGHT.none];
  return [
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255,
    colour !== undefined ? COLOUR_WEIGHT.tagged : COLOUR_WEIGHT.material,
  ];
}
