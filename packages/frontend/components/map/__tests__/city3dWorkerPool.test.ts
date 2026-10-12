/**
 * The mesh worker pool under failure (PR #126 review): a worker that dies
 * fails its requests (so the engine retries them) and is replaced, and a
 * cancelled request keeps its slot until its worker acknowledges, a late
 * reply to it being discarded.
 */
import { describe, expect, test } from 'bun:test';

import {
  WorkerPool,
  webWorker,
  type WorkerEvents,
} from '@/components/map/engine/city3d/workerPool';

type Message = { id: number; type?: string };

/** A stand-in worker: records what it is sent; the test answers for it. */
class FakeWorker {
  sent: unknown[] = [];
  terminated = false;
  constructor(private readonly events: WorkerEvents<Message>) {}
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: Message) {
    this.events.message(data);
  }
  crash() {
    this.events.error('boom');
  }
}

function pool(size: number) {
  const made: FakeWorker[] = [];
  const replies: Message[] = [];
  const failed: number[] = [];
  const instance = new WorkerPool<Message, Message>(
    (events) => {
      const worker = new FakeWorker(events);
      made.push(worker);
      return worker;
    },
    size,
    (reply) => replies.push(reply),
    (id) => failed.push(id),
  );
  return { instance, made, replies, failed };
}

const holder = (made: FakeWorker[], id: number) =>
  made.find((w) => !w.terminated && w.sent.some((m) => (m as Message).id === id)) as FakeWorker;

describe('WorkerPool', () => {
  test('a worker that dies fails what it held and is replaced', () => {
    const { instance, made, replies, failed } = pool(1);
    instance.send({ id: 1 }, 'a');
    instance.send({ id: 2 }, 'b');
    made[0].crash();
    expect(failed.sort()).toEqual([1, 2]);
    expect(instance.inFlight).toBe(0);
    expect(made[0].terminated).toBe(true);
    expect(made).toHaveLength(2);
    // The replacement works, and the dead one is not listened to.
    instance.send({ id: 3 }, 'c');
    expect(made[1].sent).toEqual([{ id: 3 }]);
    made[0].reply({ id: 3 });
    made[1].reply({ id: 3 });
    expect(replies).toEqual([{ id: 3 }]);
  });

  test('a cancelled request keeps its slot until acknowledged, and its late reply is dropped', () => {
    const { instance, made, replies } = pool(1);
    instance.send({ id: 1 }, 'a');
    instance.cancel(1, { type: 'cancel', id: 1 });
    expect(instance.inFlight).toBe(1);
    holder(made, 1).reply({ type: 'cancelled', id: 1 });
    expect(instance.inFlight).toBe(0);
    expect(replies).toEqual([]);

    instance.send({ id: 2 }, 'a');
    instance.cancel(2, { type: 'cancel', id: 2 });
    // The reply was already on its way: it frees the slot, and is not handed on.
    holder(made, 2).reply({ id: 2 });
    expect(instance.inFlight).toBe(0);
    expect(replies).toEqual([]);
  });

  test('a crash does not report a request that was already cancelled', () => {
    const { instance, made, failed } = pool(1);
    instance.send({ id: 1 }, 'a');
    instance.send({ id: 2 }, 'a');
    instance.cancel(1, { type: 'cancel', id: 1 });
    made[0].crash();
    expect(failed).toEqual([2]);
  });
});

describe('webWorker', () => {
  test("wires a Web Worker's replies and its death to the pool's events", () => {
    const worker = {
      onmessage: null as ((event: MessageEvent<Message>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage() {},
      terminate() {},
    };
    const replies: Message[] = [];
    const errors: string[] = [];
    let prevented = false;
    const wired = webWorker<Message>(worker as unknown as Worker, {
      message: (reply) => replies.push(reply),
      error: (message) => errors.push(message),
    });
    expect(wired).toBe(worker as unknown as Worker);
    worker.onmessage?.({ data: { id: 7 } } as MessageEvent<Message>);
    worker.onerror?.({
      message: '',
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as ErrorEvent);
    expect(replies).toEqual([{ id: 7 }]);
    // An unnamed error still fails the worker, and never reaches the console.
    expect(errors).toEqual(['worker failed']);
    expect(prevented).toBe(true);
  });
});
