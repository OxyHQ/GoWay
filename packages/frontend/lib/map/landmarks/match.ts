/**
 * Which landmark a GoWay Place is, if any (`docs/MAP_LANDMARKS.md` → Tour).
 *
 * Matched on the Place's own OpenStreetMap source (`openstreetmap` ·
 * `way/34633854`), or on its GoWay Place ID once the registry records one —
 * never on a name, which two unrelated places can share (Catalonia has four
 * churches called "Sagrada Família").
 */
import type { PreparedLandmark } from './load';

export function landmarkForPlace(
  landmarks: readonly PreparedLandmark[],
  place: { id: string; sources: ReadonlyArray<{ source: string; sourceId: string }> },
): PreparedLandmark | null {
  const osm = new Set(
    place.sources.filter((s) => s.source === 'openstreetmap').map((s) => s.sourceId),
  );
  return (
    landmarks.find((l) => l.entry.placeId === place.id || osm.has(l.entry.osm.element)) ?? null
  );
}
