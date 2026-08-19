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
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
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
  return {
    kind: 'activity',
    sessionId: 'sess-1',
    taskId: 'task-1',
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
      pushCategoriesEnabled: { 'input-required': true, 'turn-complete': true, 'session-failed': true, 'plan-complete': true, 'spawn-stalled': true },
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
    expect(notification.data).toEqual({ taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' });
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
    expect(notification.data).toEqual({ taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' });
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

  it('falls back to a generic body when the board has no matching task', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(permissionEvent('prompt-1'));
    expect(displayNotification.mock.calls[0][0].body).toBe('Agent session');
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
