/**
 * A FIFO queue that runs at most `maxConcurrent` async tasks at a time.
 *
 * WHY THIS EXISTS. The Agents feed pre-warms one snippet per known session as
 * soon as that session registers, and it used to do so with a bare `for` loop
 * firing every peek unawaited. Each peek is a transcript-window fetch whose
 * entries carry full tool inputs and results, bounded only by the protocol's
 * PER-FRAME 4 MiB decoded cap - there is no aggregate bound, so peak
 * allocation scaled linearly with live-session count. Nothing retains the
 * result (the Home tab retains nothing; the window is decoded, scanned for one
 * line, and dropped), so this was never a leak and no leak hunt would have
 * found it. It was peak SIMULTANEOUS TRANSIENT allocation, which is what a
 * foreground jetsam kill on a memory-tight device actually looks like.
 *
 * Bounding concurrency turns that peak from `sessions x frame` into
 * `maxConcurrent x frame` - a constant, independent of how many projects and
 * agents a user has.
 *
 * A task's own rejection is contained here rather than surfaced: a queue whose
 * drain can be stalled by one failing member is worse than no queue. Callers
 * that care about failure attach their own `.catch` inside the task, which is
 * where the context to act on it lives.
 */
export interface BoundedTaskQueue {
  /** Appends a task. Runs immediately if a slot is free, otherwise in turn. */
  enqueue: (task: () => Promise<unknown>) => void;
  /** Drops everything not yet started. In-flight tasks are left to settle. */
  clear: () => void;
  /**
   * Changes the cap on a LIVE queue, so an A/B over queue depth can happen in
   * one process.
   *
   * `.claude/rules/performance-claims-are-measured.md` requires an A/B to be
   * switched at runtime rather than subtracted across two builds, and a release
   * APK embeds its JS bundle, so a per-depth rebuild would compare different
   * installs against different content. Recreating the queue instead of
   * mutating it is the obvious alternative and is wrong: the replacement starts
   * at `activeCount` 0 while the original's tasks are still in flight, so the
   * two together exceed either cap, which is precisely the thing being
   * measured.
   *
   * Raising the cap drains the backlog immediately. Lowering it never cancels
   * anything: in-flight tasks run to completion and the queue narrows as they
   * settle, so `activeCount` can sit above the new cap until it does.
   */
  setMaxConcurrent: (maxConcurrent: number) => void;
  /** Tasks waiting for a slot. */
  readonly pendingCount: number;
  /** Tasks currently running. Never exceeds `maxConcurrent`. */
  readonly activeCount: number;
  /** The live cap. */
  readonly maxConcurrent: number;
}

function assertPositiveInteger(maxConcurrent: number): void {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(`maxConcurrent must be a positive integer, received ${String(maxConcurrent)}`);
  }
}

export function createBoundedTaskQueue(initialMaxConcurrent: number): BoundedTaskQueue {
  assertPositiveInteger(initialMaxConcurrent);

  const pendingTasks: (() => Promise<unknown>)[] = [];
  let maxConcurrent = initialMaxConcurrent;
  let activeCount = 0;

  function drain(): void {
    while (activeCount < maxConcurrent && pendingTasks.length > 0) {
      const task = pendingTasks.shift();
      if (task === undefined) return;
      activeCount += 1;
      // `Promise.resolve().then(task)` rather than calling `task()` directly:
      // a task that throws SYNCHRONOUSLY would otherwise escape past the
      // catch below and leave activeCount stuck one above the truth, which
      // permanently narrows the queue.
      void Promise.resolve()
        .then(task)
        .catch(() => undefined)
        .finally(() => {
          activeCount -= 1;
          drain();
        });
    }
  }

  return {
    enqueue(task: () => Promise<unknown>): void {
      pendingTasks.push(task);
      drain();
    },
    clear(): void {
      pendingTasks.length = 0;
    },
    setMaxConcurrent(nextMaxConcurrent: number): void {
      assertPositiveInteger(nextMaxConcurrent);
      maxConcurrent = nextMaxConcurrent;
      drain();
    },
    get pendingCount(): number {
      return pendingTasks.length;
    },
    get activeCount(): number {
      return activeCount;
    },
    get maxConcurrent(): number {
      return maxConcurrent;
    },
  };
}
