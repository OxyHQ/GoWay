/**
 * What one Worker isolate may hold in memory for the map, and why it adds up.
 *
 * An isolate has 128 MB for everything; these caches are bounded by BYTES so
 * that no mix of requests — the planet's 17,685-entry leaf directories, the
 * city tiles of a dozen regions — can grow them past a known total:
 *
 * | Cache | Budget | Holds |
 * | --- | ---: | --- |
 * | Directories (`tiles.js`) | 12 MiB | headers + decoded roots and leaves, 24 B an entry: ~28 planet leaves or ~120 city leaves |
 * | Ownership trees (`city.js`) | 6 MiB | compact trees, 5 B a node: ~1.2 M nodes, a few dozen regions |
 * | City manifest (`city.js`) | 5 MiB | the slim parse of the 2.6 MB manifest (ids, boxes, keys, encoded ownership, the coverage answer): 4.09 MiB measured in V8 for the planet's 430 entries |
 *
 * 23 MiB in all, under {@link MEMORY_BUDGET}.total (24 MiB); the rest of the isolate is
 * the request in flight (a tile is at most a few hundred kB). A test fills
 * each cache with realistic data and checks it stays inside its line.
 *
 * Exported from a module that is not the Worker's entry, so numbers are fine
 * here (workerd refuses non-function, non-object named exports of the entry).
 */
export const MEMORY_BUDGET = Object.freeze({
  directories: 12 * 1024 * 1024,
  ownershipTrees: 6 * 1024 * 1024,
  manifest: 5 * 1024 * 1024,
  total: 24 * 1024 * 1024,
});
