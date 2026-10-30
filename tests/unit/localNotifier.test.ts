/**
 * The foreground-service mode's local notifier: activity-store transitions
 * become notifee notifications ONLY while the app is backgrounded, with a
 * per-(session, kind) cooldown matching the desktop's push debouncing.
 * Runs against the real zustand stores so mock/stub/live parity holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent } from '@kangentic/protocol';
// vitest hoists the vi.mock calls below above these imports at transform
// time, so the mocked react-native / notifee are in place before they load.
import notifee from '@notifee/react-native';
import { startLocalNotifier } from '@/notifications/localNotifier';
import * as notificationSignals from '@/notifications/notificationSignals';
import {
  publishNotificationDismissed,
  subscribeToDisplayedNotifications,
  type DisplayedNotificationNote,
} from '@/notifications/notificationSignals';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { brandTokens } from '@/components/theme/tokens';

// settingsStore.ts persists via expo-secure-store; mocked (not the store
// itself) so the REAL zustand store still runs, matching this file's
// "real stores" design - the per-category toggle gate is a fresh, in-memory
// default (every category enabled) unless a test explicitly flips one.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

const appStateMock = vi.hoisted(() => {
  const listeners = new Set<(status: string) => void>();
  return {
    currentState: 'active',
    listeners,
    emit(status: string): void {
      appStateMock.currentState = status;
      for (const listener of listeners) listener(status);
    },
  };
});

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appStateMock.currentState;
    },
    addEventListener: (_type: string, handler: (status: string) => void) => {
      appStateMock.listeners.add(handler);
      return { remove: () => appStateMock.listeners.delete(handler) };
    },
  },
  Platform: { OS: 'android' },
}));

vi.mock('@notifee/react-native', () => ({
  default: {
    displayNotification: vi.fn(async () => 'notification-id'),
    createChannels: vi.fn(async () => undefined),
  },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

const displayNotification = vi.mocked(notifee.displayNotification);

function permissionEvent(promptId: string, pending = true): ActivityEvent {
  return { kind: 'activity', sessionId: 'sess-1', taskId: 'task-1', payload: { type: 'permission', promptId, pending } };
}

function sessionEndedEvent(intentional: boolean): ActivityEvent {
  return { kind: 'activity', sessionId: 'sess-1', taskId: 'task-1', payload: { type: 'session-ended', intentional } };
}

function activityStateEvent(state: 'thinking' | 'idle'): ActivityEvent {
  return activityStateEventForSession('sess-1', 'task-1', state);
}

/** Parameterized over session/task so a test can drive two sessions independently. */
function activityStateEventForSession(sessionId: string, taskId: string, state: 'thinking' | 'idle'): ActivityEvent {
  return {
    kind: 'activity',
    sessionId,
    taskId,
    payload: { type: 'activity', state, reason: state === 'thinking' ? { kind: 'turn-active' } : { kind: 'idle' } },
  };
}

/**
 * Must match IDLE_SETTLE_MS in localNotifier.ts. Held as a literal on purpose:
 * importing the constant would make these tests track whatever the source says,
 * so deleting the debounce entirely (setting it to 0) would keep them green -
 * which is precisely the regression they exist to catch.
 */
const EXPECTED_IDLE_SETTLE_MS = 45_000;

/**
 * The reconciler's note follows the display's promise. Drained by hand: this
 * file fakes setTimeout, so the shared macrotask flush (flushMicrotasks) would
 * never resolve.
 */
async function drainDisplayPromises(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

function seedSession(): void {
  useBoardStore
    .getState()
    .applyBoardSnapshot(
      boardSnapshotFixture({ projectId: 'project-1', tasks: [boardTaskFixture({ id: 'task-1', session_id: 'sess-1', title: 'Ship the release' })] }),
    );
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
}

describe('startLocalNotifier', () => {
  let nowMs: number;
  let stopNotifier: (() => void) | null = null;
  let dateNowSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    // Only the timer functions, never Date: the cooldown is driven by the
    // hand-advanced nowMs below, and letting the fake clock own Date.now too
    // would make the two mechanisms fight.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    nowMs = 1_000_000;
    dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    displayNotification.mockClear();
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    useSettingsStore.setState({
      pushCategoriesEnabled: {
        'input-required': true,
        'turn-complete': true,
        'session-failed': true,
        'plan-complete': true,
        'spawn-stalled': true,
        'workflow-complete': true,
      },
    });
    appStateMock.emit('active');
  });

  afterEach(() => {
    stopNotifier?.();
    stopNotifier = null;
    dateNowSpy?.mockRestore();
    dateNowSpy = null;
    vi.useRealTimers();
  });

  /**
   * A successor session inherits its ghost's Home-feed row (activityStore's
   * successorEntry), and a NEW entry has no previous snapshot here - so a
   * ghost's pending prompt inherited verbatim would read as a fresh prompt
   * and push "Agent needs your input" for a question the dead agent asked.
   * The store maps it to idle; this pins that the notifier stays silent.
   * Copying the ghost's state unchanged fails this with one call.
   */
  it('does not fire input-required for a successor whose ghost was awaiting a prompt', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification).toHaveBeenCalledTimes(1);
    displayNotification.mockClear();

    useActivityStore.getState().applyActivityEvent(sessionEndedEvent(true));
    useActivityStore.getState().registerSession('sess-2', 'task-1', 'project-1');

    expect(displayNotification).not.toHaveBeenCalled();
  });

  /**
   * Protocol 0.26.0: the wait's kind titles the local alert as the desktop's
   * push titles it, so a local and a remote alert for one wait agree. The
   * desktop sends the activity event carrying the reason BEFORE the prompt
   * event (read-stream.ts), which is the order driven here.
   */
  it.each([
    ['question', 'Agent has a question'],
    ['approval', 'Agent needs your approval'],
  ] as const)('titles the %s wait by its kind', (waitKind, expectedTitle) => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'permission', reason: { kind: 'permission', since: nowMs, waitKind } },
    });
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));

    expect(displayNotification).toHaveBeenCalledTimes(1);
    expect(displayNotification.mock.calls[0][0].title).toBe(expectedTitle);
    expect(displayNotification.mock.calls[0][0].body).toBe('Ship the release');
  });

  it('fires on a background transition into permission, on the needs-attention channel with the task title', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));

    expect(displayNotification).toHaveBeenCalledTimes(1);
    const notification = displayNotification.mock.calls[0][0];
    expect(notification.title).toBe('Agent needs your input');
    expect(notification.body).toBe('Ship the release');
    expect(notification.android?.channelId).toBe('needs-attention');
    expect(notification.data).toEqual({
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      postedAt: String(nowMs),
    });
    // Notifee defaults smallIcon to ic_launcher (a full-colour asset the OS
    // strips to a silhouette) unless set explicitly - see channels.ts.
    expect(notification.android?.smallIcon).toBe('notification_icon');
    expect(notification.android?.color).toBe(brandTokens.rust);
  });

  /**
   * This notification could not fire at all before: the desktop's
   * `session-ended` event had no case in applyActivityEvent, so it fell
   * through and `feedStatus` never reached 'ended' - the value this notifier
   * keys on. It survived two protocol bumps because nothing asserted it.
   */
  it('fires session-failed when a live session ends UNINTENTIONALLY', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(sessionEndedEvent(false));

    expect(displayNotification).toHaveBeenCalledTimes(1);
    const notification = displayNotification.mock.calls[0][0];
    expect(notification.android?.channelId).toBe('failures');
    expect(notification.data).toEqual({
      category: 'session-failed',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      postedAt: String(nowMs),
    });
  });

  /**
   * A deliberate Stop, suspend or shutdown is the user's own action, taken at
   * the desktop they are sitting at. Waking their phone to report it would be
   * noise, and the category is 'session-failed' - nothing failed.
   */
  it('stays silent when the session ends intentionally', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(sessionEndedEvent(true));

    expect(displayNotification).not.toHaveBeenCalled();
  });

  it('fires session-failed only once, however many times the end is re-delivered', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(sessionEndedEvent(false));
    useActivityStore.getState().applyActivityEvent(sessionEndedEvent(false));

    expect(displayNotification).toHaveBeenCalledTimes(1);
  });

  it('is fully suppressed while the app is foregrounded', () => {
    seedSession();
    stopNotifier = startLocalNotifier();

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification).not.toHaveBeenCalled();

    // Backgrounding later must not retro-fire the transition either.
    appStateMock.emit('background');
    expect(displayNotification).not.toHaveBeenCalled();
  });

  it('fires turn-complete on the completions channel once a thinking-to-idle transition has settled', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    expect(displayNotification).not.toHaveBeenCalled();
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    // Nothing yet: reaching idle only ARMS the settle timer.
    expect(displayNotification).not.toHaveBeenCalled();

    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

    expect(displayNotification).toHaveBeenCalledTimes(1);
    const notification = displayNotification.mock.calls[0][0];
    expect(notification.title).toBe('Agent went idle');
    expect(notification.android?.channelId).toBe('completions');
  });

  /**
   * The flood this debounce exists for. Every exchange in a conversation ends
   * in idle, so before the settle window a three-reply back-and-forth was three
   * notifications - and the 30s cooldown does not help, because real turns are
   * usually further apart than that. Only the LAST idle, the one that actually
   * sticks, should alert.
   */
  it('does not fire for a session that goes back to work inside the settle window', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    // Three quick exchanges, each ending in idle, none of them settling.
    for (let exchange = 0; exchange < 3; exchange += 1) {
      useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
      useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
      vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS / 3);
    }
    expect(displayNotification).not.toHaveBeenCalled();

    // Only once it stays idle does one alert land - one, not four.
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);
    expect(displayNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * A prompt arriving during the settle window is the sharpest version of the
   * same case: the session is emphatically not finished, and input-required
   * fires on its own.
   */
  it('cancels a pending settle when the session asks for permission instead', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS * 2);

    expect(displayNotification).toHaveBeenCalledTimes(1);
    expect(displayNotification.mock.calls[0][0].title).toBe('Agent needs your input');
  });

  /**
   * The debounce opens a window the app can be foregrounded inside, so the
   * background gate has to be re-checked when the timer FIRES, not only when it
   * is armed. Otherwise an alert posts over the UI the user is looking at.
   */
  it('does not fire a settled idle if the app came forward inside the window', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    appStateMock.emit('active');
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

    expect(displayNotification).not.toHaveBeenCalled();
  });

  /**
   * The mirror image of the test above, and the reason the background gate
   * lives ONLY at fire time (inside scheduleIdleSettle's setTimeout callback)
   * and not also at arm time. A session can settle into idle while the app is
   * still in the foreground - the user has it open, watching - and then the
   * user backgrounds the phone before the settle window closes. That must
   * still alert: arming is unconditional on every thinking -> idle edge, and
   * only the fire-time check decides whether to actually post.
   *
   * A regression that added a background check to the arm/cancel branch too
   * (gating the whole per-entry loop on appStateStatus before scheduleIdleSettle
   * is ever reached) would never start the timer for this session at all, so
   * backgrounding later would have nothing left to fire.
   */
  it('arms the idle-settle timer even while foregrounded, and fires once backgrounded before the window closes', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    // Deliberately no 'background' emit here: the session goes thinking -> idle
    // while appStateMock is still at its beforeEach default of 'active'.

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS / 2);
    expect(displayNotification).not.toHaveBeenCalled();

    appStateMock.emit('background');
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS / 2);

    expect(displayNotification).toHaveBeenCalledTimes(1);
    expect(displayNotification.mock.calls[0][0].title).toBe('Agent went idle');
  });

  /**
   * A session that ENDS while a settle is pending must not also report going
   * idle. `session-ended` sets feedStatus only and leaves `state` at 'idle'
   * (activityStore.ts), so neither the arm/cancel branch nor a fire-time check
   * on `state` alone notices - the crash would fire session-failed immediately
   * and "Agent went idle" 45s later, a double notification on the very path
   * this work exists to de-duplicate.
   */
  it('cancels a pending settle when the session ends unintentionally, firing only session-failed', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    useActivityStore.getState().applyActivityEvent(sessionEndedEvent(false));
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

    expect(displayNotification).toHaveBeenCalledTimes(1);
    expect(displayNotification.mock.calls[0][0].title).toBe('Session stopped');
  });

  /**
   * The sharper half: a DELIBERATE stop notifies nothing at all (it is the
   * user's own action at the desk they are sitting at), so a pending settle
   * surviving it would be a phantom alert for a session the user just closed.
   */
  it('cancels a pending settle when the session is stopped deliberately, firing nothing', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    useActivityStore.getState().applyActivityEvent(sessionEndedEvent(true));
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

    expect(displayNotification).not.toHaveBeenCalled();
  });

  /**
   * A PARK, which reaches the phone by a different route than an end and so was
   * not covered by the two tests above. The desktop answers a read-stream
   * subscribe for a suspended session with `sessionStatus: 'suspended'` rather
   * than pushing `session-ended`, so `feedStatus` stays 'live' and the settle
   * survived: 45s later the user got "Agent went idle" for an agent the desktop
   * had already put down.
   *
   * This pins the SUBSCRIBER-CANCEL path only, and deliberately claims no more
   * than that. The snapshot is a store transition, so the subscriber observes
   * it and clears the timer before the clock is advanced, which means the
   * fire-time re-read never runs here at all. It shares the same predicate as
   * its backstop, but a test that advanced past a cancelled timer cannot tell
   * a working backstop from an absent one.
   */
  it('cancels a pending settle when a resubscribe reveals the session was parked', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    useActivityStore
      .getState()
      .applySnapshot(
        'sess-1',
        'task-1',
        'project-1',
        streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'suspended' }),
      );
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

    expect(displayNotification).not.toHaveBeenCalled();
  });

  /**
   * The other side of the same clause: ONLY 'suspended' is excluded. Without
   * these, the fix above would pass just as well if it had disabled
   * turn-complete for every session that gets re-snapshotted mid-window - which
   * a reconnect does to all of them at once.
   *
   * 'exited' is the one that carries real weight, and is why this list is not
   * just 'running'. It is a DELIBERATE KEEP: the protocol calls it a snapshot
   * racing teardown, and the `session-ended` push stays the authority on
   * endedness because it carries `intentional`, which a snapshot cannot. So an
   * exited snapshot must still let the alert through. Narrowing the clause to
   * `sessionStatus === 'running'` would mute a genuine crash alert and, without
   * this case, would pass every other test in the file.
   *
   * 'queued' is here as the SYNTHETIC case, and is labelled so nobody reads it
   * as evidence about real traffic: a queued placeholder has no PTY and a fresh
   * session id, so a real one is created idle and never reports thinking, which
   * means it can never arm a settle at all. Driving it here through explicit
   * thinking/idle events is the only way to reach the predicate with that
   * status. What it pins is that the new clause narrows to 'suspended' alone
   * and did not quietly become "any non-running status suppresses".
   */
  it.each(['running', 'exited', 'queued'] as const)(
    'leaves a pending settle armed when a resubscribe shows the session %s',
    (sessionStatus) => {
      seedSession();
      stopNotifier = startLocalNotifier();
      appStateMock.emit('background');

      useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
      useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus }));
      vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

      expect(displayNotification).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * THE RESUME, which the park test above cannot reach and which the
   * suppression would otherwise break permanently.
   *
   * There is NO second snapshot here, on purpose: `sessionStatus` is written
   * only by applySnapshot, and nothing re-subscribes a stream that is already
   * active on a live channel, so a resume genuinely arrives as activity events
   * and nothing else. Before the store retired a stale 'suspended' on
   * 'thinking', this session stayed suppressed for the rest of the connection
   * and the user silently stopped being told its agent had gone idle.
   */
  it('fires again once the parked session resumes and finishes another turn', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore
      .getState()
      .applySnapshot(
        'sess-1',
        'task-1',
        'project-1',
        streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'suspended' }),
      );

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

    expect(displayNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * The one thing the fire-time re-read actually catches that cancellation
   * cannot. This is a store SUBSCRIPTION, so every transition is observed and
   * already cancels - but an entry can VANISH between arming and firing (pruned
   * for a session no board claims, or cleared by a store reset on unpair), and
   * there is no transition to observe for that.
   */
  it('drops a pending settle whose session is gone from the store by fire time', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    useActivityStore.getState().reset();
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

    expect(displayNotification).not.toHaveBeenCalled();
  });

  /**
   * idleSettleTimers is a Map keyed by sessionId, and every test above drives a
   * single session - nothing has proven that two sessions' settle timers are
   * actually independent rather than, say, sharing one timer keyed off the
   * last session touched. Cancelling one session's settle (by sending it back
   * to work) must leave a second, concurrently-idling session's own timer
   * alone, still firing at ITS deadline.
   */
  it('isolates the idle-settle timer per session: cancelling one leaves a concurrently-idling session armed', () => {
    useBoardStore.getState().applyBoardSnapshot(
      boardSnapshotFixture({
        projectId: 'project-1',
        tasks: [
          boardTaskFixture({ id: 'task-1', session_id: 'sess-1', title: 'Ship the release' }),
          boardTaskFixture({ id: 'task-2', session_id: 'sess-2', title: 'Fix the flaky test' }),
        ],
      }),
    );
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().registerSession('sess-2', 'task-2', 'project-1');
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    // Both sessions settle into idle at the same moment, arming two
    // independent timers.
    useActivityStore.getState().applyActivityEvent(activityStateEventForSession('sess-1', 'task-1', 'thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEventForSession('sess-1', 'task-1', 'idle'));
    useActivityStore.getState().applyActivityEvent(activityStateEventForSession('sess-2', 'task-2', 'thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEventForSession('sess-2', 'task-2', 'idle'));

    // Halfway through the window, sess-1 goes back to work - cancelling ONLY
    // its own timer - while sess-2 stays settled.
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS / 2);
    useActivityStore.getState().applyActivityEvent(activityStateEventForSession('sess-1', 'task-1', 'thinking'));

    // sess-2's original deadline passes here; sess-1's was cancelled, so only
    // sess-2's notification fires.
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS / 2);
    expect(displayNotification).toHaveBeenCalledTimes(1);
    expect(displayNotification.mock.calls[0][0].data).toEqual({
      category: 'turn-complete',
      taskId: 'task-2',
      projectId: 'project-1',
      sessionId: 'sess-2',
      postedAt: String(nowMs),
    });

    // sess-1 never fires at all, even well past where its cancelled timer
    // would have landed.
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);
    expect(displayNotification).toHaveBeenCalledTimes(1);
  });

  /** A timer surviving the stop would fire into a foregrounded app, or a later test. */
  it('clears a pending settle timer when the notifier is stopped', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    stopNotifier();
    stopNotifier = null;
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);

    expect(displayNotification).not.toHaveBeenCalled();
  });

  it('applies a 30s per-(session, kind) cooldown', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification).toHaveBeenCalledTimes(1);

    // A second prompt inside the window is swallowed by the cooldown.
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1', false));
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-2'));
    expect(displayNotification).toHaveBeenCalledTimes(1);

    // Past the window it fires again.
    nowMs += 31_000;
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-2', false));
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-3'));
    expect(displayNotification).toHaveBeenCalledTimes(2);
  });

  /**
   * One stable id per session and category, so the repeat past the cooldown
   * REPLACES the first alert instead of stacking under it (and a remote push
   * for the same session and category replaces it too).
   */
  it('posts every alert for one session and category under one stable id', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    nowMs += 31_000;
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1', false));
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-2'));

    expect(displayNotification).toHaveBeenCalledTimes(2);
    expect(displayNotification.mock.calls[0][0].id).toBe('kangentic:input-required:session:sess-1');
    expect(displayNotification.mock.calls[1][0].id).toBe('kangentic:input-required:session:sess-1');
    // Each posting stamps its own time, which the tap latch tells reposts apart by.
    expect(displayNotification.mock.calls[0][0].data?.postedAt).not.toBe(displayNotification.mock.calls[1][0].data?.postedAt);
  });

  /**
   * The reconciler cancels an alert the moment it stops being true. Its
   * cooldown must go with it: otherwise the answer at the desk clears prompt-1's
   * alert and the cooldown then swallows prompt-2's, so the phone shows NOTHING
   * where before it at least kept the stale first alert.
   *
   * Mutation that reddens this: drop the dismissal subscription in
   * startLocalNotifier. Seen red that way.
   */
  it('releases the cooldown of an alert the reconciler dismissed, so the next prompt still alerts', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification).toHaveBeenCalledTimes(1);
    publishNotificationDismissed({
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      sessionKind: null,
      authored: false,
    });

    nowMs += 5_000;
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1', false));
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-2'));
    expect(displayNotification).toHaveBeenCalledTimes(2);
  });

  it('tells the reconciler what it posted, with the prompt the alert is about', async () => {
    const notes: DisplayedNotificationNote[] = [];
    const unsubscribe = subscribeToDisplayedNotifications((note) => notes.push(note));
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    // The note follows the display's promise. Drained by hand: this file fakes
    // setTimeout, so the shared macrotask flush would never resolve.
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    unsubscribe();

    expect(notes).toEqual([
      {
        platformId: 'notification-id',
        routing: { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false },
        postedAt: nowMs,
        promptIdAtPost: 'prompt-1',
      },
    ]);
  });

  /**
   * The prompt id is how the reconciler knows WHICH question an alert asked, so
   * it belongs to input-required alone. A session-failed alert is posted for a
   * session that died mid-prompt: `session-ended` sets feedStatus and leaves
   * awaitedPromptId on the entry (activityStore.ts), so the entry the notifier
   * reads at fire time still holds 'prompt-1'. Noting that against the failure
   * alert would tie it to a question that can never be answered, and the
   * reconciler would then judge a crash notice by a prompt it was never about.
   *
   * Mutation that reddens this: drop the category gate in fire(), so
   * promptIdAtPost is `entry.awaitedPromptId` for every category. Seen red that
   * way (session-failed noted 'prompt-1' instead of null).
   */
  it('notes a session-failed alert with no prompt even though the dead session still holds the one it was awaiting', async () => {
    const notes: DisplayedNotificationNote[] = [];
    const unsubscribe = subscribeToDisplayedNotifications((note) => notes.push(note));
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    useActivityStore.getState().applyActivityEvent(sessionEndedEvent(false));
    await drainDisplayPromises();
    unsubscribe();

    // The precondition that makes this discriminating: the stale prompt is there.
    expect(useActivityStore.getState().bySessionId['sess-1'].awaitedPromptId).toBe('prompt-1');
    expect(displayNotification).toHaveBeenCalledTimes(2);
    expect(notes.map((note) => ({ category: note.routing?.category, promptIdAtPost: note.promptIdAtPost }))).toEqual([
      { category: 'input-required', promptIdAtPost: 'prompt-1' },
      { category: 'session-failed', promptIdAtPost: null },
    ]);
  });

  /**
   * The same rule for a settled turn-complete. Through activity events alone a
   * settled-idle entry always has a null prompt (leaving 'permission' clears
   * it), so a snapshot is the only way to put a non-null id on one: a
   * re-subscribe landing while the engine reclassifies. That is a SYNTHETIC
   * entry, labelled so nobody reads it as real traffic; what it pins is that
   * the notifier takes the id from the category, not from whatever the entry
   * happens to hold.
   *
   * Mutation that reddens this: the same one as above, dropping the category
   * gate in fire(). Seen red that way (turn-complete noted 'prompt-stale').
   */
  it('notes a settled turn-complete with no prompt even when the entry carries a stale prompt id', async () => {
    const notes: DisplayedNotificationNote[] = [];
    const unsubscribe = subscribeToDisplayedNotifications((note) => notes.push(note));
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    useActivityStore
      .getState()
      .applySnapshot(
        'sess-1',
        'task-1',
        'project-1',
        streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running', awaitedPromptId: 'prompt-stale' }),
      );
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);
    await drainDisplayPromises();
    unsubscribe();

    expect(useActivityStore.getState().bySessionId['sess-1'].awaitedPromptId).toBe('prompt-stale');
    expect(displayNotification).toHaveBeenCalledTimes(1);
    expect(notes).toEqual([
      {
        platformId: 'notification-id',
        routing: { category: 'turn-complete', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false },
        postedAt: nowMs,
        promptIdAtPost: null,
      },
    ]);
  });

  /**
   * An alert posted before the category rode along has no category, and
   * without one there is no cooldown key to release: it must release nothing
   * rather than guess one. If it released the session's input-required key, a
   * legacy dismissal would reopen the window for a different, still-live alert
   * and the alerts would stack, which is what the cooldown exists to prevent.
   *
   * Note what this does NOT pin: deleting the `category === null` early return
   * alone stays green, because the key it would then build ('sess-1:null')
   * matches nothing. The guard is what the type checker needs, and this test is
   * the contract that no mapping of null to a category ever sneaks in behind it.
   *
   * Mutation that reddens this: make the dismissal handler clear the whole
   * cooldown map when `routing.category === null` instead of returning. Seen
   * red that way (the second prompt posted, 2 calls where 1 was expected).
   */
  it('keeps the cooldown when the dismissed alert carried no category', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification).toHaveBeenCalledTimes(1);
    publishNotificationDismissed({ category: null, taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false });

    nowMs += 5_000;
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1', false));
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-2'));
    expect(displayNotification).toHaveBeenCalledTimes(1);

    // The swallow was the cooldown, and it lapses on schedule.
    nowMs += 31_000;
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-2', false));
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-3'));
    expect(displayNotification).toHaveBeenCalledTimes(2);
  });

  /**
   * A stopped notifier must not stay subscribed to dismissals. A leaked
   * listener cannot be seen from outside by its effect (it would delete from
   * the cleared, orphaned cooldown map) and cannot throw (the signals module
   * swallows a throwing listener), so the subscription itself is what this
   * counts: it wraps the real subscribe and tallies the ones still live.
   *
   * Mutation that reddens this: drop `unsubscribeDismissals()` from the stop
   * function in startLocalNotifier. Seen red that way (1 live subscription
   * after the stop, 0 expected).
   */
  it('removes its dismissal subscription when stopped, so a dismissal after the stop reaches nothing', () => {
    const realSubscribe = notificationSignals.subscribeToNotificationDismissals;
    let liveDismissalSubscriptions = 0;
    const subscribeSpy = vi.spyOn(notificationSignals, 'subscribeToNotificationDismissals').mockImplementation((listener) => {
      const removeSubscription = realSubscribe(listener);
      liveDismissalSubscriptions += 1;
      let removed = false;
      return () => {
        if (!removed) liveDismissalSubscriptions -= 1;
        removed = true;
        removeSubscription();
      };
    });
    try {
      seedSession();
      stopNotifier = startLocalNotifier();
      appStateMock.emit('background');
      expect(liveDismissalSubscriptions).toBe(1);
      useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
      expect(displayNotification).toHaveBeenCalledTimes(1);

      stopNotifier();
      stopNotifier = null;
      expect(liveDismissalSubscriptions).toBe(0);
      expect(() =>
        publishNotificationDismissed({
          category: 'input-required',
          taskId: 'task-1',
          projectId: 'project-1',
          sessionId: 'sess-1',
          sessionKind: null,
          authored: false,
        }),
      ).not.toThrow();

      // A fresh start owns its own subscription and cooldown, and fires normally.
      stopNotifier = startLocalNotifier();
      expect(liveDismissalSubscriptions).toBe(1);
      useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1', false));
      useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-2'));
      expect(displayNotification).toHaveBeenCalledTimes(2);
    } finally {
      subscribeSpy.mockRestore();
    }
  });

  it('falls back to a generic body when the board has no matching task', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification.mock.calls[0][0].body).toBe('Agent session');
  });

  /**
   * Task alerts must not grow a `sessionKind` key now that Command Terminals
   * share this notifier. notifee's `data` is string-valued, so a present
   * `sessionKind: undefined` would be rejected at display time; toStrictEqual is
   * what tells an absent key from an undefined one (toEqual cannot).
   *
   * Mutation that reddens this: add `sessionKind: entry.kind` (or `undefined`)
   * to the base routing object in routingDataFor.
   */
  it('keeps a task alert\'s data to exactly its category, ids and posting time, with no sessionKind key', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));

    expect(displayNotification).toHaveBeenCalledTimes(1);
    const { data } = displayNotification.mock.calls[0][0];
    expect(data).toStrictEqual({
      category: 'input-required',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      postedAt: String(nowMs),
    });
    expect(Object.keys(data ?? {})).not.toContain('sessionKind');
  });

  describe('a Command Terminal alert', () => {
    const TERMINAL_SESSION_ID = 'terminal-sess-1';

    /** The desktop stamps a terminal's events with a made-up task id that names no board row. */
    function terminalPermissionEvent(promptId: string): ActivityEvent {
      return {
        kind: 'activity',
        sessionId: TERMINAL_SESSION_ID,
        taskId: 'made-up-terminal-task',
        payload: { type: 'permission', promptId, pending: true },
      };
    }

    function listTerminalOnBoard(name: string): void {
      useBoardStore.getState().applyBoardSnapshot(
        boardSnapshotFixture({
          projectId: 'project-1',
          tasks: [],
          commandTerminals: [
            { sessionId: TERMINAL_SESSION_ID, projectId: 'project-1', slot: 1, name, named: true, activity: { state: 'idle', reason: null } },
          ],
          commandTerminalsOffered: true,
        }),
      );
    }

    /**
     * A terminal has no task, so its alert is named by the board's listing of
     * it and carries `sessionKind` so a tap opens the terminal by its session
     * (tapRouter) instead of an empty task id as a task. `taskId` is the empty
     * string: the activity store never records the desktop's made-up id.
     *
     * Mutation that reddens this: drop the `sessionKind` spread from
     * routingDataFor (data comes back without the key), or name the body from
     * `boardsByProjectId[...].tasksById[entry.taskId]` unconditionally ('Agent
     * session').
     */
    it('is named by its board listing and carries sessionKind for the tap router', () => {
      listTerminalOnBoard('Fix The Flaky Test');
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, 'project-1');
      stopNotifier = startLocalNotifier();
      appStateMock.emit('background');

      useActivityStore.getState().applyActivityEvent(terminalPermissionEvent('prompt-1'));

      expect(displayNotification).toHaveBeenCalledTimes(1);
      const notification = displayNotification.mock.calls[0][0];
      expect(notification.title).toBe('Agent needs your input');
      expect(notification.body).toBe('Fix The Flaky Test');
      expect(notification.android?.channelId).toBe('needs-attention');
      expect(notification.data).toStrictEqual({
        category: 'input-required',
        taskId: '',
        projectId: 'project-1',
        sessionId: TERMINAL_SESSION_ID,
        sessionKind: 'command-terminal',
        postedAt: String(nowMs),
      });
      // Keyed on the session: a terminal has no task to fall back on.
      expect(notification.id).toBe(`kangentic:input-required:session:${TERMINAL_SESSION_ID}`);
    });

    it('falls back to "Command Terminal" when no board lists the terminal, never the task fallback', () => {
      // Registered but unlisted: a board snapshot has not named it yet, or has
      // already dropped it (its end removes it from the listing).
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, 'project-1');
      stopNotifier = startLocalNotifier();
      appStateMock.emit('background');

      useActivityStore.getState().applyActivityEvent(terminalPermissionEvent('prompt-1'));

      expect(displayNotification).toHaveBeenCalledTimes(1);
      expect(displayNotification.mock.calls[0][0].body).toBe('Command Terminal');
      expect(displayNotification.mock.calls[0][0].body).not.toBe('Agent session');
    });

    it('follows a rename: the next alert carries the terminal\'s new listed name', () => {
      listTerminalOnBoard('Command Terminal 1');
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, 'project-1');
      stopNotifier = startLocalNotifier();
      appStateMock.emit('background');

      useActivityStore.getState().applyActivityEvent(terminalPermissionEvent('prompt-1'));
      expect(displayNotification.mock.calls[0][0].body).toBe('Command Terminal 1');

      // Past the cooldown, with the desktop having named the terminal from its first prompt.
      nowMs += 31_000;
      listTerminalOnBoard('Fix The Flaky Test');
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: TERMINAL_SESSION_ID,
        taskId: 'made-up-terminal-task',
        payload: { type: 'permission', promptId: 'prompt-1', pending: false },
      });
      useActivityStore.getState().applyActivityEvent(terminalPermissionEvent('prompt-2'));

      expect(displayNotification).toHaveBeenCalledTimes(2);
      expect(displayNotification.mock.calls[1][0].body).toBe('Fix The Flaky Test');
    });

    it('does not read a task off the board for a terminal whose id collides with a task\'s', () => {
      // A task titled like the terminal's made-up task id would be the "name" if
      // the terminal were resolved as a task. The kind, not the id, decides.
      useBoardStore.getState().applyBoardSnapshot(
        boardSnapshotFixture({
          projectId: 'project-1',
          tasks: [boardTaskFixture({ id: 'made-up-terminal-task', session_id: null, title: 'A real task with that id' })],
        }),
      );
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, 'project-1');
      stopNotifier = startLocalNotifier();
      appStateMock.emit('background');

      useActivityStore.getState().applyActivityEvent(terminalPermissionEvent('prompt-1'));

      expect(displayNotification.mock.calls[0][0].body).toBe('Command Terminal');
    });
  });

  it('a category disabled in settings never fires locally, even backgrounded and off cooldown', () => {
    seedSession();
    useSettingsStore.getState().setPushCategoryEnabled('input-required', false);
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification).not.toHaveBeenCalled();

    // A different, still-enabled category is unaffected.
    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);
    expect(displayNotification).toHaveBeenCalledTimes(1);
  });

  it('a disabled turn-complete category never fires locally on a settled thinking-to-idle transition', () => {
    seedSession();
    useSettingsStore.getState().setPushCategoryEnabled('turn-complete', false);
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
    vi.advanceTimersByTime(EXPECTED_IDLE_SETTLE_MS);
    expect(displayNotification).not.toHaveBeenCalled();
  });

  it('reads the settings store live: disabling then re-enabling a category during the same run suppresses then resumes firing', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useSettingsStore.getState().setPushCategoryEnabled('input-required', false);
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification).not.toHaveBeenCalled();

    // Past the cooldown window so a re-fire on the same session/category is
    // not itself suppressed by the cooldown rather than the toggle.
    nowMs += 31_000;
    useSettingsStore.getState().setPushCategoryEnabled('input-required', true);
    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-2'));

    // If fire() had snapshotted the store at startLocalNotifier() time
    // instead of reading it live, this re-enable would never take effect
    // for the rest of this run and the notification would stay suppressed.
    expect(displayNotification).toHaveBeenCalledTimes(1);
    expect(displayNotification.mock.calls[0][0].title).toBe('Agent needs your input');
  });

  it('stops firing after the returned stop function runs', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');
    stopNotifier();
    stopNotifier = null;

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification).not.toHaveBeenCalled();
  });
});
