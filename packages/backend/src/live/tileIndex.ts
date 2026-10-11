/**
 * The in-memory spatial index of live entities: the latest fix per entity,
 * bucketed by room — a `LIVE_ROOM_ZOOM` web-mercator tile and a kind.
 *
 * Rooms ARE the spatial index. A subscription is answered from the buckets of
 * the tiles it covers (`liveTilesFor`), a delta is addressed to the bucket an
 * entity is in, and a box query walks only the buckets the box touches before
 * the exact containment test. Nothing else is kept: no previous position, no
 * track. Replacing an entry discards the old fix, which is the "never history"
 * rule in code.
 *
 * Every mutation reports the rooms it touched, so the hub can turn a poll into
 * per-room deltas without diffing whole buckets.
 */

import {
  type GeoBoundingBox,
  type LiveEntity,
  type LiveKind,
  liveTileOf,
  liveTilesFor,
} from '@goway/contracts';

export function roomKey(tile: string, kind: LiveKind): string {
  return `${tile}|${kind}`;
}

interface Entry {
  entity: LiveEntity;
  room: string;
  /** What a client would receive, as text: the change test. */
  signature: string;
}

export type IndexChange =
  /** New, or changed in place. */
  | { type: 'upsert'; room: string; entity: LiveEntity }
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

  /** Insert or replace. Returns the changes — none when nothing a client sees changed. */
  upsert(entity: LiveEntity): IndexChange[] {
    const room = roomKey(liveTileOf(entity.position), entity.kind);
    const signature = JSON.stringify(entity);
    const existing = this.entries.get(entity.id);
    if (existing && existing.signature === signature) return [];
    const changes: IndexChange[] = [];
    if (existing && existing.room !== room) {
      this.rooms.get(existing.room)?.delete(entity.id);
      this.dropEmptyRoom(existing.room);
      changes.push({ type: 'remove', room: existing.room, id: entity.id });
    }
    this.entries.set(entity.id, { entity, room, signature });
    let members = this.rooms.get(room);
    if (!members) {
      members = new Set();
      this.rooms.set(room, members);
    }
    members.add(entity.id);
    let owned = this.sources.get(entity.sourceId);
    if (!owned) {
      owned = new Set();
      this.sources.set(entity.sourceId, owned);
    }
    owned.add(entity.id);
    changes.push({ type: 'upsert', room, entity });
    return changes;
  }

  remove(id: string): IndexChange[] {
    const existing = this.entries.get(id);
    if (!existing) return [];
    this.entries.delete(id);
    this.rooms.get(existing.room)?.delete(id);
    this.dropEmptyRoom(existing.room);
    const owned = this.sources.get(existing.entity.sourceId);
    owned?.delete(id);
    if (owned?.size === 0) this.sources.delete(existing.entity.sourceId);
    return [{ type: 'remove', room: existing.room, id }];
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
   * rooms than a subscription may (`LIVE_MAX_ROOM_TILES`).
   */
  query(box: GeoBoundingBox, kinds: readonly LiveKind[]): LiveEntity[] | null {
    const tiles = liveTilesFor(box);
    if (!tiles) return null;
    const out: LiveEntity[] = [];
    for (const tile of tiles) {
      for (const kind of kinds) {
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
