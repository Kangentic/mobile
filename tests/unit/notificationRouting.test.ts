/**
 * The shared read of a notification's routing, its stable id, and its posting
 * time. The id is what makes a repeat alert REPLACE the one on screen, so its
 * key has to be the narrowest thing the alert names and must include the
 * category (one session can owe "needs your input" and "went idle" at once).
 */
import { describe, expect, it } from 'vitest';
import {
  notificationIdForRouting,
  readPostedAt,
  routingFromNotificationData,
  routingNamesAnything,
  type NotificationRouting,
} from '@/notifications/notificationRouting';

function routing(overrides: Partial<NotificationRouting> = {}): NotificationRouting {
  return { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, ...overrides };
}

describe('routingFromNotificationData', () => {
  it('reads every field with the protocol guards, dropping values this build does not know', () => {
    expect(
      routingFromNotificationData({
        category: 'workflow-complete',
        taskId: '',
        projectId: 'project-1',
        sessionId: '',
        sessionKind: 'command-terminal',
      }),
    ).toEqual({ category: 'workflow-complete', taskId: '', projectId: 'project-1', sessionId: '', sessionKind: 'command-terminal' });
    expect(routingFromNotificationData({ category: 'not-a-category', sessionKind: 'not-a-kind', taskId: 7 })).toEqual({
      category: null,
      taskId: '',
      projectId: '',
      sessionId: '',
      sessionKind: null,
    });
  });

  it('is null for anything that is not a record (the placeholder posts no data)', () => {
    expect(routingFromNotificationData(undefined)).toBeNull();
    expect(routingFromNotificationData(null)).toBeNull();
    expect(routingFromNotificationData('blob')).toBeNull();
    expect(routingFromNotificationData([])).toBeNull();
  });

  it('tells a routing that names something from an empty one', () => {
    expect(routingNamesAnything(routing())).toBe(true);
    expect(routingNamesAnything(routing({ taskId: '', sessionId: '' }))).toBe(true);
    expect(routingNamesAnything(routing({ taskId: '', sessionId: '', projectId: '' }))).toBe(false);
  });
});

describe('notificationIdForRouting', () => {
  it('keys on the category and the session when there is one', () => {
    expect(notificationIdForRouting(routing())).toBe('kangentic:input-required:session:sess-1');
    expect(notificationIdForRouting(routing({ category: 'turn-complete' }))).toBe('kangentic:turn-complete:session:sess-1');
  });

  it('falls back to the task, then the project', () => {
    expect(notificationIdForRouting(routing({ category: 'spawn-stalled', sessionId: '' }))).toBe('kangentic:spawn-stalled:task:task-1');
    expect(notificationIdForRouting(routing({ category: 'workflow-complete', sessionId: '', taskId: '' }))).toBe(
      'kangentic:workflow-complete:project:project-1',
    );
  });

  it('gives no id to an alert with no category or nothing to key on', () => {
    expect(notificationIdForRouting(routing({ category: null }))).toBeNull();
    expect(notificationIdForRouting(routing({ sessionId: '', taskId: '', projectId: '' }))).toBeNull();
  });

  it('never collides with the keepalive connection notification', () => {
    expect(notificationIdForRouting(routing({ sessionId: 'kangentic-connection' }))).not.toBe('kangentic-connection');
  });
});

describe('readPostedAt', () => {
  it('prefers the posting time the app stamped into data', () => {
    expect(readPostedAt({ postedAt: '1700000000000' }, '1600000000000')).toBe(1_700_000_000_000);
  });

  it('falls back to the platform displayed date, numeric or ISO', () => {
    expect(readPostedAt({}, '1600000000000')).toBe(1_600_000_000_000);
    expect(readPostedAt(undefined, 1_600_000_000_000)).toBe(1_600_000_000_000);
    expect(readPostedAt(undefined, '2026-10-18T00:00:00.000Z')).toBe(Date.parse('2026-10-18T00:00:00.000Z'));
  });

  it('is null when neither can be read, so nothing is ordered against the alert', () => {
    expect(readPostedAt({ postedAt: 'soon' }, undefined)).toBeNull();
    expect(readPostedAt(undefined, '')).toBeNull();
    expect(readPostedAt(undefined, 0)).toBeNull();
  });
});
