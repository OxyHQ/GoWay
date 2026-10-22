import { describe, expect, it } from 'bun:test';
import { parseRoom, RoomRegistry, roomKey } from '../rooms';

describe('RoomRegistry', () => {
  it('round-trips a room key', () => {
    expect(parseRoom(roomKey('12/1/2', 'camera'))).toEqual({ tile: '12/1/2', kind: 'camera' });
  });

  it('reports what a watch joined and left, replacing the previous set', () => {
    const rooms = new RoomRegistry<'camera' | 'transit'>();
    const a = { tile: '12/1/1', kind: 'camera' as const };
    const b = { tile: '12/1/2', kind: 'camera' as const };
    expect(rooms.watch('w', [a, b])).toEqual({ joined: [a, b], left: [] });
    expect(rooms.watch('w', [b])).toEqual({ joined: [], left: [a] });
    expect(rooms.has(roomKey(a.tile, a.kind))).toBe(false);
    expect(rooms.has(roomKey(b.tile, b.kind))).toBe(true);
  });

  it('counts watchers: a room stays watched until the last one leaves', () => {
    const rooms = new RoomRegistry();
    const room = { tile: '12/1/1', kind: 'camera' };
    rooms.watch('one', [room]);
    rooms.watch('two', [room]);
    rooms.unwatch('one');
    expect([...rooms.keys()]).toEqual([roomKey(room.tile, room.kind)]);
    rooms.unwatch('two');
    expect([...rooms.keys()]).toEqual([]);
  });
});
