/**
 * The shared read of a notification's routing, its stable id, and its posting
 * time. The id is what makes a repeat alert REPLACE the one on screen, so its
 * key has to be the narrowest thing the alert names and must include the
 * category (one session can owe "needs your input" and "went idle" at once).
 */
import { describe, expect, it } from 'vitest';
import {
  clearEntryCovers,
  notificationIdForRouting,
  readPostedAt,
  readSentAt,
  routingFromNotificationData,
  routingNamesAnything,
  stampPosting,
  type NotificationRouting,
} from '@/notifications/notificationRouting';

function routing(overrides: Partial<NotificationRouting> = {}): NotificationRouting {
  return { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false, ...overrides };
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
    ).toEqual({ category: 'workflow-complete', taskId: '', projectId: 'project-1', sessionId: '', sessionKind: 'command-terminal', authored: false });
    expect(routingFromNotificationData({ category: 'not-a-category', sessionKind: 'not-a-kind', taskId: 7, authored: true })).toEqual({
      category: null,
      taskId: '',
      projectId: '',
      sessionId: '',
      sessionKind: null,
      // Only the string notifee data carries counts: a non-string is not the flag.
      authored: false,
    });
  });

  it('reads the authored flag a Notify me push stamps into its data (protocol 0.26.0)', () => {
    const data = { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: '', authored: 'true' };
    expect(routingFromNotificationData(data)?.authored).toBe(true);
    expect(routingFromNotificationData({ ...data, authored: undefined })?.authored).toBe(false);
    // The flag rides through a posting untouched, and changes nothing about the
    // stable id: a Notify me keys on its task, as a workflow task's notice does.
    const posting = stampPosting(data, 1_700_000_000_000);
    expect(posting.routing?.authored).toBe(true);
    expect(posting.idField).toEqual({ id: 'kangentic:input-required:task:task-1' });
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

/**
 * stampPosting is the one place both Android display paths (the local notifier
 * and the headless push task) get an alert's id, routing and posting time from,
 * so a local alert and a remote push for one event cannot disagree. Expected
 * values below are written out as literals rather than derived through
 * routingFromNotificationData or notificationIdForRouting, which would only
 * prove stampPosting agrees with them.
 */
describe('stampPosting', () => {
  const POSTED_AT = 1_700_000_000_123;

  it('stamps the posting time as a string, keeps every other key, and names the routing and stable id of its data', () => {
    const data = {
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      sessionKind: 'command-terminal',
      extra: 'kept',
    };

    const posting = stampPosting(data, POSTED_AT);

    expect(posting.data).toStrictEqual({ ...data, postedAt: '1700000000123' });
    expect(posting.routing).toStrictEqual({
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      sessionKind: 'command-terminal',
      authored: false,
    });
    expect(posting.idField).toStrictEqual({ id: 'kangentic:input-required:session:sess-1' });
  });

  it('keys the id on the narrowest thing the data names, the same way notificationIdForRouting does', () => {
    const posting = stampPosting({ category: 'spawn-stalled', taskId: 'task-1', projectId: 'project-1', sessionId: '' }, POSTED_AT);

    expect(posting.idField).toStrictEqual({ id: 'kangentic:spawn-stalled:task:task-1' });
  });

  /**
   * A repeat posting must carry ITS OWN time, which the tap latch tells reposts
   * apart by. Data that arrives already stamped (a payload built from an earlier
   * posting) must not win over the new stamp.
   */
  it('replaces a posting time the data already carried', () => {
    const posting = stampPosting({ category: 'turn-complete', sessionId: 'sess-1', postedAt: '1' }, POSTED_AT);

    expect(posting.data).toStrictEqual({ category: 'turn-complete', sessionId: 'sess-1', postedAt: '1700000000123' });
  });

  /**
   * The idField is spread into notifee's `displayNotification`. An absent key
   * lets notifee pick a random id; a present `id: undefined` is not the same
   * thing, and toEqual cannot tell the two apart, so this asserts the key is
   * missing outright.
   */
  it.each([
    ['carries no category', { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' }, null],
    ['carries a category this build does not know', { category: 'not-a-category', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' }, null],
    ['has a category but names nothing to key on', { category: 'input-required', taskId: '', projectId: '', sessionId: '' }, 'input-required'],
  ])('gives an alert whose data %s no id key at all', (_label, data, expectedCategory) => {
    const posting = stampPosting(data, POSTED_AT);

    expect(posting.idField).toStrictEqual({});
    expect('id' in posting.idField).toBe(false);
    expect(posting.routing?.category).toBe(expectedCategory);
    expect(posting.data.postedAt).toBe('1700000000123');
  });

  it('does not mutate the data it is handed, and returns a new object', () => {
    const data = Object.freeze({ category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' });
    const before = { ...data };

    const posting = stampPosting(data, POSTED_AT);

    expect(data).toStrictEqual(before);
    expect('postedAt' in data).toBe(false);
    expect(posting.data).not.toBe(data);
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

/**
 * The desktop clock a decrypted push carries, which is NOT the phone's posting
 * time: a sealed clear's `notifiedAt` is a desktop time, so only this can be
 * ordered against it, and nothing falls back to `postedAt`.
 */
describe('readSentAt', () => {
  it('reads the stored desktop sentAt, and never the posting time', () => {
    expect(readSentAt({ sentAt: '1700000000000', postedAt: '1800000000000' })).toBe(1_700_000_000_000);
    expect(readSentAt({ postedAt: '1800000000000' })).toBeNull();
    expect(readSentAt({ sentAt: 'soon' })).toBeNull();
    expect(readSentAt(undefined)).toBeNull();
  });
});

/**
 * The covering rule itself is held to the same fixture table as the iOS
 * extension (nseCrypto.test.ts); these are the two edges that table cannot
 * express, because a Swift envelope always has a known category and a sentAt.
 */
describe('clearEntryCovers', () => {
  const entry = { category: 'input-required' as const, projectId: 'project-1', taskId: 'task-1', sessionId: 'sess-1', notifiedAt: 2_000 };

  it('covers a matching alert sent at or before notifiedAt', () => {
    expect(clearEntryCovers(entry, routing(), 2_000)).toBe(true);
    expect(clearEntryCovers(entry, routing(), 2_001)).toBe(false);
  });

  it('never covers an alert with no known category or no sentAt', () => {
    expect(clearEntryCovers(entry, routing({ category: null }), 1_000)).toBe(false);
    expect(clearEntryCovers(entry, routing(), null)).toBe(false);
  });

  it('ignores sessionKind, as the stable id and the extension do', () => {
    expect(clearEntryCovers({ ...entry, sessionKind: 'command-terminal' }, routing(), 1_000)).toBe(true);
    expect(clearEntryCovers(entry, routing({ sessionKind: 'command-terminal' }), 1_000)).toBe(true);
  });
});
