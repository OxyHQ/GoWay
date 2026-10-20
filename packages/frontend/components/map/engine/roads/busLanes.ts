/**
 * Which lanes of a road carry a bus designation — the ONE reading of
 * `bus:lanes`, `lanes:bus` and `busway` for a direction of travel.
 *
 * The street renderer paints them (`cityStreets/lanes.ts`) and the traffic
 * simulation keeps cars off them (`cityLife/sim/network.ts`): both ask here,
 * so a lane drawn as a bus lane is never one a car drives.
 */
import { type DrivingSide, kerbSideOf } from './drivingSide';
import type { RoadPiece } from './roadTiles';

/** `list` when it has exactly `count` entries, else `null`. */
function fits<T>(list: T[] | undefined, count: number): T[] | null {
  return list && list.length === count ? list : null;
}

/**
 * Per lane of one direction, in the TRAVELLER's left-to-right order: whether
 * it is designated for buses. `dir` is `1` travelling with the way's drawn
 * direction, `-1` against it; `count` is that direction's lane count. All
 * `false` when nothing recorded names a bus lane — a road's lanes are never
 * guessed — and all `false` when EVERY lane is one: a road of nothing but bus
 * lanes is a busway, plain lanes to the renderer (its access says who drives it).
 */
export function busLaneFlags(
  piece: RoadPiece,
  dir: 1 | -1,
  drivingSide: DrivingSide,
  count: number,
): boolean[] {
  const flags = Array.from({ length: count }, () => false);
  if (count === 0) return flags;
  const oneway = piece.oneway === 1 || piece.oneway === -1;
  // A one-way road's plain key describes its only direction; a two-way road's
  // describes neither (OSM wants `:forward`/`:backward` there).
  const forDirection = <T>(
    plain: T | undefined,
    forward: T | undefined,
    backward: T | undefined,
  ) => {
    const directional = dir === 1 ? forward : backward;
    return oneway ? (plain ?? directional) : directional;
  };

  const pattern = fits(
    forDirection(piece.busLanes, piece.busLanesForward, piece.busLanesBackward),
    count,
  );
  if (pattern) return pattern.some((bus) => !bus) ? [...pattern] : flags;

  // The traveller's kerb is on their right where traffic keeps right.
  const kerbFirst = drivingSide === 'left';
  const k = forDirection(piece.lanesBus, piece.lanesBusForward, piece.lanesBusBackward);
  if (k !== undefined) {
    for (let i = 0; i < Math.min(k, count - 1); i++) flags[kerbFirst ? i : count - 1 - i] = true;
  } else if (piece.busway && count > 1) {
    // `busway:<side>` names a DRAWN side; the travel lane on that side of this
    // direction's lanes is its bus lane, if this direction is there.
    const kerb = kerbSideOf(dir, drivingSide);
    const sides: ('left' | 'right')[] =
      piece.busway === 'both' ? (oneway ? [kerb] : ['left', 'right']) : [piece.busway];
    for (const side of sides) {
      // Which end of the traveller's list is the drawn side.
      const travellerRight = (side === 'right') === (dir === 1);
      if (!oneway && side !== kerb) continue;
      flags[travellerRight ? count - 1 : 0] = true;
    }
  }
  return flags;
}
