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

function activityStateEvent(state: 'thinking' | 'idle'): ActivityEvent {
  return {
    kind: 'activity',
    sessionId: 'sess-1',
    taskId: 'task-1',
    payload: { type: 'activity', state, reason: state === 'thinking' ? { kind: 'turn-active' } : { kind: 'idle' } },
  };
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

  it('fires turn-complete on the completions channel for a thinking-to-idle transition', () => {
    seedSession();
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    expect(displayNotification).not.toHaveBeenCalled();
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));

    expect(displayNotification).toHaveBeenCalledTimes(1);
    const notification = displayNotification.mock.calls[0][0];
    expect(notification.title).toBe('Turn complete');
    expect(notification.android?.channelId).toBe('completions');
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
    expect(displayNotification).toHaveBeenCalledTimes(1);
  });

  it('a disabled turn-complete category never fires locally on a thinking-to-idle transition', () => {
    seedSession();
    useSettingsStore.getState().setPushCategoryEnabled('turn-complete', false);
    stopNotifier = startLocalNotifier();
    appStateMock.emit('background');

    useActivityStore.getState().applyActivityEvent(activityStateEvent('thinking'));
    useActivityStore.getState().applyActivityEvent(activityStateEvent('idle'));
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
