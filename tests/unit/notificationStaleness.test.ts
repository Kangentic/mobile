/**
 * The pure staleness decision behind the notification reconciler. The property
 * that matters most is NEVER DISMISS ON UNKNOWN: the stores are empty on a cold
 * start, hold a filtered projection, and survive every disconnect, so a rule
 * may only read state observed after the alert was posted - and each rule only
 * the source it actually reads (a fresh board for board rows, a fresh entry for
 * session state).
 */
import { describe, expect, it } from 'vitest';
import type { CommandTerminalWire, PushCategory } from '@kangentic/protocol';
import {
  judgeNotification,
  notificationMatchesSurface,
  observeAtFirstSight,
  type JudgedNotification,
  type StalenessContext,
  type StalenessVerdict,
} from '@/notifications/notificationStaleness';
import type { NotificationRouting } from '@/notifications/notificationRouting';
import type { SessionActivityEntry } from '@/state/activityStore';
import type { ProjectBoard } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWireFixture } from '../helpers/commandTerminals';

const POSTED_AT = 1_000_000;
const AFTER = POSTED_AT + 500;
const BEFORE = POSTED_AT - 500;
/** Held as a literal: the protocol's 24h envelope window, so a change upstream turns this red rather than tracking it. */
const ENVELOPE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function board(overrides: Partial<ProjectBoard> = {}): ProjectBoard {
  return {
    columns: [
      boardColumnFixture({ id: 'lane-todo', role: 'todo' }),
      boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, position: 1 }),
      boardColumnFixture({ id: 'lane-review', name: 'Review', role: null, position: 2 }),
      boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 3 }),
    ],
    tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: 'sess-1' }) },
    snapshotAt: AFTER,
    showTicketNumbers: true,
    view: 'sessions',
    taskCountsByColumnId: {},
    commandTerminals: [],
    commandTerminalsOffered: false,
    ...overrides,
  };
}

function entry(overrides: Partial<SessionActivityEntry> = {}): SessionActivityEntry {
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    projectId: 'project-1',
    kind: 'task',
    activityObserved: true,
    state: 'permission',
    reason: null,
    usage: null,
    awaitedPromptId: 'prompt-1',
    awaitedPromptOptions: null,
    messagePreview: null,
    inheritedPreview: false,
    lastEventAt: AFTER,
    enteredSectionAt: 0,
    sectionChangedAt: null,
    unreadCount: 0,
    feedStatus: 'live',
    endedIntentionally: null,
    sessionStatus: 'running',
    resuming: false,
    resumable: false,
    ...overrides,
  };
}

function context(overrides: Partial<StalenessContext> = {}): StalenessContext {
  return {
    now: POSTED_AT + 1_000,
    projects: [{ id: 'project-1' }],
    boardsByProjectId: { 'project-1': board() },
    bySessionId: { 'sess-1': entry() },
    endedSessionIds: {},
    openSurfaces: [],
    ...overrides,
  };
}

function routing(category: PushCategory | null, overrides: Partial<NotificationRouting> = {}): NotificationRouting {
  return { category, taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, ...overrides };
}

function routed(
  category: PushCategory | null,
  overrides: Partial<Extract<JudgedNotification, { kind: 'routed' }>> = {},
  routingOverrides: Partial<NotificationRouting> = {},
): Extract<JudgedNotification, { kind: 'routed' }> {
  return {
    kind: 'routed',
    routing: routing(category, routingOverrides),
    postedAt: POSTED_AT,
    firstSeenSwimlaneId: null,
    firstSeenPromptId: null,
    ...overrides,
  };
}

const ALL_CATEGORIES: PushCategory[] = [
  'input-required',
  'turn-complete',
  'plan-complete',
  'session-failed',
  'spawn-stalled',
  'workflow-complete',
];

describe('never dismiss on unknown', () => {
  it('keeps every alert on a cold start, when the stores are empty', () => {
    const coldStart = context({ projects: [], boardsByProjectId: {}, bySessionId: {}, endedSessionIds: {} });
    for (const category of ALL_CATEGORIES) {
      expect(judgeNotification(routed(category), coldStart)).toBe('keep');
    }
    expect(judgeNotification({ kind: 'android-placeholder', postedAt: POSTED_AT }, coldStart)).toBe('keep');
  });

  it('keeps an alert for a project this phone has no board for yet, even with a stale entry that looks resolved', () => {
    const otherProjectOnly = context({
      boardsByProjectId: { 'project-2': board() },
      bySessionId: { 'sess-1': entry({ state: 'thinking' }) },
    });
    expect(judgeNotification(routed('input-required'), otherProjectOnly)).toBe('keep');
    expect(judgeNotification(routed('turn-complete'), otherProjectOnly)).toBe('keep');
  });

  it('keeps alerts judged against stores from before they were posted (stores survive a disconnect)', () => {
    const staleStores = context({
      boardsByProjectId: {
        'project-1': board({
          snapshotAt: BEFORE,
          view: 'full',
          tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-done', session_id: 'sess-2' }) },
        }),
      },
      bySessionId: { 'sess-1': entry({ state: 'thinking', awaitedPromptId: null, lastEventAt: BEFORE }) },
    });
    for (const category of ALL_CATEGORIES) {
      expect(judgeNotification(routed(category, { firstSeenPromptId: 'prompt-1', firstSeenSwimlaneId: 'lane-doing' }), staleStores)).toBe(
        'keep',
      );
    }
  });

  it('never counts a pending entry as fresh: registration stamps the clock over a default idle state', () => {
    const pending = context({ bySessionId: { 'sess-1': entry({ feedStatus: 'pending', state: 'idle', awaitedPromptId: null }) } });
    expect(judgeNotification(routed('input-required'), pending)).toBe('keep');
  });

  it('never counts a rejected subscribe as fresh state', () => {
    const rejected = context({ bySessionId: { 'sess-1': entry({ feedStatus: 'rejected', state: 'thinking' }) } });
    expect(judgeNotification(routed('turn-complete'), rejected)).toBe('keep');
  });

  it('keeps a routed alert whose posting time is unknown', () => {
    const resolved = context({ bySessionId: { 'sess-1': entry({ state: 'thinking' }) } });
    expect(judgeNotification(routed('input-required', { postedAt: null }), resolved)).toBe('keep');
  });
});

describe('input-required', () => {
  it('keeps an alert whose session still awaits the same prompt', () => {
    expect(judgeNotification(routed('input-required', { firstSeenPromptId: 'prompt-1' }), context())).toBe('keep');
  });

  /**
   * The keepalive's live cancel: an answer at the desk is a STREAM event and
   * re-snapshots no board, so a session rule must not wait on a fresh board.
   */
  it('dismisses once a fresh entry leaves permission, even though the board predates the alert', () => {
    const answered = context({
      boardsByProjectId: { 'project-1': board({ snapshotAt: BEFORE }) },
      bySessionId: { 'sess-1': entry({ state: 'thinking', awaitedPromptId: null }) },
    });
    expect(judgeNotification(routed('input-required'), answered)).toBe('dismiss');
  });

  it('dismisses once the prompt first seen resolves with no other awaited', () => {
    const resolvedInPlace = context({ bySessionId: { 'sess-1': entry({ awaitedPromptId: null }) } });
    expect(judgeNotification(routed('input-required', { firstSeenPromptId: 'prompt-1' }), resolvedInPlace)).toBe('dismiss');
  });

  /**
   * The agent still needs input, and the local notifier's cooldown can have
   * swallowed the next prompt's own alert: dismissing here would leave the
   * phone showing nothing for an agent that is waiting.
   *
   * Mutation that reddens this: dismiss in sessionStateDismisses whenever the
   * awaited prompt differs from the one first seen. Seen red that way.
   */
  it('keeps the alert while the session moves straight on to another prompt', () => {
    const nextPrompt = context({ bySessionId: { 'sess-1': entry({ awaitedPromptId: 'prompt-2' }) } });
    expect(judgeNotification(routed('input-required', { firstSeenPromptId: 'prompt-1' }), nextPrompt)).toBe('keep');
  });

  it('dismisses once the session ended, whenever that end was seen', () => {
    const ended = context({
      boardsByProjectId: { 'project-1': board({ snapshotAt: BEFORE }) },
      bySessionId: {},
      endedSessionIds: { 'sess-1': true },
    });
    expect(judgeNotification(routed('input-required'), ended)).toBe('dismiss');
  });

  it('dismisses once a fresh board names a newer session for the task', () => {
    const resumed = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-review', session_id: 'sess-2' }) } }),
      },
      bySessionId: {},
    });
    expect(judgeNotification(routed('input-required'), resumed)).toBe('dismiss');
  });

  it('dismisses when a fresh board drops the session and nothing in the store still runs it', () => {
    const paused = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: null, resumable: true }) } }),
      },
      bySessionId: {},
    });
    expect(judgeNotification(routed('input-required'), paused)).toBe('dismiss');
  });

  /**
   * A successor subscribed from `successorSessionId` before any board names it
   * keeps a live entry; a board computed before the resume must not dismiss its
   * fresh prompt alert.
   */
  it('keeps the alert of a successor no board names yet while its live entry is held', () => {
    // The board was computed mid-resume: the task's row has no session yet.
    const successorRace = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: null }) } }),
      },
      bySessionId: { 'sess-1': entry({ lastEventAt: BEFORE }) },
    });
    expect(judgeNotification(routed('input-required'), successorRace)).toBe('keep');
  });
});

describe('turn-complete and plan-complete', () => {
  const idle = (): StalenessContext => context({ bySessionId: { 'sess-1': entry({ state: 'idle', awaitedPromptId: null }) } });

  it('keeps an alert whose session is still idle', () => {
    expect(judgeNotification(routed('turn-complete'), idle())).toBe('keep');
    expect(judgeNotification(routed('plan-complete'), idle())).toBe('keep');
  });

  it('dismisses once the session is thinking again', () => {
    const working = context({ bySessionId: { 'sess-1': entry({ state: 'thinking', awaitedPromptId: null }) } });
    expect(judgeNotification(routed('turn-complete'), working)).toBe('dismiss');
    expect(judgeNotification(routed('plan-complete'), working)).toBe('dismiss');
  });

  it('dismisses once a newer session runs for the task (how a column move looks on this desktop)', () => {
    const moved = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-review', session_id: 'sess-2' }) } }),
      },
    });
    expect(judgeNotification(routed('turn-complete'), moved)).toBe('dismiss');
    expect(judgeNotification(routed('plan-complete'), moved)).toBe('dismiss');
  });

  it('dismisses once the task left the column it was first seen in', () => {
    const moved = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-review', session_id: 'sess-1' }) } }),
      },
      bySessionId: { 'sess-1': entry({ state: 'idle', awaitedPromptId: null }) },
    });
    expect(judgeNotification(routed('turn-complete', { firstSeenSwimlaneId: 'lane-doing' }), moved)).toBe('dismiss');
    expect(judgeNotification(routed('turn-complete', { firstSeenSwimlaneId: 'lane-review' }), moved)).toBe('keep');
  });

  /**
   * The headline complaint: a task closed at the desk while the phone was away.
   * The 'sessions' projection drops it (a move to Done archives), and the prune
   * has removed its entry.
   */
  it('dismisses once a fresh sessions board no longer holds the task and no live entry remains', () => {
    const closed = context({ boardsByProjectId: { 'project-1': board({ tasksById: {} }) }, bySessionId: {} });
    expect(judgeNotification(routed('turn-complete'), closed)).toBe('dismiss');
    expect(judgeNotification(routed('plan-complete'), closed)).toBe('dismiss');
  });

  it('keeps the alert of a task paused by an idle timeout: the session ended, the resumable row stays', () => {
    const parked = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: null, resumable: true }) } }),
      },
      bySessionId: { 'sess-1': entry({ state: 'idle', feedStatus: 'ended', awaitedPromptId: null }) },
      endedSessionIds: { 'sess-1': true },
    });
    expect(judgeNotification(routed('turn-complete'), parked)).toBe('keep');
    expect(judgeNotification(routed('plan-complete'), parked)).toBe('keep');
  });
});

describe('session-failed and spawn-stalled', () => {
  it('dismisses a failure once a newer session runs for the task', () => {
    const restarted = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: 'sess-2' }) } }),
      },
    });
    expect(judgeNotification(routed('session-failed'), restarted)).toBe('dismiss');
  });

  it('keeps a failure while nothing replaced it, including a task gone from a sessions board', () => {
    const ended = context({ bySessionId: {}, endedSessionIds: { 'sess-1': true } });
    expect(judgeNotification(routed('session-failed'), ended)).toBe('keep');
    const gone = context({ boardsByProjectId: { 'project-1': board({ tasksById: {} }) }, bySessionId: {} });
    expect(judgeNotification(routed('session-failed'), gone)).toBe('keep');
  });

  it('dismisses a stall once the board names a session for the task', () => {
    expect(judgeNotification(routed('spawn-stalled', {}, { sessionId: '' }), context({ bySessionId: {} }))).toBe('dismiss');
  });

  it('dismisses a stall once its session has a fresh live entry', () => {
    const noBoardSession = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: null, spawn_progress: 'Starting agent...' }) } }),
      },
    });
    expect(judgeNotification(routed('spawn-stalled'), noBoardSession)).toBe('dismiss');
  });

  it('keeps a stall while no session exists yet, or the task is merely gone from a sessions board', () => {
    const preparing = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: null, spawn_progress: 'Starting agent...' }) } }),
      },
      bySessionId: {},
    });
    expect(judgeNotification(routed('spawn-stalled', {}, { sessionId: '' }), preparing)).toBe('keep');
    const gone = context({ boardsByProjectId: { 'project-1': board({ tasksById: {} }) }, bySessionId: {} });
    expect(judgeNotification(routed('spawn-stalled', {}, { sessionId: '' }), gone)).toBe('keep');
  });
});

/**
 * A board computed before a resume still names the PREDECESSOR session for the
 * task. The phone saw that predecessor end, and the alert belongs to the live
 * successor, so the row must not read as "a newer session runs for the task".
 * Every fixture here keeps the board FRESH (a stale board has no row to read,
 * which would pass for the wrong reason) and the successor's entry live.
 */
describe('the successor race on the newer-session rule', () => {
  const RACE_CATEGORIES = ['input-required', 'turn-complete', 'plan-complete', 'session-failed'] as const;
  interface PredecessorRecord {
    endedSessionIds: Readonly<Record<string, true>>;
    entry: SessionActivityEntry | null;
  }
  const endedPredecessorEntry = entry({ sessionId: 'sess-0', state: 'idle', awaitedPromptId: null, feedStatus: 'ended' });
  const endSeenThrough: { name: string; predecessor: PredecessorRecord }[] = [
    { name: 'a recorded end', predecessor: { endedSessionIds: { 'sess-0': true }, entry: null } },
    { name: 'an ended feed', predecessor: { endedSessionIds: {}, entry: endedPredecessorEntry } },
    { name: 'both', predecessor: { endedSessionIds: { 'sess-0': true }, entry: endedPredecessorEntry } },
  ];
  const neverSeenEnding: PredecessorRecord = { endedSessionIds: {}, entry: null };

  /** The live successor: awaiting the prompt it just raised, or idle after a finished turn. */
  const successorEntryFor = (category: PushCategory): SessionActivityEntry =>
    category === 'input-required' ? entry() : entry({ state: 'idle', awaitedPromptId: null });

  const raceContext = (category: PushCategory, predecessor: PredecessorRecord): StalenessContext =>
    context({
      // Fresh, and the task's row (in its column) still names sess-0.
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: 'sess-0' }) } }),
      },
      bySessionId:
        predecessor.entry === null
          ? { 'sess-1': successorEntryFor(category) }
          : { 'sess-0': predecessor.entry, 'sess-1': successorEntryFor(category) },
      endedSessionIds: predecessor.endedSessionIds,
    });

  const verdictsByCategory = (predecessor: PredecessorRecord): Record<string, StalenessVerdict> => {
    const verdicts: Record<string, StalenessVerdict> = {};
    for (const category of RACE_CATEGORIES) {
      const notification = routed(category, { firstSeenPromptId: category === 'input-required' ? 'prompt-1' : null });
      verdicts[category] = judgeNotification(notification, raceContext(category, predecessor));
    }
    return verdicts;
  };

  /**
   * Mutation that would redden this: drop `&& !sessionEnded(context, row.session_id)`
   * from `newerSession` in judgeTaskAlert. The row then names a "newer" sess-0
   * and all four categories dismiss. The 'an ended feed' row also pins the
   * second half of `sessionEnded` (`feedStatus === 'ended'`).
   */
  it.each(endSeenThrough)('keeps the successor alert of every category when the board names a predecessor whose end was seen as $name', ({ predecessor }) => {
    expect(verdictsByCategory(predecessor)).toEqual({
      'input-required': 'keep',
      'turn-complete': 'keep',
      'plan-complete': 'keep',
      'session-failed': 'keep',
    });
  });

  /**
   * The control: the same boards and the same live successor, but the phone never
   * saw sess-0 end. That is a genuinely newer session, so each category dismisses.
   */
  it('dismisses every category when the board names a session this phone never saw end (a genuinely newer one)', () => {
    expect(verdictsByCategory(neverSeenEnding)).toEqual({
      'input-required': 'dismiss',
      'turn-complete': 'dismiss',
      'plan-complete': 'dismiss',
      'session-failed': 'dismiss',
    });
  });
});

describe('any task alert: the task is closed', () => {
  it('dismisses every category of a task in a done-role column', () => {
    const done = context({
      boardsByProjectId: {
        'project-1': board({ tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-done', session_id: 'sess-1' }) } }),
      },
    });
    for (const category of ALL_CATEGORIES.filter((candidate) => candidate !== 'workflow-complete')) {
      expect(judgeNotification(routed(category), done)).toBe('dismiss');
    }
  });

  it('dismisses an archived row', () => {
    const archived = context({
      boardsByProjectId: {
        'project-1': board({
          tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-doing', session_id: 'sess-1', archived_at: '2026-10-18T00:00:00.000Z' }) },
        }),
      },
    });
    expect(judgeNotification(routed('session-failed'), archived)).toBe('dismiss');
  });

  it('dismisses a task missing from a FULL board (archived or deleted), but not from a sessions board', () => {
    const full = context({ boardsByProjectId: { 'project-1': board({ view: 'full', tasksById: {} }) } });
    expect(judgeNotification(routed('session-failed'), full)).toBe('dismiss');
    expect(judgeNotification(routed(null), full)).toBe('dismiss');
    const sessions = context({ boardsByProjectId: { 'project-1': board({ view: 'sessions', tasksById: {} }) } });
    expect(judgeNotification(routed('session-failed'), sessions)).toBe('keep');
    expect(judgeNotification(routed(null), sessions)).toBe('keep');
  });

  it('applies only the closed-task rules to a legacy alert with no category', () => {
    const working = context({ bySessionId: { 'sess-1': entry({ state: 'thinking' }) } });
    expect(judgeNotification(routed(null), working)).toBe('keep');
  });
});

describe('workflow-complete', () => {
  const workflowAlert = (): Extract<JudgedNotification, { kind: 'routed' }> =>
    routed('workflow-complete', {}, { taskId: '', sessionId: '', projectId: 'project-1' });

  it('is never dismissed by store state', () => {
    const everythingFresh = context({ boardsByProjectId: { 'project-1': board({ view: 'full', tasksById: {} }) }, bySessionId: {} });
    expect(judgeNotification(workflowAlert(), everythingFresh)).toBe('keep');
  });

  it('is dismissed by its home project Board on screen, and only by that', () => {
    expect(judgeNotification(workflowAlert(), context({ openSurfaces: [{ kind: 'project-board', projectId: 'project-1' }] }))).toBe('dismiss');
    expect(judgeNotification(workflowAlert(), context({ openSurfaces: [{ kind: 'project-board', projectId: 'project-2' }] }))).toBe('keep');
  });
});

describe('clear on open (open surfaces)', () => {
  it('dismisses a task alert while that task is on screen, without needing any fresh state', () => {
    const coldStart = context({ projects: [], boardsByProjectId: {}, bySessionId: {} });
    const onScreen = { ...coldStart, openSurfaces: [{ kind: 'task' as const, taskId: 'task-1' }] };
    expect(judgeNotification(routed('input-required', { postedAt: null }), onScreen)).toBe('dismiss');
    expect(judgeNotification(routed('turn-complete'), onScreen)).toBe('dismiss');
  });

  it('does not let a project Board clear a task alert', () => {
    expect(
      notificationMatchesSurface(routing('turn-complete'), { kind: 'project-board', projectId: 'project-1' }),
    ).toBe(false);
  });

  it('matches a Command Terminal alert by its session, never by its made-up task id', () => {
    const terminalRouting = routing('input-required', { taskId: 'made-up', sessionKind: 'command-terminal', sessionId: 'term-1' });
    expect(notificationMatchesSurface(terminalRouting, { kind: 'command-terminal', sessionId: 'term-1' })).toBe(true);
    expect(notificationMatchesSurface(terminalRouting, { kind: 'task', taskId: 'made-up' })).toBe(false);
    expect(notificationMatchesSurface(routing('input-required'), { kind: 'command-terminal', sessionId: 'sess-1' })).toBe(false);
  });
});

describe('Command Terminal alerts', () => {
  const terminalOverrides: Partial<NotificationRouting> = { taskId: 'made-up', sessionKind: 'command-terminal', sessionId: 'term-1' };
  const terminalEntry = (overrides: Partial<SessionActivityEntry> = {}): SessionActivityEntry =>
    entry({ sessionId: 'term-1', taskId: '', kind: 'command-terminal', ...overrides });
  const listed = (overrides: Partial<StalenessContext> = {}): StalenessContext =>
    context({
      boardsByProjectId: { 'project-1': board({ commandTerminals: [commandTerminalWireFixture({ sessionId: 'term-1', projectId: 'project-1', slot: 1 })] }) },
      bySessionId: { 'term-1': terminalEntry() },
      ...overrides,
    });

  it('keeps a prompt alert while the terminal still awaits it', () => {
    expect(judgeNotification(routed('input-required', {}, terminalOverrides), listed())).toBe('keep');
  });

  it('dismisses a prompt alert once the terminal leaves permission', () => {
    const answered = listed({ bySessionId: { 'term-1': terminalEntry({ state: 'thinking', awaitedPromptId: null }) } });
    expect(judgeNotification(routed('input-required', {}, terminalOverrides), answered)).toBe('dismiss');
  });

  it('dismisses its alerts once a fresh board no longer lists the terminal and no live entry remains', () => {
    const closed = context({ boardsByProjectId: { 'project-1': board({ commandTerminals: [] }) }, bySessionId: {} });
    expect(judgeNotification(routed('input-required', {}, terminalOverrides), closed)).toBe('dismiss');
    expect(judgeNotification(routed('turn-complete', {}, terminalOverrides), closed)).toBe('dismiss');
  });

  it('never applies a task row rule to the made-up task id', () => {
    const full = listed({
      boardsByProjectId: {
        'project-1': board({ view: 'full', tasksById: {}, commandTerminals: [commandTerminalWireFixture({ sessionId: 'term-1', projectId: 'project-1', slot: 1 })] }),
      },
    });
    expect(judgeNotification(routed('input-required', {}, terminalOverrides), full)).toBe('keep');
  });

  const terminalListing = (): CommandTerminalWire =>
    commandTerminalWireFixture({ sessionId: 'term-1', projectId: 'project-1', slot: 1 });

  /**
   * A Command Terminal has no pause or successor, so a seen end is an end. The
   * board predates the alert and still lists the terminal, and there is no entry:
   * the recorded end is the only thing that can dismiss.
   *
   * Mutation that would redden this: drop `sessionEnded(context, routing.sessionId) ||`
   * from `ended` in judgeCommandTerminalAlert. A stale board makes `terminalGone`
   * false, so every category then keeps.
   */
  it('dismisses through a recorded end even when the board predates the alert', () => {
    const endedOnStaleBoard = listed({
      boardsByProjectId: { 'project-1': board({ snapshotAt: BEFORE, commandTerminals: [terminalListing()] }) },
      bySessionId: {},
      endedSessionIds: { 'term-1': true },
    });
    for (const category of ['input-required', 'turn-complete', 'plan-complete'] as const) {
      expect(judgeNotification(routed(category, {}, terminalOverrides), endedOnStaleBoard)).toBe('dismiss');
    }
    // The control: the same stale board with no end recorded says nothing, so it keeps.
    const noEndRecorded = { ...endedOnStaleBoard, endedSessionIds: {} };
    for (const category of ['input-required', 'turn-complete', 'plan-complete'] as const) {
      expect(judgeNotification(routed(category, {}, terminalOverrides), noEndRecorded)).toBe('keep');
    }
  });

  /**
   * The terminal was subscribed before any board lists it (the same race as a
   * resumed task's successor), so a held entry keeps the alert. A `'rejected'` or
   * `'pending'` entry is still held, and neither is fresh, so they decide nothing.
   *
   * Mutation that would redden this: drop `&& !hasLiveEntry(context, routing.sessionId)`
   * from `terminalGone`. The unlisted terminal then reads as gone and every row dismisses.
   */
  it.each(['live', 'pending', 'rejected'] as const)(
    'keeps its alerts when a fresh board no longer lists the terminal but a %s entry is still held',
    (feedStatus) => {
      const unlistedButHeld = listed({
        boardsByProjectId: { 'project-1': board({ commandTerminals: [] }) },
        bySessionId: { 'term-1': terminalEntry({ feedStatus }) },
      });
      expect(judgeNotification(routed('input-required', {}, terminalOverrides), unlistedButHeld)).toBe('keep');
      expect(judgeNotification(routed('turn-complete', {}, terminalOverrides), unlistedButHeld)).toBe('keep');
      // The control: the same unlisted terminal with nothing held is gone.
      const unlistedAndNotHeld = { ...unlistedButHeld, bySessionId: {} };
      expect(judgeNotification(routed('input-required', {}, terminalOverrides), unlistedAndNotHeld)).toBe('dismiss');
    },
  );

  /**
   * Mutations that would redden this. Make the final return of
   * sessionStateDismisses' input-required arm `false`: the dismiss assertion
   * reddens, and so does the task-alert test of this rule ('dismisses once the
   * prompt first seen resolves with no other awaited'). Drop
   * `notification.firstSeenPromptId !== null &&` from that return: only the
   * control below reddens, so it is this test's own guard.
   */
  it('dismisses a prompt alert once the prompt first seen resolves with none awaited', () => {
    const resolved = listed({ bySessionId: { 'term-1': terminalEntry({ awaitedPromptId: null }) } });
    expect(judgeNotification(routed('input-required', { firstSeenPromptId: 'prompt-1' }, terminalOverrides), resolved)).toBe('dismiss');
    // The control: with no prompt recorded at first sight, an empty awaited prompt resolves nothing.
    expect(judgeNotification(routed('input-required', { firstSeenPromptId: null }, terminalOverrides), resolved)).toBe('keep');
  });

  /**
   * Mutation that would redden this: dismiss in sessionStateDismisses whenever
   * the awaited prompt differs from the one first seen (the same mutation that
   * reddens the task-alert test 'keeps the alert while the session moves straight
   * on to another prompt').
   */
  it('keeps a prompt alert while the terminal moves straight on to another prompt', () => {
    const nextPrompt = listed({ bySessionId: { 'term-1': terminalEntry({ awaitedPromptId: 'prompt-2' }) } });
    expect(judgeNotification(routed('input-required', { firstSeenPromptId: 'prompt-1' }, terminalOverrides), nextPrompt)).toBe('keep');
  });

  /**
   * Mutation that would redden this: make the `'turn-complete'` / `'plan-complete'`
   * arm of sessionStateDismisses return false (or test `entry.state === 'idle'`).
   */
  it('dismisses a finished-turn alert once the terminal is thinking again, and keeps it while idle', () => {
    const working = listed({ bySessionId: { 'term-1': terminalEntry({ state: 'thinking', awaitedPromptId: null }) } });
    expect(judgeNotification(routed('turn-complete', {}, terminalOverrides), working)).toBe('dismiss');
    expect(judgeNotification(routed('plan-complete', {}, terminalOverrides), working)).toBe('dismiss');
    const idle = listed({ bySessionId: { 'term-1': terminalEntry({ state: 'idle', awaitedPromptId: null }) } });
    expect(judgeNotification(routed('turn-complete', {}, terminalOverrides), idle)).toBe('keep');
    expect(judgeNotification(routed('plan-complete', {}, terminalOverrides), idle)).toBe('keep');
  });
});

describe('Android placeholder', () => {
  const placeholder: JudgedNotification = { kind: 'android-placeholder', postedAt: POSTED_AT };

  it('dismisses once every project and every live session it names was re-read after it', () => {
    const allFresh = context({
      projects: [{ id: 'project-1' }, { id: 'project-2' }],
      boardsByProjectId: { 'project-1': board(), 'project-2': board({ tasksById: {} }) },
    });
    expect(judgeNotification(placeholder, allFresh)).toBe('dismiss');
  });

  it('keeps while any one project board predates it', () => {
    const partial = context({
      projects: [{ id: 'project-1' }, { id: 'project-2' }],
      boardsByProjectId: { 'project-1': board(), 'project-2': board({ tasksById: {}, snapshotAt: BEFORE }) },
    });
    expect(judgeNotification(placeholder, partial)).toBe('keep');
  });

  it('keeps while any live session a board names has no fresh entry', () => {
    const staleSession = context({ bySessionId: { 'sess-1': entry({ lastEventAt: BEFORE }) } });
    expect(judgeNotification(placeholder, staleSession)).toBe('keep');
    const unsubscribed = context({ bySessionId: {} });
    expect(judgeNotification(placeholder, unsubscribed)).toBe('keep');
  });

  it('keeps with no project list, or no posting time', () => {
    expect(judgeNotification(placeholder, context({ projects: [] }))).toBe('keep');
    expect(judgeNotification({ kind: 'android-placeholder', postedAt: null }, context())).toBe('keep');
  });

  /**
   * The walk names every task with a session, and a task that is archived or has
   * none is not one the Agents feed shows, so no entry is owed for it. Each
   * control is the same row made countable, which then holds the placeholder.
   *
   * Mutation that would redden this: drop `|| task.archived_at !== null` from the
   * skip in everyProjectFreshAfter. The archived row then needs an entry nobody has.
   */
  it('skips an archived task that holds a session when no entry follows it', () => {
    const archivedTask = boardTaskFixture({
      id: 'task-archived',
      swimlane_id: 'lane-doing',
      session_id: 'sess-archived',
      archived_at: '2026-10-18T00:00:00.000Z',
    });
    const boardWith = (task: typeof archivedTask): ProjectBoard => board({ tasksById: { ...board().tasksById, [task.id]: task } });
    expect(judgeNotification(placeholder, context({ boardsByProjectId: { 'project-1': boardWith(archivedTask) } }))).toBe('dismiss');
    const unarchivedTask = { ...archivedTask, archived_at: null };
    expect(judgeNotification(placeholder, context({ boardsByProjectId: { 'project-1': boardWith(unarchivedTask) } }))).toBe('keep');
  });

  /**
   * Mutation that would redden this: turn the skip of a null `session_id` into
   * `return false` in everyProjectFreshAfter. (Dropping the check outright throws
   * a TypeError in freshEntry on `null.length`, which is red for the wrong reason.)
   */
  it('skips a task with no session', () => {
    const sessionlessTask = boardTaskFixture({ id: 'task-sessionless', swimlane_id: 'lane-doing', session_id: null });
    const boardWith = (task: typeof sessionlessTask): ProjectBoard => board({ tasksById: { ...board().tasksById, [task.id]: task } });
    expect(judgeNotification(placeholder, context({ boardsByProjectId: { 'project-1': boardWith(sessionlessTask) } }))).toBe('dismiss');
    const sessionHolding = { ...sessionlessTask, session_id: 'sess-unread' };
    expect(judgeNotification(placeholder, context({ boardsByProjectId: { 'project-1': boardWith(sessionHolding) } }))).toBe('keep');
  });

  /**
   * Task-1 and its sess-1 entry stay fully fresh, so only the terminal can hold
   * the placeholder.
   *
   * Mutation that would redden this: delete the `board.commandTerminals` loop in
   * everyProjectFreshAfter. The unread terminals are then never asked for.
   */
  it('keeps while a listed Command Terminal has no fresh entry, and dismisses once it has one', () => {
    const terminalBoards = {
      'project-1': board({ commandTerminals: [commandTerminalWireFixture({ sessionId: 'term-1', projectId: 'project-1', slot: 1 })] }),
    };
    const terminalEntry = (overrides: Partial<SessionActivityEntry> = {}): SessionActivityEntry =>
      entry({ sessionId: 'term-1', taskId: '', kind: 'command-terminal', ...overrides });
    const withTerminalEntry = (terminal: SessionActivityEntry | null): StalenessContext =>
      context({
        boardsByProjectId: terminalBoards,
        bySessionId: terminal === null ? { 'sess-1': entry() } : { 'sess-1': entry(), 'term-1': terminal },
      });
    expect(judgeNotification(placeholder, withTerminalEntry(null))).toBe('keep');
    expect(judgeNotification(placeholder, withTerminalEntry(terminalEntry({ lastEventAt: BEFORE })))).toBe('keep');
    expect(judgeNotification(placeholder, withTerminalEntry(terminalEntry({ feedStatus: 'pending' })))).toBe('keep');
    // The control: the same terminal, re-read after the placeholder.
    expect(judgeNotification(placeholder, withTerminalEntry(terminalEntry()))).toBe('dismiss');
  });

  /**
   * 'keeps while any one project board predates it' (above) already pins a stale
   * second board, so this is the arm it leaves: a listed project with no board at
   * all: a project listed before its board lands.
   *
   * Mutation that would redden this: walk `Object.keys(context.boardsByProjectId)`
   * instead of `context.projects` in everyProjectFreshAfter.
   */
  it('keeps while a listed project has no board at all yet', () => {
    const secondBoardMissing = context({
      projects: [{ id: 'project-1' }, { id: 'project-2' }],
      boardsByProjectId: { 'project-1': board() },
    });
    expect(judgeNotification(placeholder, secondBoardMissing)).toBe('keep');
    // The control: the second project's board lands after the placeholder.
    const secondBoardLanded = { ...secondBoardMissing, boardsByProjectId: { 'project-1': board(), 'project-2': board({ tasksById: {} }) } };
    expect(judgeNotification(placeholder, secondBoardLanded)).toBe('dismiss');
  });
});

describe('iOS alert this app cannot open', () => {
  it('dismisses once it is older than the envelope window, and keeps it before', () => {
    const now = POSTED_AT + ENVELOPE_MAX_AGE_MS;
    expect(judgeNotification({ kind: 'ios-undecryptable', postedAt: POSTED_AT }, context({ now: now + 1 }))).toBe('dismiss');
    expect(judgeNotification({ kind: 'ios-undecryptable', postedAt: POSTED_AT }, context({ now: now - 1 }))).toBe('keep');
    expect(judgeNotification({ kind: 'ios-undecryptable', postedAt: null }, context({ now: now + 1 }))).toBe('keep');
  });
});

describe('observeAtFirstSight', () => {
  it('records the column and the awaited prompt only from state newer than the alert', () => {
    expect(observeAtFirstSight(routed('input-required'), context())).toEqual({ swimlaneId: 'lane-doing', promptId: 'prompt-1' });
    const stale = context({
      boardsByProjectId: { 'project-1': board({ snapshotAt: BEFORE }) },
      bySessionId: { 'sess-1': entry({ lastEventAt: BEFORE }) },
    });
    expect(observeAtFirstSight(routed('input-required'), stale)).toEqual({ swimlaneId: null, promptId: null });
  });

  it('records no prompt for a category that is not a prompt, and no column for a Command Terminal', () => {
    expect(observeAtFirstSight(routed('turn-complete'), context()).promptId).toBeNull();
    const terminal = routed('input-required', {}, { taskId: 'task-1', sessionKind: 'command-terminal' });
    expect(observeAtFirstSight(terminal, context()).swimlaneId).toBeNull();
  });

  /**
   * A snapshot copies the desktop's awaited prompt id as sent (activityStore), so
   * the reader must not trust one outside 'permission'. The id stays non-null on
   * the thinking entry: with null, the guard would be invisible.
   *
   * Mutation that would redden this: drop `&& entry.state === 'permission'` from
   * observeAtFirstSight. The thinking entry then records 'prompt-1'.
   */
  it('records no prompt from a fresh entry that is not in permission, whatever id it still carries', () => {
    const working = context({ bySessionId: { 'sess-1': entry({ state: 'thinking', awaitedPromptId: 'prompt-1' }) } });
    expect(observeAtFirstSight(routed('input-required'), working)).toEqual({ swimlaneId: 'lane-doing', promptId: null });
    // The control: the same entry in permission records its prompt.
    const asking = context({ bySessionId: { 'sess-1': entry({ state: 'permission', awaitedPromptId: 'prompt-1' }) } });
    expect(observeAtFirstSight(routed('input-required'), asking)).toEqual({ swimlaneId: 'lane-doing', promptId: 'prompt-1' });
  });

  /**
   * A non-default id, so the value is clearly the entry's own.
   *
   * Mutation that would redden this: return a constant or the notification's
   * `firstSeenPromptId` instead of `entry.awaitedPromptId`.
   */
  it('records the prompt id a fresh permission entry awaits', () => {
    const asking = context({ bySessionId: { 'sess-1': entry({ awaitedPromptId: 'prompt-7' }) } });
    expect(observeAtFirstSight(routed('input-required'), asking).promptId).toBe('prompt-7');
  });

  /**
   * The column comes from the board and the prompt from the entry, each gated on
   * its own source. The existing test above moves both together, so it would pass
   * a mutation that gates both fields on one source.
   *
   * Mutation that would redden this: read the prompt only when the board is fresh
   * (or the column only when the entry is), e.g. `freshBoard(...) !== null &&` in
   * front of the prompt's `freshEntry` read.
   */
  it('gates the column on the board and the prompt on the entry, independently', () => {
    const staleEntry = context({ bySessionId: { 'sess-1': entry({ lastEventAt: BEFORE }) } });
    expect(observeAtFirstSight(routed('input-required'), staleEntry)).toEqual({ swimlaneId: 'lane-doing', promptId: null });
    const staleBoard = context({ boardsByProjectId: { 'project-1': board({ snapshotAt: BEFORE }) } });
    expect(observeAtFirstSight(routed('input-required'), staleBoard)).toEqual({ swimlaneId: null, promptId: 'prompt-1' });
  });

  /**
   * The made-up task id names a real row on this board, so a column read for it
   * would record 'lane-doing'. The terminal's prompt is still recorded: its
   * input-required rule needs the prompt first seen.
   *
   * Mutation that would redden this: drop `routing.sessionKind !== 'command-terminal' &&`
   * from the swimlane read in observeAtFirstSight.
   */
  it('records a Command Terminal alert prompt but never a column, even when its made-up task id matches a row', () => {
    const terminalAlert = routed('input-required', {}, { taskId: 'task-1', sessionKind: 'command-terminal', sessionId: 'term-1' });
    const terminalAsking = context({
      bySessionId: { 'term-1': entry({ sessionId: 'term-1', taskId: '', kind: 'command-terminal', awaitedPromptId: 'prompt-3' }) },
    });
    expect(observeAtFirstSight(terminalAlert, terminalAsking)).toEqual({ swimlaneId: null, promptId: 'prompt-3' });
  });

  /**
   * With no posting time nothing is known to be newer than the alert, so even
   * the freshest board and entry record nothing.
   *
   * Mutation that reddens this: drop the `postedAt === null` early return in
   * observeAtFirstSight. Seen red that way.
   */
  it('records nothing for an alert whose posting time is unknown', () => {
    expect(observeAtFirstSight(routed('input-required', { postedAt: null }), context())).toEqual({ swimlaneId: null, promptId: null });
  });
});
