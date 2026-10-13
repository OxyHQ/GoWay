/**
 * A source's declared transit modes decide whether a regional view wakes it
 * (`hub.ts`), and the modes its vehicles end up with decide which rooms they
 * are in (`liveRoomZoomsOf`). A declaration that missed a mode would either
 * push trains into regional rooms no regional viewer can wake, or never wake
 * the source at all. So every declaration must include what the adapter
 * emits AND every mode the operator's own `routes.txt` names (the hub gives
 * a vehicle its route's mode).
 */
import { describe, expect, it } from 'bun:test';
import type { LiveTransitMode } from '@goway/contracts';
import { sourceAreas } from '../areas';
import { LIVE_SOURCES } from '../catalogue';
import { protobufWriter as w } from '../protobuf';
import type { LiveFetch, LiveSourceDefinition } from '../types';

const transit = LIVE_SOURCES.filter((source) => source.kind === 'transit');

/** A VehiclePositions feed with one vehicle at the middle of a source's coverage. */
function feed(source: LiveSourceDefinition): Uint8Array {
  const box = sourceAreas(source.id)?.areas[0] ?? source.coverage;
  const latitude = box ? (box.south + box.north) / 2 : 41.39;
  const longitude = box ? (box.west + box.east) / 2 : 2.17;
  const now = Math.floor(Date.now() / 1000);
  const header = w.bytes(1, [...w.string(1, '2.0'), ...w.uint(3, now)]);
  const vehicle = w.bytes(2, [
    ...w.string(1, 'e1'),
    ...w.bytes(4, [
      ...w.bytes(1, [...w.string(1, 'T1'), ...w.string(5, 'R1')]),
      ...w.bytes(8, [...w.string(1, 'v1'), ...w.string(2, '1234')]),
      ...w.bytes(2, [...w.float(1, latitude), ...w.float(2, longitude)]),
      ...w.uint(5, now),
    ]),
  ]);
  return new Uint8Array([...header, ...vehicle]);
}

async function emitted(source: LiveSourceDefinition): Promise<LiveTransitMode[] | null> {
  const body = feed(source);
  const fetch: LiveFetch = async () => ({
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  });
  try {
    const result = await source
      .create({ url: source.defaultUrl, key: 'k', userAgent: 'test', maxRegionsPerPoll: 1 })
      .poll({ signal: new AbortController().signal, fetch, now: Date.now, demand: [] });
    const modes = result.entities.flatMap((entity) =>
      entity.kind === 'transit' ? [entity.mode] : [],
    );
    return modes.length > 0 ? modes : null;
  } catch {
    // Not a GTFS-Realtime positions feed (FGC's JSON): its routes decide below.
    return null;
  }
}

describe('declared transit modes', () => {
  it('include every mode the operator routes name', () => {
    for (const source of transit) {
      const routes = sourceAreas(source.id)?.modes ?? [];
      const declared = source.transitModes;
      if (!declared) continue; // any mode: nothing to miss
      const missing = routes.filter((mode) => !declared.includes(mode));
      expect({ id: source.id, missing }).toEqual({ id: source.id, missing: [] });
    }
  });

  it("include every mode the source's adapter emits", async () => {
    const unchecked: string[] = [];
    for (const source of transit) {
      const modes = await emitted(source);
      const routes = sourceAreas(source.id)?.modes;
      if (!modes) {
        // Checked by its routes instead, or declared as any mode.
        if (!routes && source.transitModes) unchecked.push(source.id);
        continue;
      }
      const declared = source.transitModes;
      if (!declared) continue;
      const missing = modes.filter((mode) => !declared.includes(mode));
      expect({ id: source.id, missing }).toEqual({ id: source.id, missing: [] });
    }
    // Every declaration is checked one way or the other.
    expect(unchecked).toEqual([]);
  });
});
