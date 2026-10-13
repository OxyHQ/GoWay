/**
 * `installSchedulerYield` (`lib/platform/schedulerYield.ts`): the native API
 * untouched; the spec authors' polyfill where the web lacks it; on Hermes a
 * `yield()` on React Native's one real macrotask, `requestIdleCallback`.
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { installSchedulerYield } from '@/lib/platform/schedulerYield';

type Scope = Parameters<typeof installSchedulerYield>[0] & object;
const scope = globalThis as Record<string, unknown>;

describe('installSchedulerYield', () => {
  test('a native scheduler.yield is left alone (Chrome, Edge, Firefox)', async () => {
    const native = { yield: () => Promise.resolve() };
    const target: Scope = { scheduler: native };
    await installSchedulerYield(target);
    expect(target.scheduler).toBe(native);
  });

  test('on Hermes (no MessageChannel): yield() is a requestIdleCallback task', async () => {
    const channel = scope.MessageChannel;
    const idle = scope.requestIdleCallback;
    const asked: Array<() => void> = [];
    scope.MessageChannel = undefined;
    scope.requestIdleCallback = (callback: () => void) => {
      asked.push(callback);
      return asked.length;
    };
    try {
      const target: Scope = {};
      await installSchedulerYield(target);
      let resumed = false;
      const yielded = target.scheduler?.yield?.().then(() => {
        resumed = true;
      });
      // Not a microtask: nothing resumes until the runtime runs the task.
      await Promise.resolve();
      expect(resumed).toBe(false);
      expect(asked).toHaveLength(1);
      asked[0]();
      await yielded;
      expect(resumed).toBe(true);
    } finally {
      scope.MessageChannel = channel;
      scope.requestIdleCallback = idle;
    }
  });

  test('on the web without it (Safari): the official polyfill, on the global three reads', async () => {
    expect(scope.scheduler).toBeUndefined();
    await installSchedulerYield();
    // three's own test (`yieldToMain` in three's utils.js).
    const self = globalThis as { scheduler?: { yield?: () => Promise<void>; postTask?: unknown } };
    expect(typeof self.scheduler?.yield).toBe('function');
    expect(typeof self.scheduler?.postTask).toBe('function');
    await self.scheduler?.yield?.();
  });

  afterAll(() => {
    // The polyfill installs onto the global: leave the next test file a bare one.
    delete scope.scheduler;
    delete scope.TaskController;
    delete scope.TaskPriorityChangeEvent;
  });
});
