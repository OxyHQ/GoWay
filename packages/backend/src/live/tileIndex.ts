/**
 * The in-memory spatial index of live entities: the latest fix per entity,
 * bucketed by room — a web-mercator tile at each of its levels
 * (`liveRoomZoomsOf`: its kind's, but a bus only at city zoom) and the kind.
 *
 * Rooms ARE the spatial index. A subscription is answered from the buckets of
 * the tiles it covers (`liveTilesFor`), a delta is addressed to the bucket an
 * entity is in, and a box query walks only the buckets the box touches before
 * the exact containment test. Nothing else is kept: no previous position, no
 * track. Replacing an entry discards the old fix, which is the "never history"
 * rule in code.
 *
 * Every mutation reports the rooms it touched, so the hub can turn a poll into
 * per-room deltas without diffing whole buckets — and says when an entity only
 * MOVED within its room (`move`: nothing but its position, heading, speed,
 * time and place along its track changed), which travels as a compact
 * `LiveMove` instead of the whole entity.
 */

import {
  type GeoBoundingBox,
  type LiveEntity,
  type LiveKind,
  type LiveMove,
  liveTilesFor,
  liveTilesOf,
} from '@goway/contracts';
import { roomKey } from '../hub/rooms';

export { roomKey };

interface Entry {
  entity: LiveEntity;
  /** Its room at each of its levels (`liveRoomZoomsOf`), coarsest first. */
  rooms: string[];
  /** What a client would receive, as text: the change test. */
  signature: string;
  /** The same without what a move carries: equal ones differ only in motion. */
  fixed: string;
}

/** Everything about an entity but its motion, as text. */
function fixedSignature(entity: LiveEntity): string {
  const {
    position: _p,
    headingDegrees: _h,
    speedMetersPerSecond: _s,
    observedAt: _o,
    ...rest
  } = entity;
  if (rest.kind === 'transit' && rest.track) {
    const { alongMeters: _a, offsetMeters: _f, ...track } = rest.track;
    return JSON.stringify({ ...rest, track });
  }
  return JSON.stringify(rest);
}

/** An entity's motion, as a {@link LiveMove}. */
export function moveOf(entity: LiveEntity): LiveMove {
  const track = entity.kind === 'transit' ? entity.track : null;
  return [
    entity.id,
    entity.position.latitude,
    entity.position.longitude,
    entity.headingDegrees,
    entity.speedMetersPerSecond,
    entity.observedAt,
    track ? track.alongMeters : null,
    track ? track.offsetMeters : null,
  ];
}

export type IndexChange =
  /** New, or changed in place. */
  | { type: 'upsert'; room: string; entity: LiveEntity }
  /** Only moved, within the same room: its motion changed and nothing else. */
  | { type: 'move'; room: string; entity: LiveEntity }
  /** Gone from this room — deleted, or moved out (a matching `upsert` names the new room). */
  | { type: 'remove'; room: string; id: string };

export class LiveTileIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly rooms = new Map<string, Set<string>>();
  private readonly sources = new Map<string, Set<string>>();

  get size(): number {
    return this.entries.size;
  }

  get(id: string): LiveEntity | undefined {
    return this.entries.get(id)?.entity;
  }

  /**
   * Insert or replace. Returns the changes — none when nothing a client sees
   * changed — per room: an entity is in one room at each of its kind's
   * levels (`LIVE_ROOM_ZOOMS`), and a subscriber is in one level's rooms.
   */
  upsert(entity: LiveEntity): IndexChange[] {
    const mode = entity.kind === 'transit' ? entity.mode : undefined;
    const rooms = liveTilesOf(entity.position, entity.kind, mode).map((tile) =>
      roomKey(tile, entity.kind),
    );
    const signature = JSON.stringify(entity);
    const existing = this.entries.get(entity.id);
    if (existing && existing.signature === signature) return [];
    const fixed = fixedSignature(entity);
    const onlyMoved = existing !== undefined && existing.fixed === fixed;
    const changes: IndexChange[] = [];
    // Rooms it left — moved out, or no longer at that level (a bus whose
    // static file said "train" a moment ago).
    for (const before of existing?.rooms ?? []) {
      if (rooms.includes(before)) continue;
      this.rooms.get(before)?.delete(entity.id);
      this.dropEmptyRoom(before);
      changes.push({ type: 'remove', room: before, id: entity.id });
    }
    for (const room of rooms) {
      if (onlyMoved && existing?.rooms.includes(room)) {
        changes.push({ type: 'move', room, entity });
        continue;
      }
      let members = this.rooms.get(room);
      if (!members) {
        members = new Set();
        this.rooms.set(room, members);
      }
      members.add(entity.id);
      changes.push({ type: 'upsert', room, entity });
    }
    this.entries.set(entity.id, { entity, rooms, signature, fixed });
    let owned = this.sources.get(entity.sourceId);
    if (!owned) {
      owned = new Set();
      this.sources.set(entity.sourceId, owned);
    }
    owned.add(entity.id);
    return changes;
  }

  remove(id: string): IndexChange[] {
    const existing = this.entries.get(id);
    if (!existing) return [];
    this.entries.delete(id);
    const changes: IndexChange[] = [];
    for (const room of existing.rooms) {
      this.rooms.get(room)?.delete(id);
      this.dropEmptyRoom(room);
      changes.push({ type: 'remove', room, id });
    }
    const owned = this.sources.get(existing.entity.sourceId);
    owned?.delete(id);
    if (owned?.size === 0) this.sources.delete(existing.entity.sourceId);
    return changes;
  }

  /** The ids a source currently has in the index. A copy: safe to mutate while iterating. */
  idsOfSource(sourceId: string): string[] {
    return [...(this.sources.get(sourceId) ?? [])];
  }

  countOfSource(sourceId: string): number {
    return this.sources.get(sourceId)?.size ?? 0;
  }

  /** Every entity in one room. */
  inRoom(tile: string, kind: LiveKind): LiveEntity[] {
    const members = this.rooms.get(roomKey(tile, kind));
    if (!members) return [];
    const out: LiveEntity[] = [];
    for (const id of members) {
      const entry = this.entries.get(id);
      if (entry) out.push(entry.entity);
    }
    return out;
  }

  /**
   * Entities inside a box, of the given kinds. `null` when the box covers more
   * of a kind's rooms than a subscription may (`LIVE_MAX_ROOM_TILES`).
   */
  query(box: GeoBoundingBox, kinds: readonly LiveKind[]): LiveEntity[] | null {
    const out: LiveEntity[] = [];
    for (const kind of kinds) {
      const tiles = liveTilesFor(box, kind);
      if (!tiles) return null;
      for (const tile of tiles) {
        for (const entity of this.inRoom(tile, kind)) {
          if (contains(box, entity.position)) out.push(entity);
        }
      }
    }
    return out;
  }

  /** Every entry, for the age sweep. */
  *all(): IterableIterator<LiveEntity> {
    for (const entry of this.entries.values()) yield entry.entity;
  }

  private dropEmptyRoom(room: string): void {
    if (this.rooms.get(room)?.size === 0) this.rooms.delete(room);
  }
}

export function contains(
  box: GeoBoundingBox,
  point: { latitude: number; longitude: number },
): boolean {
  if (point.latitude < box.south || point.latitude > box.north) return false;
  return box.west <= box.east
    ? point.longitude >= box.west && point.longitude <= box.east
    : point.longitude >= box.west || point.longitude <= box.east;
}
