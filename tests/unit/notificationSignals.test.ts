/**
 * The pure meeting point between the screens, the two display paths and the
 * stale-notification reconciler. Every other suite reaches it only through a
 * consumer, so the contracts the consumers lean on are pinned here directly:
 * a surface is ref-counted (two mounts of one screen, or the outgoing and
 * incoming screen across a replace, must not close each other's claim), a
 * release is idempotent, only an OPEN notifies, and a listener that throws
 * never reaches the screen's focus effect or the display path that called it.
 *
 * The registry is module state, so each test loads a fresh copy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRouting } from '@/notifications/notificationRouting';

type Signals = typeof import('@/notifications/notificationSignals');

let signals: Signals;

beforeEach(async () => {
  vi.resetModules();
  signals = await import('@/notifications/notificationSignals');
});

function routing(overrides: Partial<NotificationRouting> = {}): NotificationRouting {
  return { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, ...overrides };
}

describe('open surfaces', () => {
  it('lists an open surface until its release runs', () => {
    const release = signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });

    expect(signals.getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);

    release();

    expect(signals.getOpenNotificationSurfaces()).toEqual([]);
  });

  /**
   * Mutation that reddens this: drop the holder count (delete the entry on the
   * first release). Seen red that way: the second mount's claim vanished.
   */
  it('keeps a surface open until every holder of it has released', () => {
    const releaseFirst = signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });
    const releaseSecond = signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });

    expect(signals.getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);

    releaseFirst();

    expect(signals.getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);

    releaseSecond();

    expect(signals.getOpenNotificationSurfaces()).toEqual([]);
  });

  /**
   * A focus-effect cleanup can run twice (a StrictMode double invoke, a blur
   * followed by an unmount). If each run decremented, one holder would close the
   * surface another still shows.
   *
   * Mutation that reddens this: remove the `released` guard.
   */
  it('counts a release once however many times it runs', () => {
    const releaseFirst = signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });
    signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });

    releaseFirst();
    releaseFirst();
    releaseFirst();

    expect(signals.getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);
  });

  /**
   * One id string can be a task id, a Command Terminal's session id and a
   * project id at once in a test fixture, and a real collision would let one
   * screen's release close another kind's claim.
   *
   * Mutation that reddens this: build the key from the id alone, without the kind.
   */
  it('keeps surfaces of different kinds apart even when they share an id', () => {
    const releaseTask = signals.openNotificationSurface({ kind: 'task', taskId: 'same-id' });
    signals.openNotificationSurface({ kind: 'command-terminal', sessionId: 'same-id' });
    signals.openNotificationSurface({ kind: 'project-board', projectId: 'same-id' });

    expect(signals.getOpenNotificationSurfaces()).toHaveLength(3);

    releaseTask();

    expect(signals.getOpenNotificationSurfaces()).toEqual([
      { kind: 'command-terminal', sessionId: 'same-id' },
      { kind: 'project-board', projectId: 'same-id' },
    ]);
  });

  it('keeps two different surfaces of one kind apart', () => {
    const releaseFirst = signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });
    signals.openNotificationSurface({ kind: 'task', taskId: 'task-2' });

    releaseFirst();

    expect(signals.getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-2' }]);
  });

  it('reopens cleanly after a full release', () => {
    signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' })();
    signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });

    expect(signals.getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);
  });
});

describe('surface opened listeners', () => {
  it('notify on every open, including a second holder of the same surface', () => {
    const opened: unknown[] = [];
    signals.subscribeToOpenedNotificationSurfaces((surface) => opened.push(surface));

    signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });
    signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });

    expect(opened).toEqual([
      { kind: 'task', taskId: 'task-1' },
      { kind: 'task', taskId: 'task-1' },
    ]);
  });

  it('never notify on a close, because a close can never make an alert stale', () => {
    const opened: unknown[] = [];
    const release = signals.openNotificationSurface({ kind: 'project-board', projectId: 'project-1' });
    signals.subscribeToOpenedNotificationSurfaces((surface) => opened.push(surface));

    release();

    expect(opened).toEqual([]);
  });

  it('stop notifying once unsubscribed, and leave the other listeners alone', () => {
    const removed: unknown[] = [];
    const kept: unknown[] = [];
    const unsubscribe = signals.subscribeToOpenedNotificationSurfaces((surface) => removed.push(surface));
    signals.subscribeToOpenedNotificationSurfaces((surface) => kept.push(surface));

    unsubscribe();
    signals.openNotificationSurface({ kind: 'command-terminal', sessionId: 'terminal-1' });

    expect(removed).toEqual([]);
    expect(kept).toEqual([{ kind: 'command-terminal', sessionId: 'terminal-1' }]);
  });

  /**
   * The caller is a screen's focus effect. A reconciler that throws must not
   * fail the screen, nor stop the listeners after it, and the surface must still
   * be registered (and releasable).
   *
   * Mutation that reddens this: remove the try/catch in notifyEach.
   */
  it('never let a throwing listener reach the caller, nor starve the listeners after it', () => {
    const reached: unknown[] = [];
    signals.subscribeToOpenedNotificationSurfaces(() => {
      throw new Error('listener failed');
    });
    signals.subscribeToOpenedNotificationSurfaces((surface) => reached.push(surface));

    let release: () => void = () => undefined;
    expect(() => {
      release = signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });
    }).not.toThrow();

    expect(reached).toEqual([{ kind: 'task', taskId: 'task-1' }]);
    expect(signals.getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);

    release();

    expect(signals.getOpenNotificationSurfaces()).toEqual([]);
  });
});

describe('displayed notifications', () => {
  it('hand the note to every subscriber, unchanged', () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    signals.subscribeToDisplayedNotifications((note) => first.push(note));
    signals.subscribeToDisplayedNotifications((note) => second.push(note));
    const note = { platformId: 'kangentic:input-required:session:sess-1', routing: routing(), postedAt: 1_700_000_000_000, promptIdAtPost: 'prompt-1' };

    signals.noteNotificationDisplayed(note);

    expect(first).toEqual([note]);
    expect(second).toEqual([note]);
  });

  it('stop delivering once unsubscribed', () => {
    const received: unknown[] = [];
    const unsubscribe = signals.subscribeToDisplayedNotifications((note) => received.push(note));

    unsubscribe();
    signals.noteNotificationDisplayed({ platformId: 'id-1', routing: null, postedAt: 1, promptIdAtPost: null });

    expect(received).toEqual([]);
  });

  /**
   * The callers are the local notifier's `.then` and the headless push task,
   * where a throw would turn a posted alert into a reported display failure.
   *
   * Mutation that reddens this: remove the try/catch in notifyEach.
   */
  it('never let a throwing subscriber reach the display path, nor starve the subscribers after it', () => {
    const reached: unknown[] = [];
    signals.subscribeToDisplayedNotifications(() => {
      throw new Error('subscriber failed');
    });
    signals.subscribeToDisplayedNotifications((note) => reached.push(note));

    expect(() => signals.noteNotificationDisplayed({ platformId: 'id-1', routing: null, postedAt: 5, promptIdAtPost: null })).not.toThrow();

    expect(reached).toHaveLength(1);
  });
});

describe('notification dismissals', () => {
  it('hand the dismissed routing to every subscriber', () => {
    const first: NotificationRouting[] = [];
    const second: NotificationRouting[] = [];
    signals.subscribeToNotificationDismissals((dismissed) => first.push(dismissed));
    signals.subscribeToNotificationDismissals((dismissed) => second.push(dismissed));
    const dismissed = routing({ category: 'turn-complete', sessionId: 'sess-7' });

    signals.publishNotificationDismissed(dismissed);

    expect(first).toEqual([dismissed]);
    expect(second).toEqual([dismissed]);
  });

  it('stop delivering once unsubscribed', () => {
    const received: NotificationRouting[] = [];
    const unsubscribe = signals.subscribeToNotificationDismissals((dismissed) => received.push(dismissed));

    unsubscribe();
    signals.publishNotificationDismissed(routing());

    expect(received).toEqual([]);
  });

  /**
   * The publisher is the reconciler's pass, which publishes BEFORE it cancels.
   * A throwing cooldown release must not stop the cancels that follow it.
   *
   * Mutation that reddens this: remove the try/catch in notifyEach.
   */
  it('never let a throwing subscriber reach the reconciler, nor starve the subscribers after it', () => {
    const reached: NotificationRouting[] = [];
    signals.subscribeToNotificationDismissals(() => {
      throw new Error('subscriber failed');
    });
    signals.subscribeToNotificationDismissals((dismissed) => reached.push(dismissed));

    expect(() => signals.publishNotificationDismissed(routing())).not.toThrow();

    expect(reached).toEqual([routing()]);
  });

  it('keep the three channels independent', () => {
    const opened: unknown[] = [];
    const displayed: unknown[] = [];
    const dismissed: unknown[] = [];
    signals.subscribeToOpenedNotificationSurfaces((surface) => opened.push(surface));
    signals.subscribeToDisplayedNotifications((note) => displayed.push(note));
    signals.subscribeToNotificationDismissals((value) => dismissed.push(value));

    signals.publishNotificationDismissed(routing());

    expect(opened).toEqual([]);
    expect(displayed).toEqual([]);
    expect(dismissed).toHaveLength(1);
  });
});
