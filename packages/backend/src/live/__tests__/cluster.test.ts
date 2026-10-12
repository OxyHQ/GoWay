/**
 * GoWay Live across several API tasks (`cluster.ts`): one poller per source,
 * every task serving its own sockets, leader failover, a joining task brought
 * up to date, and polling locally while the bus is down.
 *
 * In-memory "Valkey" for the logic; a REAL Valkey (or Redis) when
 * `TEST_VALKEY_URL` is set — CI runs one, as it runs Postgres.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { type LiveDelta, type LiveEntity, liveTileOf } from '@goway/contracts';
import {
  decodeMessage,
  encodeMessage,
  type LiveBus,
  MemoryLiveNetwork,
  ValkeyLiveBus,
} from '../cluster';
import { LiveHub } from '../hub';
import type { LivePollResult, LiveSourceDefinition } from '../types';

const T0 = Date.parse('2026-10-12T12:00:00Z');
const BARCELONA = { latitude: 41.39, longitude: 2.17 };
const ROOM = { tile: liveTileOf(BARCELONA, 'transit'), kind: 'transit' as const };

function bus(id: string, observedAt: number, longitude = 2.17): LiveEntity {
  return {
    kind: 'transit',
    id: `test-bus:${id}`,
    sourceId: 'test-bus',
    position: { latitude: 41.39, longitude },
    headingDegrees: 90,
    speedMetersPerSecond: 8,
    observedAt: new Date(observedAt).toISOString(),
    mode: 'bus',
    operator: 'Test',
    line: 'V15',
    headsign: null,
    vehicleLabel: null,
    lineColor: '#FF0000',
    lineTextColor: '#FFFFFF',
    track: null,
    trackStatus: 'unknown',
    positionBasis: 'reported',
  };
}

interface Task {
  hub: LiveHub;
  polls: number;
  deltas: LiveDelta[];
}

/** A task: a hub on its own bus, with a fake feed that answers `answer()`. */
function task(
  liveBus: LiveBus,
  now: () => number,
  answer: () => LivePollResult,
  cluster?: { leaseMs?: number; demandTtlMs?: number },
): Task {
  const out: Task = { hub: null as unknown as LiveHub, polls: 0, deltas: [] };
  const definition: LiveSourceDefinition = {
    id: 'test-bus',
    kind: 'transit',
    name: 'Test buses',
    attribution: { label: 'Test', href: 'https://example.org' },
    licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
    coverage: { west: 1.9, south: 41.2, east: 2.4, north: 41.6 },
    completeness: 'network',
    defaultUrl: 'https://example.org/feed',
    requiresKey: false,
    pollIntervalSeconds: 10,
    staleAfterSeconds: 60,
    dropAfterSeconds: 120,
    create: () => ({
      poll: async () => {
        out.polls++;
        return answer();
      },
    }),
  };
  out.hub = new LiveHub({
    sources: [
      {
        definition,
        settings: { url: definition.defaultUrl, userAgent: 'test', maxRegionsPerPoll: 1 },
      },
    ],
    fetch: async () => {
      throw new Error('the adapter is faked');
    },
    now,
    random: () => 0.5,
    bus: liveBus,
    publish: (delta) => out.deltas.push(delta),
    ...(cluster ? { cluster } : {}),
  });
  return out;
}

describe('the Valkey bus subscription', () => {
  /** A connection whose (re)connects the test drives. */
  const fakeConnection = () => {
    const connection = {
      onconnect: null as (() => void) | null,
      subscribed: 0,
      closed: false,
      async send() {
        return null;
      },
      async publish() {
        return 0;
      },
      async subscribe() {
        connection.onconnect?.();
        connection.subscribed++;
        return 1;
      },
      close() {
        connection.closed = true;
      },
    };
    return connection;
  };

  it('counts as lost after its connection reconnects, and resubscribes on a fresh one', async () => {
    const made: ReturnType<typeof fakeConnection>[] = [];
    const liveBus = new ValkeyLiveBus(fakeConnection(), () => {
      const connection = fakeConnection();
      made.push(connection);
      return connection;
    });
    expect(liveBus.isSubscribed()).toBe(false);
    await liveBus.subscribe(() => {});
    expect(liveBus.isSubscribed()).toBe(true);
    // Valkey restarted: the client reconnected by itself, without its subscription.
    made[0]?.onconnect?.();
    expect(liveBus.isSubscribed()).toBe(false);
    await liveBus.subscribe(() => {});
    expect(liveBus.isSubscribed()).toBe(true);
    expect(made).toHaveLength(2);
    expect(made[0]?.closed).toBe(true);
    await liveBus.close();
    expect(made[1]?.closed).toBe(true);
    expect(liveBus.isSubscribed()).toBe(false);
  });
});

describe('the bus wire format', () => {
  it('round-trips a message, compressed, and refuses junk', () => {
    const message = {
      type: 'poll' as const,
      from: 'a',
      sourceId: 'test-bus',
      entities: Array.from({ length: 200 }, (_, i) => bus(String(i), T0)),
      lastSuccessAt: T0,
    };
    const text = encodeMessage(message);
    expect(decodeMessage(text)).toEqual(message);
    // 200 buses of near-identical JSON compress well: the bus carries a fraction.
    expect(text.length).toBeLessThan(JSON.stringify(message).length / 5);
    expect(decodeMessage('not base64 gzip')).toBeNull();
    expect(decodeMessage(Buffer.from('{}').toString('base64'))).toBeNull();
  });
});

describe('several tasks on one bus (in memory)', () => {
  const setup = () => {
    const clock = { now: T0 };
    const network = new MemoryLiveNetwork(() => clock.now);
    let fleet = [bus('1', T0)];
    const answer = (): LivePollResult => ({ entities: fleet, rejected: 0 });
    const tasks = ['a', 'b', 'c'].map((id) =>
      task(network.bus(id), () => clock.now, answer, { leaseMs: 15_000, demandTtlMs: 10_000 }),
    );
    const everyone = async (step: (t: Task) => Promise<void>) => {
      for (const t of tasks) await step(t);
    };
    return {
      clock,
      network,
      tasks,
      everyone,
      setFleet: (next: LiveEntity[]) => {
        fleet = next;
      },
    };
  };

  it('polls once for the whole fleet, and every task serves what the leader got', async () => {
    const { tasks, everyone } = setup();
    const [a, b, c] = tasks as [Task, Task, Task];
    await everyone((t) => t.hub.connect());
    // Only task c has a viewer.
    c.hub.watch('viewer', [ROOM]);
    await everyone((t) => t.hub.coordinate());
    await everyone((t) => t.hub.coordinate());
    expect(tasks.filter((t) => t.hub.isLeader('test-bus'))).toHaveLength(1);
    await everyone((t) => t.hub.tick());
    // One upstream request, from whichever task holds the lease.
    expect(a.polls + b.polls + c.polls).toBe(1);
    // Every task holds the answer; c's viewer got the delta.
    for (const t of tasks) expect(t.hub.snapshot(ROOM.tile, 'transit').entities).toHaveLength(1);
    expect(c.deltas.at(-1)?.upserts.map((e) => e.id)).toEqual(['test-bus:1']);
    // Nobody else had a viewer: nothing published to their sockets.
    expect(a.deltas).toEqual([]);
    expect(b.deltas).toEqual([]);
  });

  it('a new leader takes over when the old one dies, and polls at once', async () => {
    const { clock, tasks, everyone } = setup();
    await everyone((t) => t.hub.connect());
    for (const t of tasks) t.hub.watch('viewer', [ROOM]);
    await everyone((t) => t.hub.coordinate());
    const leader = tasks.find((t) => t.hub.isLeader('test-bus')) as Task;
    await everyone((t) => t.hub.tick());
    expect(leader.polls).toBe(1);
    // The leader dies: no release, no renewal. The others keep coordinating.
    const survivors = tasks.filter((t) => t !== leader);
    clock.now += 5_000;
    for (const t of survivors) await t.hub.coordinate();
    expect(survivors.some((t) => t.hub.isLeader('test-bus'))).toBe(false); // lease still held
    clock.now += 11_000; // past the 15 s lease
    for (const t of survivors) await t.hub.coordinate();
    const next = survivors.filter((t) => t.hub.isLeader('test-bus'));
    expect(next).toHaveLength(1);
    for (const t of survivors) await t.hub.tick();
    expect((next[0] as Task).polls).toBe(1);
    expect(survivors.reduce((sum, t) => sum + t.polls, 0)).toBe(1);
  });

  it('a task that joins later is brought up to date by the leader', async () => {
    const { clock, network, tasks, everyone } = setup();
    await everyone((t) => t.hub.connect());
    (tasks[0] as Task).hub.watch('viewer', [ROOM]);
    await everyone((t) => t.hub.coordinate());
    await everyone((t) => t.hub.tick());
    const late = task(
      network.bus('d'),
      () => clock.now,
      () => ({ entities: [], rejected: 0 }),
    );
    expect(late.hub.snapshot(ROOM.tile, 'transit').entities).toHaveLength(0);
    await late.hub.connect(); // subscribes, then asks for a sync
    expect(late.hub.snapshot(ROOM.tile, 'transit').entities.map((e) => e.id)).toEqual([
      'test-bus:1',
    ]);
    expect(late.polls).toBe(0);
  });

  it('polls locally while the bus is down, and shares again when it is back', async () => {
    const { network, tasks, everyone } = setup();
    await everyone((t) => t.hub.connect());
    for (const t of tasks) t.hub.watch('viewer', [ROOM]);
    await everyone((t) => t.hub.coordinate());
    network.up = false;
    await everyone((t) => t.hub.coordinate());
    await everyone((t) => t.hub.tick());
    // Duplicate requests, but live keeps working everywhere.
    expect(tasks.every((t) => t.polls === 1)).toBe(true);
    network.up = true;
    await everyone((t) => t.hub.coordinate());
    expect(tasks.filter((t) => t.hub.isLeader('test-bus'))).toHaveLength(1);
  });

  it('a follower that could not subscribe hears the leader once the bus is back', async () => {
    const { network, tasks, everyone } = setup();
    const [a, b] = tasks as [Task, Task, Task];
    // Valkey is away when every task starts: nobody subscribes.
    network.disconnect();
    await everyone((t) => t.hub.connect());
    a.hub.watch('viewer', [ROOM]);
    b.hub.watch('viewer', [ROOM]);
    network.up = true;
    // a first, so a takes the lease; b follows.
    await a.hub.coordinate();
    await b.hub.coordinate();
    expect(a.hub.isLeader('test-bus')).toBe(true);
    expect(b.hub.isLeader('test-bus')).toBe(false);
    await a.hub.tick();
    await b.hub.tick();
    expect(b.polls).toBe(0);
    // b stopped polling, so it must be listening: the leader's answer reached it.
    expect(b.hub.snapshot(ROOM.tile, 'transit').entities.map((e) => e.id)).toEqual(['test-bus:1']);
  });

  it('a subscription lost with its connection is restored, and the follower catches up', async () => {
    const { clock, network, tasks, everyone, setFleet } = setup();
    const [a, b] = tasks as [Task, Task, Task];
    await everyone((t) => t.hub.connect());
    a.hub.watch('viewer', [ROOM]);
    b.hub.watch('viewer', [ROOM]);
    await a.hub.coordinate();
    await b.hub.coordinate();
    await a.hub.tick();
    // Valkey restarts: connections drop and come back without their subscriptions.
    network.disconnect();
    network.up = true;
    await a.hub.coordinate();
    await b.hub.coordinate();
    setFleet([bus('1', T0 + 10_000), bus('2', T0 + 10_000, 2.18)]);
    clock.now += 10_000;
    await a.hub.tick();
    expect(
      b.hub
        .snapshot(ROOM.tile, 'transit')
        .entities.map((e) => e.id)
        .sort(),
    ).toEqual(['test-bus:1', 'test-bus:2']);
  });

  it('stopping during an outage still closes the bus', async () => {
    const { network, tasks, everyone } = setup();
    const a = tasks[0] as Task;
    await everyone((t) => t.hub.connect());
    a.hub.watch('viewer', [ROOM]);
    network.up = false;
    await a.hub.coordinate(); // the bus is down: a polls locally
    a.hub.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(network.closed.has('a')).toBe(true);
  });

  it('sends a vehicle that only moved as a compact move, not the whole entity', async () => {
    const { clock, tasks, everyone, setFleet } = setup();
    await everyone((t) => t.hub.connect());
    for (const t of tasks) t.hub.watch('viewer', [ROOM]);
    await everyone((t) => t.hub.coordinate());
    await everyone((t) => t.hub.tick());
    setFleet([bus('1', T0 + 10_000, 2.171)]);
    clock.now += 10_000;
    await everyone((t) => t.hub.tick());
    for (const t of tasks) {
      const last = t.deltas.at(-1);
      expect(last?.upserts).toEqual([]);
      expect(last?.moves).toEqual([
        ['test-bus:1', 41.39, 2.171, 90, 8, new Date(T0 + 10_000).toISOString(), null, null],
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// A real Valkey
// ---------------------------------------------------------------------------

const VALKEY = process.env.TEST_VALKEY_URL;
const opened: LiveBus[] = [];
afterAll(async () => {
  for (const b of opened) await b.close().catch(() => {});
});

describe.if(Boolean(VALKEY))('several tasks on a real Valkey', () => {
  const prefix = `goway:live:test:${crypto.randomUUID().slice(0, 8)}`;
  const open = (id: string) => {
    const b = ValkeyLiveBus.fromUrl(VALKEY as string, `${prefix}`);
    Object.defineProperty(b, 'taskId', { value: id });
    opened.push(b);
    return b;
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('one poller, fan-out to every task, failover after the lease', async () => {
    const answer = (): LivePollResult => ({ entities: [bus('1', Date.now())], rejected: 0 });
    const timings = { leaseMs: 800, demandTtlMs: 2_000 };
    const tasks = ['x', 'y', 'z'].map((id) => task(open(id), Date.now, answer, timings));
    for (const t of tasks) await t.hub.connect();
    (tasks[2] as Task).hub.watch('viewer', [ROOM]);
    for (let round = 0; round < 2; round++) for (const t of tasks) await t.hub.coordinate();
    const leaders = tasks.filter((t) => t.hub.isLeader('test-bus'));
    expect(leaders).toHaveLength(1);
    for (const t of tasks) await t.hub.tick();
    await sleep(150); // pub/sub delivery
    expect(tasks.reduce((sum, t) => sum + t.polls, 0)).toBe(1);
    for (const t of tasks) expect(t.hub.snapshot(ROOM.tile, 'transit').entities).toHaveLength(1);

    // The leader crashes: its connections close without releasing the lease.
    const leader = leaders[0] as Task;
    const survivors = tasks.filter((t) => t !== leader);
    await (
      opened.find((b) => b.taskId === ['x', 'y', 'z'][tasks.indexOf(leader)]) as LiveBus
    ).close();
    await sleep(timings.leaseMs + 200);
    for (const t of survivors) await t.hub.coordinate();
    const next = survivors.filter((t) => t.hub.isLeader('test-bus'));
    expect(next).toHaveLength(1);
    for (const t of survivors) await t.hub.tick();
    expect((next[0] as Task).polls).toBe(1);
    await sleep(150);
    for (const t of survivors)
      expect(t.hub.snapshot(ROOM.tile, 'transit').entities).toHaveLength(1);
  });
});
