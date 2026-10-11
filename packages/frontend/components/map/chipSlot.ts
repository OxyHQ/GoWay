/**
 * Where a screen lets the map's own DOM chips (the "Simulated traffic" label,
 * `cityLifeChip.web.ts`) take their place in its top-right stack.
 *
 * A screen that stacks chrome at the top right renders an EMPTY view with this
 * `nativeID` (react-native-web emits it as the DOM `id`) as the last item of
 * that stack; the chip mounts into it and flows below whatever is above it, so
 * nothing overlaps whatever the stack holds. A map with no such slot — the
 * embed — keeps the chip at its own absolute spot in the map container. The
 * slot is never hidden: the chip must show whenever the simulation draws.
 */
export const MAP_CHIP_SLOT_ID = 'goway-map-chip-slot';
