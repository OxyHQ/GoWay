/**
 * Who is watching which room, for any channel.
 *
 * A room is a map tile of one channel kind (`12/2048/1361|transit`,
 * `…|camera`). A watcher is an opaque id (a socket) in a set of rooms. The
 * registry counts watchers per room so a channel can tell what is wanted, and
 * says which rooms a change of watch JOINED and LEFT. It never learns who a
 * watcher is and keeps no viewport: the rooms are all it holds, and they are
 * never logged (docs/MAP_LIVE.md).
 */

export interface Room<K extends string = string> {
  tile: string;
  kind: K;
}

export function roomKey(tile: string, kind: string): string {
  return `${tile}|${kind}`;
}

export function parseRoom<K extends string = string>(key: string): Room<K> {
  const [tile, kind] = key.split('|') as [string, K];
  return { tile, kind };
}

export class RoomRegistry<K extends string = string> {
  /** watcher id → the room keys it is in. */
  private readonly watchers = new Map<string, Set<string>>();
  /** room key → watcher count. */
  private readonly counts = new Map<string, number>();

  /** Set what a watcher is in, replacing what it was in. */
  watch(watcherId: string, rooms: readonly Room<K>[]): { joined: Room<K>[]; left: Room<K>[] } {
    const next = new Set(rooms.map((room) => roomKey(room.tile, room.kind)));
    const previous = this.watchers.get(watcherId) ?? new Set<string>();
    const joined: Room<K>[] = [];
    const left: Room<K>[] = [];
    for (const key of previous) {
      if (next.has(key)) continue;
      this.decrement(key);
      left.push(parseRoom<K>(key));
    }
    for (const room of rooms) {
      const key = roomKey(room.tile, room.kind);
      if (previous.has(key)) continue;
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      joined.push(room);
    }
    if (next.size === 0) this.watchers.delete(watcherId);
    else this.watchers.set(watcherId, next);
    return { joined, left };
  }

  unwatch(watcherId: string): void {
    for (const key of this.watchers.get(watcherId) ?? []) this.decrement(key);
    this.watchers.delete(watcherId);
  }

  /** Whether anybody watches this room key. */
  has(key: string): boolean {
    return this.counts.has(key);
  }

  /** Every watched room key. */
  keys(): IterableIterator<string> {
    return this.counts.keys();
  }

  private decrement(key: string): void {
    const count = (this.counts.get(key) ?? 0) - 1;
    if (count <= 0) this.counts.delete(key);
    else this.counts.set(key, count);
  }
}
