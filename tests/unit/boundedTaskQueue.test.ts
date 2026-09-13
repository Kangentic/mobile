import { describe, expect, it } from 'vitest';
import { createBoundedTaskQueue } from '@/lib/boundedTaskQueue';
import { flushMicrotasks, waitUntil } from '../helpers/async';

/**
 * A deferred promise plus the count of how many are outstanding, which is the
 * only thing these tests actually assert on: the bug being pinned is "N tasks
 * ran at once", so the test has to be able to hold tasks open and watch the
 * high-water mark.
 */
function createControllableTask(): { task: () => Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolveTask: () => void = () => undefined;
  let rejectTask: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  return { task: () => promise, resolve: resolveTask, reject: rejectTask };
}

describe('createBoundedTaskQueue', () => {
  it('rejects a concurrency that is not a positive integer', () => {
    expect(() => createBoundedTaskQueue(0)).toThrow(RangeError);
    expect(() => createBoundedTaskQueue(-1)).toThrow(RangeError);
    expect(() => createBoundedTaskQueue(1.5)).toThrow(RangeError);
  });

  it('validates a runtime cap change the same way as the initial one', () => {
    const queue = createBoundedTaskQueue(3);
    expect(() => queue.setMaxConcurrent(0)).toThrow(RangeError);
    expect(() => queue.setMaxConcurrent(2.5)).toThrow(RangeError);
    // The rejected change must not have taken effect.
    expect(queue.maxConcurrent).toBe(3);
  });

  /**
   * The A/B knob. `performance-claims-are-measured.md` requires both arms in
   * ONE process, so the cap has to move on a live queue rather than by building
   * a second APK.
   */
  it('raising the cap drains the backlog immediately', async () => {
    const queue = createBoundedTaskQueue(2);
    const controllables = Array.from({ length: 6 }, () => createControllableTask());
    for (const controllable of controllables) queue.enqueue(controllable.task);
    await flushMicrotasks();
    expect(queue.activeCount).toBe(2);
    expect(queue.pendingCount).toBe(4);

    queue.setMaxConcurrent(5);
    await flushMicrotasks();

    expect(queue.activeCount).toBe(5);
    expect(queue.pendingCount).toBe(1);
  });

  /**
   * Lowering must never cancel work already in flight, so activeCount is
   * allowed to sit ABOVE the new cap until those tasks settle. A queue that
   * enforced the new cap by abandoning in-flight tasks would silently drop
   * snippet warms mid-measurement and make the arm unreadable.
   */
  it('lowering the cap lets in-flight tasks finish and narrows as they settle', async () => {
    const queue = createBoundedTaskQueue(4);
    const controllables = Array.from({ length: 8 }, () => createControllableTask());
    for (const controllable of controllables) queue.enqueue(controllable.task);
    await flushMicrotasks();
    expect(queue.activeCount).toBe(4);

    queue.setMaxConcurrent(1);
    await flushMicrotasks();
    expect(queue.activeCount).toBe(4);

    // Settling all four frees every slot, but only one may be refilled.
    for (const controllable of controllables.slice(0, 4)) controllable.resolve();
    await waitUntil(() => queue.activeCount === 1);
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(3);
  });

  it('never runs more than maxConcurrent tasks at once', async () => {
    const queue = createBoundedTaskQueue(3);
    const controllables = Array.from({ length: 12 }, () => createControllableTask());
    let running = 0;
    let highWaterMark = 0;

    for (const controllable of controllables) {
      queue.enqueue(async () => {
        running += 1;
        highWaterMark = Math.max(highWaterMark, running);
        try {
          await controllable.task();
        } finally {
          running -= 1;
        }
      });
    }

    await waitUntil(() => running === 3, { label: 'first batch started' });
    // The assertion that fails against the unbounded `for` loop this replaced:
    // there, all twelve would be in flight at once.
    expect(highWaterMark).toBe(3);
    expect(queue.activeCount).toBe(3);
    expect(queue.pendingCount).toBe(9);

    for (const controllable of controllables) controllable.resolve();
    await waitUntil(() => queue.pendingCount === 0 && queue.activeCount === 0, { label: 'drained' });
    expect(highWaterMark).toBe(3);
  });

  it('serves every enqueued task, in FIFO order', async () => {
    const queue = createBoundedTaskQueue(2);
    const startOrder: number[] = [];

    for (let index = 0; index < 8; index += 1) {
      queue.enqueue(async () => {
        startOrder.push(index);
        await Promise.resolve();
      });
    }

    await waitUntil(() => startOrder.length === 8, { label: 'all served' });
    expect(startOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps draining when a task rejects', async () => {
    const queue = createBoundedTaskQueue(1);
    const served: string[] = [];

    queue.enqueue(async () => {
      served.push('first');
      throw new Error('boom');
    });
    queue.enqueue(async () => {
      served.push('second');
    });

    await waitUntil(() => served.length === 2, { label: 'drained past the rejection' });
    expect(served).toEqual(['first', 'second']);
    expect(queue.activeCount).toBe(0);
  });

  it('keeps draining when a task throws synchronously', async () => {
    const queue = createBoundedTaskQueue(1);
    const served: string[] = [];

    queue.enqueue((): Promise<unknown> => {
      served.push('first');
      throw new Error('synchronous boom');
    });
    queue.enqueue(async () => {
      served.push('second');
    });

    await waitUntil(() => served.length === 2, { label: 'drained past the synchronous throw' });
    expect(queue.activeCount).toBe(0);
  });

  it('clear() drops queued work without disturbing what is already running', async () => {
    const queue = createBoundedTaskQueue(1);
    const held = createControllableTask();
    const served: string[] = [];

    queue.enqueue(async () => {
      served.push('running');
      await held.task();
    });
    queue.enqueue(async () => {
      served.push('dropped');
    });

    await waitUntil(() => queue.activeCount === 1, { label: 'first task started' });
    queue.clear();
    expect(queue.pendingCount).toBe(0);

    held.resolve();
    await flushMicrotasks();
    await waitUntil(() => queue.activeCount === 0, { label: 'in-flight task settled' });
    expect(served).toEqual(['running']);
  });
});
