/**
 * The mesh worker pool under failure (PR #126 review): a worker that dies
 * fails its requests (so the engine retries them) and is replaced, and a
 * cancelled request keeps its slot until its worker acknowledges, a late
 * reply to it being discarded.
 */
import { describe, expect, test } from 'bun:test';

import { WorkerPool } from '@/components/map/engine/city3d/workerPool';

type Message = { id: number; type?: string };

/** A stand-in Worker: records what it is sent; the test answers for it. */
class FakeWorker {
  sent: unknown[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<Message>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: Message) {
    this.onmessage?.({ data } as MessageEvent<Message>);
  }
  crash() {
    this.onerror?.({ message: 'boom', preventDefault() {} } as unknown as ErrorEvent);
  }
}

function pool(size: number) {
  const made: FakeWorker[] = [];
  const replies: Message[] = [];
  const failed: number[] = [];
  const instance = new WorkerPool<Message, Message>(
    () => {
      const worker = new FakeWorker();
      made.push(worker);
      return worker as unknown as Worker;
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
