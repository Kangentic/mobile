/**
 * The killed-app data-message path: blob extraction from the shapes
 * expo-notifications delivers, and the hard guarantee that a failed
 * decrypt displays the generic placeholder - never ciphertext
 * (e2e-notification-privacy.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportState } from '@kangentic/protocol';
import { brandTokens } from '@/components/theme/tokens';
import { flushMicrotasks } from '../helpers/async';

const secureStoreState = vi.hoisted(() => ({ storedValues: new Map<string, string>() }));
const taskManagerState = vi.hoisted(() => ({
  defineTask: vi.fn(),
  registerTaskAsync: vi.fn(async () => null),
  displayNotification: vi.fn(async (_notification: unknown) => 'notification-id'),
  createChannels: vi.fn(async () => undefined),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreState.storedValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.storedValues.set(key, value);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.mock('expo-task-manager', () => ({
  defineTask: taskManagerState.defineTask,
}));

/**
 * `currentState` is deliberately typed to include the values a HEADLESS launch
 * produces. There is no Activity in a killed-app task, so React Native has no
 * app state to report and this reads back null or 'unknown' rather than
 * 'background' - which is why the gate under test suppresses only on a
 * provable 'active'.
 */
const appStateMock = vi.hoisted(() => ({ currentState: 'background' as string | null }));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appStateMock.currentState;
    },
  },
}));

vi.mock('expo-notifications', () => ({
  registerTaskAsync: taskManagerState.registerTaskAsync,
}));

vi.mock('@notifee/react-native', () => ({
  default: {
    displayNotification: taskManagerState.displayNotification,
    createChannels: taskManagerState.createChannels,
  },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

const decryptPushBlobMock = vi.hoisted(() => vi.fn<(blob: string) => Promise<unknown>>());

/**
 * Captured so the mock can DELEGATE to the real decrypt by default. Only the
 * test that needs a successful decrypt overrides it (with mockResolvedValueOnce,
 * which takes precedence). Without this default, a bare vi.fn() returns
 * undefined, and the placeholder test below would reach its branch by
 * coincidence rather than by exercising the real decrypt-failure path that
 * e2e-notification-privacy.md exists to protect.
 */
const pushDecryptState = vi.hoisted(() => ({
  realDecryptPushBlob: null as ((blob: string) => Promise<unknown>) | null,
}));

vi.mock('@/notifications/pushDecrypt', async () => {
  const actual = await vi.importActual<typeof import('@/notifications/pushDecrypt')>('@/notifications/pushDecrypt');
  pushDecryptState.realDecryptPushBlob = actual.decryptPushBlob;
  return { ...actual, decryptPushBlob: decryptPushBlobMock };
});

type BackgroundPushTaskModule = typeof import('@/notifications/backgroundPushTask');

async function loadModule(): Promise<BackgroundPushTaskModule> {
  return import('@/notifications/backgroundPushTask');
}

/**
 * Both this and loadModule() run after the beforeEach vi.resetModules(), so
 * they share one fresh module registry: the store instance set here IS the one
 * the task under test reads. Untouched, it sits at its real initial state
 * ('idle', not established), which is exactly what a headless launch sees.
 */
async function setChannelState(state: { established: boolean; transportState: TransportState }): Promise<void> {
  const { useChannelStore } = await import('@/state/channelStore');
  useChannelStore.setState(state);
}

type TaskExecutor = (body: { data: unknown; error: null; executionInfo: { taskName: string } }) => Promise<void> | void;

describe('backgroundPushTask', () => {
  beforeEach(() => {
    vi.resetModules();
    appStateMock.currentState = 'background';
    secureStoreState.storedValues.clear();
    taskManagerState.defineTask.mockClear();
    taskManagerState.registerTaskAsync.mockClear();
    taskManagerState.displayNotification.mockClear();
    taskManagerState.createChannels.mockClear();
    decryptPushBlobMock.mockReset();
    decryptPushBlobMock.mockImplementation(async (blob) => {
      const { realDecryptPushBlob } = pushDecryptState;
      if (realDecryptPushBlob === null) {
        throw new Error('pushDecrypt mock invoked before the mocked module was ever imported');
      }
      return realDecryptPushBlob(blob);
    });
  });

  it('extracts the blob from the direct and dataString-wrapped payload shapes', async () => {
    const { extractBlobFromTaskData } = await loadModule();
    expect(extractBlobFromTaskData({ blob: 'direct-blob' })).toBe('direct-blob');
    expect(extractBlobFromTaskData({ dataString: JSON.stringify({ blob: 'wrapped-blob' }) })).toBe('wrapped-blob');
    expect(extractBlobFromTaskData({ body: JSON.stringify({ blob: 'body-blob' }) })).toBe('body-blob');
    expect(extractBlobFromTaskData({ dataString: 'not json' })).toBeNull();
    expect(extractBlobFromTaskData({ other: 'field' })).toBeNull();
    expect(extractBlobFromTaskData('a string')).toBeNull();
    expect(extractBlobFromTaskData(null)).toBeNull();
  });

  it('registers the task once and displays the placeholder when the blob cannot be decrypted', async () => {
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    registerBackgroundPushTask();

    expect(taskManagerState.defineTask).toHaveBeenCalledTimes(1);
    expect(taskManagerState.registerTaskAsync).toHaveBeenCalledTimes(1);

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
    const notification = taskManagerState.displayNotification.mock.calls[0][0] as {
      title: string;
      body: string;
      android?: { channelId?: string; smallIcon?: string; color?: string };
    };
    expect(notification.title).toBe('Kangentic');
    expect(notification.body).toBe('Agent needs attention');
    expect(notification.android?.channelId).toBe('needs-attention');
    // Notifee defaults smallIcon to ic_launcher (a full-colour asset the OS
    // strips to a silhouette) unless set explicitly - see channels.ts.
    expect(notification.android?.smallIcon).toBe('notification_icon');
    expect(notification.android?.color).toBe(brandTokens.rust);
  });

  it('displays the rich notification, with the branded small icon and color, when the blob decrypts', async () => {
    decryptPushBlobMock.mockResolvedValueOnce({
      title: 'Agent needs your input',
      body: 'Ship the release',
      category: 'input-required',
      data: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' },
    });
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
    const notification = taskManagerState.displayNotification.mock.calls[0][0] as {
      title: string;
      body: string;
      android?: { channelId?: string; smallIcon?: string; color?: string };
    };
    expect(notification.title).toBe('Agent needs your input');
    expect(notification.body).toBe('Ship the release');
    expect(notification.android?.channelId).toBe('needs-attention');
    expect(notification.android?.smallIcon).toBe('notification_icon');
    expect(notification.android?.color).toBe(brandTokens.rust);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR SECOND-MOST, after the decrypt-failure
   * placeholder above.
   *
   * The rich display and the placeholder used to share one try block in the
   * caller, so a throw on the DECRYPTED branch escaped past the placeholder
   * into the task's outer catch and the user saw nothing at all - a successful
   * decrypt producing strictly less than a failed one. It matters more than it
   * looks: the Android push is data-only by design, so there is no OS-drawn
   * notification behind this to fall back on. Whatever this task fails to post
   * is never seen.
   */
  it('falls back to the placeholder when the rich notification itself fails to display', async () => {
    decryptPushBlobMock.mockResolvedValueOnce({
      title: 'Agent needs your input',
      body: 'Ship the release',
      category: 'input-required',
      data: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' },
    });
    // A blocked or missing category channel fails the rich post while the plain
    // placeholder on needs-attention still lands.
    taskManagerState.displayNotification.mockRejectedValueOnce(new Error('channel blocked'));
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(2);
    const fallback = taskManagerState.displayNotification.mock.calls[1][0] as {
      title: string;
      body: string;
      android?: { channelId?: string };
    };
    expect(fallback.title).toBe('Kangentic');
    expect(fallback.body).toBe('Agent needs attention');
    expect(fallback.android?.channelId).toBe('needs-attention');
  });

  /**
   * initializeNotifications() creates the channels as an UNAWAITED `void` call
   * issued right after this task is registered, so on a cold headless launch
   * the display can outrun it and notifee rejects a post against a channel that
   * does not exist yet. Asserted as a genuine await rather than mere call
   * ordering: the display must not fire while channel creation is still
   * in flight.
   */
  it('awaits channel creation before displaying', async () => {
    let releaseChannels: () => void = () => {};
    taskManagerState.createChannels.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseChannels = () => resolve(undefined);
        }),
    );
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    const pendingTask = executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    await flushMicrotasks();
    expect(taskManagerState.createChannels).toHaveBeenCalledTimes(1);
    expect(taskManagerState.displayNotification).not.toHaveBeenCalled();

    releaseChannels();
    await pendingTask;
    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * THE RACE THE AWAIT ABOVE ACTUALLY HAS TO SURVIVE, and the one the test
   * above cannot see. index.js runs initializeNotifications() at bundle entry
   * on EVERY launch, headless included, and it fires createNotificationChannels()
   * unawaited right after registering this task (index.ts). So in production the
   * task's own call is never the first one. Against a guard that latches a
   * boolean synchronously before its own await, that made the task's await
   * return immediately and wait on nothing - precisely the race it was added to
   * close - while the test above passed, because loading backgroundPushTask
   * directly makes its call the first.
   */
  it('waits for a channel creation already started at bundle entry', async () => {
    let releaseChannels: () => void = () => {};
    taskManagerState.createChannels.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseChannels = () => resolve(undefined);
        }),
    );
    const { registerBackgroundPushTask } = await loadModule();
    const { createNotificationChannels } = await import('@/notifications/channels');
    // The order index.ts uses: register the task, then kick creation off unawaited.
    registerBackgroundPushTask();
    void createNotificationChannels();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    const pendingTask = executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    await flushMicrotasks();
    expect(taskManagerState.createChannels).toHaveBeenCalledTimes(1);
    expect(taskManagerState.displayNotification).not.toHaveBeenCalled();

    releaseChannels();
    await pendingTask;
    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * A failed creation must not LATCH. A guard that records "created" before the
   * native call resolves, and never clears on rejection, turns one transient
   * failure into silence for the life of the process: the channels do not exist
   * OS-side, every later call returns immediately believing they do, and both
   * the rich notification and the placeholder behind it fail. The Android push
   * is data-only, so nothing else is going to draw it.
   */
  it('retries channel creation on the next push after a failed attempt', async () => {
    taskManagerState.createChannels.mockRejectedValueOnce(new Error('notifee unavailable'));
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    const incomingPush = {
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    };
    await executor(incomingPush);
    await executor(incomingPush);

    expect(taskManagerState.createChannels).toHaveBeenCalledTimes(2);
  });

  /**
   * A channel-creation failure must not take the display down with it: by far
   * the common case is that the channels already exist OS-side from an earlier
   * launch and the call had nothing to do.
   */
  it('still displays when channel creation fails', async () => {
    taskManagerState.createChannels.mockRejectedValueOnce(new Error('notifee unavailable'));
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * Registration failure was previously unobservable - nothing read the task
   * name - so an install that could never receive a push still reported
   * "Remote push: registered" in Settings, the one label that is actively wrong.
   */
  it('records the receive task as unavailable when registerTaskAsync rejects', async () => {
    taskManagerState.registerTaskAsync.mockRejectedValueOnce(new Error('no FCM credentials'));
    const { registerBackgroundPushTask, getBackgroundPushTaskStatus } = await loadModule();
    expect(getBackgroundPushTaskStatus()).toBe('pending');

    registerBackgroundPushTask();
    await flushMicrotasks();

    expect(getBackgroundPushTaskStatus()).toBe('unavailable');
  });

  it('records the receive task as registered when registerTaskAsync resolves', async () => {
    const { registerBackgroundPushTask, getBackgroundPushTaskStatus } = await loadModule();
    registerBackgroundPushTask();
    await flushMicrotasks();

    expect(getBackgroundPushTaskStatus()).toBe('registered');
  });

  it('ignores notification-response payloads (action taps are the tap router job)', async () => {
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;

    await executor({
      data: { actionIdentifier: 'default', notification: {} },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
  });

  /**
   * Nothing fires over the top of a live session the user is watching. The
   * desktop already skips devices with a live bridge session, but that is
   * coarse - a relay hiccup, a reconnect, or the five-minute keepalive ceiling
   * landing while the user is actually looking at the app all get a push
   * through - so the display gates on app state and channel state together.
   */
  it('suppresses the display while the app is foregrounded and connected', async () => {
    appStateMock.currentState = 'active';
    await setChannelState({ established: true, transportState: 'connected' });
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;

    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
  });

  /**
   * THE CHANNEL POLARITY, and the reason the gate is not a bare `established`
   * read. `established` drops on EVERY transport blip (channelStore.ts), so
   * gating on it alone would fire a heads-up notification over the UI during a
   * momentary reconnect - reintroducing precisely the noise the guard above
   * exists to stop. Only 'idle' and 'closed' mean nothing is even trying, which
   * is the one case worth waking someone for: foregrounded, disconnected, and
   * otherwise about to miss the alert entirely.
   */
  it.each([
    ['connecting' as TransportState, 0],
    ['reconnecting' as TransportState, 0],
    // Handshaking: the transport is up and `established` is moments away.
    ['connected' as TransportState, 0],
    ['idle' as TransportState, 1],
    ['closed' as TransportState, 1],
  ])('foregrounded but not established, transport %s, displays %i time(s)', async (transportState, expectedDisplays) => {
    appStateMock.currentState = 'active';
    await setChannelState({ established: false, transportState });
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;

    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(expectedDisplays);
  });

  /**
   * Pins the `established ||` half of the gate, which every other test leaves
   * redundant: `setTransportState` clears `established` on any move away from
   * 'connected' (channelStore.ts), so the two conditions only ever co-occur in
   * the states the transport half already covers. That invariant lives in
   * another file and could be relaxed there without anyone touching this one,
   * which is exactly when a silently-redundant disjunct becomes load-bearing.
   * Set directly, because the store's own reducers cannot produce this pair.
   */
  it('suppresses on `established` even if the transport state says otherwise', async () => {
    appStateMock.currentState = 'active';
    await setChannelState({ established: true, transportState: 'idle' });
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;

    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
  });

  /**
   * THE POLARITY TEST, and the reason the gate is `=== 'active'` rather than
   * `!== 'background'`. A killed-app launch has no Activity, so AppState has no
   * state to report: React Native hands back null or 'unknown'. Mirroring the
   * local notifier's inversion here would read those as "not background" and
   * silently kill the killed-app push path - the entire feature this task is.
   */
  it.each([['background'], ['inactive'], ['unknown'], [null]])('still displays when app state reads %s', async (state) => {
    appStateMock.currentState = state;
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;

    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * watchingAlready()'s own try/catch is new and deliberately FAILS OPEN.
   * Nothing it reads should ever throw (AppState.currentState is a plain
   * getter, channelStore.getState() touches no I/O), but the gate is written
   * defensively anyway: treating a read failure as "already watching" would
   * suppress every push for the life of the process on a device where it
   * somehow does throw, which is the same silent-forever failure mode
   * e2e-notification-privacy.md exists to prevent, just reached a different
   * way than the channel-latch one above.
   */
  it('fails open and still displays when reading the watching-gate state throws', async () => {
    appStateMock.currentState = 'active';
    const { useChannelStore } = await import('@/state/channelStore');
    const getStateSpy = vi.spyOn(useChannelStore, 'getState').mockImplementation(() => {
      throw new Error('channel store unavailable');
    });
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;

    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
    getStateSpy.mockRestore();
  });
});
