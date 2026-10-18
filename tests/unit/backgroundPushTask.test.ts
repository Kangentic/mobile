/**
 * The killed-app data-message path: blob extraction from the shapes
 * expo-notifications delivers, and the hard guarantee that a failed
 * decrypt displays the generic placeholder - never ciphertext
 * (e2e-notification-privacy.md). And its one exception: a sealed clear
 * (protocol 0.23.0) displays NOTHING, on every path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bytesToHex,
  generateX25519KeyPair,
  randomBytes,
  sealPushClear,
  sealPushEnvelope,
  type PushClearEntry,
  type PushEnvelopePlaintext,
  type TransportState,
} from '@kangentic/protocol';
import { brandTokens } from '@/components/theme/tokens';
import { flushMicrotasks } from '../helpers/async';

const secureStoreState = vi.hoisted(() => ({ storedValues: new Map<string, string>() }));
const taskManagerState = vi.hoisted(() => ({
  defineTask: vi.fn(),
  registerTaskAsync: vi.fn(async () => null),
  displayNotification: vi.fn(async (_notification: unknown) => 'notification-id'),
  createChannels: vi.fn(async () => undefined),
  getDisplayedNotifications: vi.fn(async (): Promise<unknown[]> => []),
  cancelNotification: vi.fn(async (_notificationId: string) => undefined),
  getPresentedNotificationsAsync: vi.fn(async (): Promise<unknown[]> => []),
  dismissNotificationAsync: vi.fn(async (_identifier: string) => undefined),
}));
const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

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
    addEventListener: () => ({ remove: () => undefined }),
  },
  Platform: platformMock,
}));

vi.mock('expo-notifications', () => ({
  registerTaskAsync: taskManagerState.registerTaskAsync,
  getPresentedNotificationsAsync: taskManagerState.getPresentedNotificationsAsync,
  dismissNotificationAsync: taskManagerState.dismissNotificationAsync,
}));

vi.mock('@notifee/react-native', () => ({
  default: {
    displayNotification: taskManagerState.displayNotification,
    createChannels: taskManagerState.createChannels,
    getDisplayedNotifications: taskManagerState.getDisplayedNotifications,
    cancelNotification: taskManagerState.cancelNotification,
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
    platformMock.OS = 'android';
    secureStoreState.storedValues.clear();
    taskManagerState.defineTask.mockClear();
    taskManagerState.registerTaskAsync.mockClear();
    taskManagerState.displayNotification.mockClear();
    taskManagerState.createChannels.mockClear();
    taskManagerState.getDisplayedNotifications.mockReset();
    taskManagerState.getDisplayedNotifications.mockResolvedValue([]);
    taskManagerState.cancelNotification.mockClear();
    taskManagerState.getPresentedNotificationsAsync.mockReset();
    taskManagerState.getPresentedNotificationsAsync.mockResolvedValue([]);
    taskManagerState.dismissNotificationAsync.mockClear();
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
   * A repeat push for the same session and category must REPLACE the alert on
   * screen, so the decrypted post carries the stable id; its posting time rides
   * in `data` for the reconciler and the tap latch, and the reconciler is told
   * at once rather than at its next native read.
   */
  it('posts a decrypted alert under its stable id, stamps its posting time, and tells the reconciler', async () => {
    decryptPushBlobMock.mockResolvedValueOnce({
      title: 'Agent went idle',
      body: 'Ship the release',
      category: 'turn-complete',
      data: { category: 'turn-complete', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' },
    });
    const { registerBackgroundPushTask } = await loadModule();
    const { subscribeToDisplayedNotifications } = await import('@/notifications/notificationSignals');
    const notes: unknown[] = [];
    subscribeToDisplayedNotifications((note) => notes.push(note));
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    const notification = taskManagerState.displayNotification.mock.calls[0][0] as { id?: string; data?: Record<string, string> };
    expect(notification.id).toBe('kangentic:turn-complete:session:sess-1');
    expect(notification.data).toEqual({
      category: 'turn-complete',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      postedAt: expect.stringMatching(/^\d+$/),
    });
    expect(notes).toEqual([
      {
        platformId: 'notification-id',
        routing: { category: 'turn-complete', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null },
        postedAt: Number(notification.data?.postedAt),
        promptIdAtPost: null,
      },
    ]);
  });

  /**
   * The placeholder names nothing, so it keeps a random id and carries no
   * routing. Its posting time is the one thing it does carry: the reconciler
   * dismisses it only once every project was re-read AFTER it.
   */
  it('stamps the placeholder with its posting time and nothing else', async () => {
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    const notification = taskManagerState.displayNotification.mock.calls[0][0] as { id?: string; data?: Record<string, string> };
    expect(notification.id).toBeUndefined();
    expect(notification.data).toStrictEqual({ postedAt: expect.stringMatching(/^\d+$/) });
  });

  /**
   * The reconciler is told about the placeholder at once, not at its next native
   * read, or an alert posted by a killed-app launch would go untracked until the
   * app next opened. It names nothing, so it is noted with no routing and no
   * prompt. The platform id is queued as a distinct value so it cannot be
   * satisfied by the shared default every other display resolves to.
   *
   * Mutation that reddens this: delete the noteNotificationDisplayed call from
   * displayPlaceholder. Seen red that way (no note arrived, [] received).
   */
  it('tells the reconciler about the placeholder it posted, with no routing and no prompt', async () => {
    taskManagerState.displayNotification.mockResolvedValueOnce('placeholder-platform-id');
    const { registerBackgroundPushTask } = await loadModule();
    const { subscribeToDisplayedNotifications } = await import('@/notifications/notificationSignals');
    const notes: unknown[] = [];
    const unsubscribe = subscribeToDisplayedNotifications((note) => notes.push(note));
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });
    unsubscribe();

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
    const notification = taskManagerState.displayNotification.mock.calls[0][0] as { data?: Record<string, string> };
    // Guards the Number() below: an unstamped postedAt would read NaN, and NaN equals NaN.
    expect(notification.data?.postedAt).toMatch(/^\d+$/);
    expect(notes).toEqual([
      {
        platformId: 'placeholder-platform-id',
        routing: null,
        postedAt: Number(notification.data?.postedAt),
        promptIdAtPost: null,
      },
    ]);
  });

  /**
   * An envelope whose data names no category this build knows (an older
   * desktop that predates the field, or a newer one with a category added since)
   * still has to render, and a repeat cannot replace it because there is nothing
   * stable to key on. The id is therefore ABSENT, not `undefined`: notifee reads
   * an `id` key it finds, and a present-but-undefined one is not the same as
   * leaving the choice to it. The posting time still rides in data, and the
   * reconciler is told the alert carries no category.
   *
   * The top-level `category` stays valid in both shapes: it picks the channel,
   * and is a separate field from the one in `data` that the id and routing read.
   *
   * Mutations that redden this, each seen red in both cases: post
   * `id: posting.idField.id` instead of spreading `posting.idField` (the `'id' in`
   * check); post `data: decrypted.data` instead of `posting.data` (the missing
   * postedAt); note `routing: null` instead of `posting.routing` (the
   * category-less routing).
   */
  it.each([
    ['carries no category key', { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' }],
    ['carries a category this build does not know', { category: 'not-a-category', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' }],
  ])('posts a decrypted alert whose data %s with no id key, a stamped time, and a category-less note', async (_label, data) => {
    decryptPushBlobMock.mockResolvedValueOnce({
      title: 'Agent needs your input',
      body: 'Ship the release',
      category: 'input-required',
      data,
    });
    taskManagerState.displayNotification.mockResolvedValueOnce('rich-platform-id');
    const { registerBackgroundPushTask } = await loadModule();
    const { subscribeToDisplayedNotifications } = await import('@/notifications/notificationSignals');
    const notes: unknown[] = [];
    const unsubscribe = subscribeToDisplayedNotifications((note) => notes.push(note));
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });
    unsubscribe();

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
    const notification = taskManagerState.displayNotification.mock.calls[0][0] as { data?: Record<string, string> };
    expect('id' in notification).toBe(false);
    expect(notification.data).toStrictEqual({ ...data, postedAt: expect.stringMatching(/^\d+$/) });
    expect(notes).toEqual([
      {
        platformId: 'rich-platform-id',
        routing: { category: null, taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null },
        postedAt: Number(notification.data?.postedAt),
        promptIdAtPost: null,
      },
    ]);
  });

  /**
   * The stable-id case itself is pinned above for a task alert. This is the
   * Command Terminal's shape (no task id, a session kind), where the routing the
   * reconciler is handed has to carry the kind and the id has to key on the
   * session, since a terminal has nothing else to be keyed by.
   *
   * Mutation that reddens this: note `routing: null` instead of `posting.routing`
   * in the decrypted branch. Seen red that way (the same one that reddens the
   * task alert's test above, so this adds the sessionKind dimension and not a
   * second mechanism).
   */
  it('keys a decrypted Command Terminal alert on its session and notes the session kind', async () => {
    decryptPushBlobMock.mockResolvedValueOnce({
      title: 'Agent needs your input',
      body: 'Fix The Flaky Test',
      category: 'input-required',
      data: { category: 'input-required', taskId: '', projectId: 'project-1', sessionId: 'terminal-sess-1', sessionKind: 'command-terminal' },
    });
    const { registerBackgroundPushTask } = await loadModule();
    const { subscribeToDisplayedNotifications } = await import('@/notifications/notificationSignals');
    const notes: unknown[] = [];
    const unsubscribe = subscribeToDisplayedNotifications((note) => notes.push(note));
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });
    unsubscribe();

    const notification = taskManagerState.displayNotification.mock.calls[0][0] as { id?: string; data?: Record<string, string> };
    expect(notification.id).toBe('kangentic:input-required:session:terminal-sess-1');
    expect(notification.data?.postedAt).toMatch(/^\d+$/);
    expect(notes).toEqual([
      {
        platformId: 'notification-id',
        routing: { category: 'input-required', taskId: '', projectId: 'project-1', sessionId: 'terminal-sess-1', sessionKind: 'command-terminal' },
        postedAt: Number(notification.data?.postedAt),
        promptIdAtPost: null,
      },
    ]);
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

  /**
   * Sealed clears (protocol 0.23.0), with REAL sealed blobs. The one message
   * this task must never display: before this branch existed, a `data.clear`
   * message had no `blob`, so it fell through to the placeholder and a clear
   * became a new "Agent needs attention" notification.
   */
  describe('sealed clears', () => {
    interface PushKeys {
      pushKey: Uint8Array;
      identityPublicKey: Uint8Array;
    }

    /**
     * ONE real push key and device identity for the whole block, stored again
     * before each test. Not one per test: the mocked pushDecrypt is built with
     * vi.importActual, and the key caches in the modules it pulls in
     * (pushKeys.ts' cachedPushKey, deviceIdentity.ts' cachedIdentity) survived
     * vi.resetModules, so a second test's fresh keys were never read and its
     * real decrypt failed. The identity rides the persisted-secret fallback
     * rather than the in-memory active key for the same reason.
     */
    const blockIdentity = generateX25519KeyPair();
    const blockKeys: PushKeys = { pushKey: randomBytes(32), identityPublicKey: blockIdentity.publicKey };

    function armPushKeys(): PushKeys {
      secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(blockKeys.pushKey));
      secureStoreState.storedValues.set('device.identity.sk', bytesToHex(blockIdentity.secretKey));
      return blockKeys;
    }

    function clearEntry(overrides: Partial<PushClearEntry> = {}): PushClearEntry {
      return { category: 'input-required', projectId: 'project-1', taskId: 'task-1', sessionId: 'sess-1', notifiedAt: Date.now() - 30_000, ...overrides };
    }

    function envelope(overrides: Partial<PushEnvelopePlaintext> = {}): PushEnvelopePlaintext {
      return {
        category: 'input-required',
        projectId: 'project-1',
        taskId: 'task-1',
        sessionId: 'sess-1',
        taskTitle: 'Ship the release',
        detail: 'Approve the migration?',
        sentAt: Date.now() - 60_000,
        ...overrides,
      };
    }

    /** An alert notifee reports on screen, as either display path posted it; `alertSentAt` null is a local alert. */
    function displayedAlert(sessionId: string, alertSentAt: number | null): { id: string; notification: { id: string; data: Record<string, string> } } {
      const id = `kangentic:input-required:session:${sessionId}`;
      return {
        id,
        notification: {
          id,
          data: {
            category: 'input-required',
            taskId: 'task-1',
            projectId: 'project-1',
            sessionId,
            postedAt: String(Date.now()),
            ...(alertSentAt === null ? {} : { sentAt: String(alertSentAt) }),
          },
        },
      };
    }

    async function runTask(payload: unknown): Promise<void> {
      const { registerBackgroundPushTask } = await loadModule();
      registerBackgroundPushTask();
      const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
      await executor({ data: { notification: null, data: payload }, error: null, executionInfo: { taskName: 'kangentic-background-push' } });
    }

    /**
     * Mutation that reddens this: delete the `pushPayloadCarriesClear` branch
     * from the task. Seen red: nothing was cancelled.
     */
    it('removes the alert a standalone clear covers and displays nothing', async () => {
      const keys = armPushKeys();
      const alertSentAt = Date.now() - 60_000;
      taskManagerState.getDisplayedNotifications.mockResolvedValue([displayedAlert('sess-1', alertSentAt), displayedAlert('sess-2', alertSentAt)]);

      await runTask({ clear: sealPushClear(keys.pushKey, keys.identityPublicKey, { clears: [clearEntry({ notifiedAt: alertSentAt })], sentAt: Date.now() }) });

      expect(taskManagerState.cancelNotification.mock.calls).toEqual([['kangentic:input-required:session:sess-1']]);
      expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
      expect(taskManagerState.createChannels).not.toHaveBeenCalled();
    });

    it('applies a clear in the dataString shape expo-notifications wraps a message in', async () => {
      const keys = armPushKeys();
      const alertSentAt = Date.now() - 60_000;
      taskManagerState.getDisplayedNotifications.mockResolvedValue([displayedAlert('sess-1', alertSentAt)]);
      const blob = sealPushClear(keys.pushKey, keys.identityPublicKey, { clears: [clearEntry({ notifiedAt: alertSentAt })], sentAt: Date.now() });

      await runTask({ dataString: JSON.stringify({ clear: blob }) });

      expect(taskManagerState.cancelNotification.mock.calls).toEqual([['kangentic:input-required:session:sess-1']]);
      expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
    });

    /**
     * Every failure on the clear path is SILENT, never the placeholder: a clear
     * is not a reason to notify. Includes a value that is not even a string,
     * which is still a clear because the key, not the value, marks one.
     *
     * Mutation that reddens these: test `extractClearFromTaskData(...) !== null`
     * instead of `pushPayloadCarriesClear(...)` at the branch. Seen red on the
     * non-string row (the placeholder was displayed).
     */
    it.each([
      ['a value that is not a sealed clear', (_keys: PushKeys): unknown => ({ clear: 'not-a-sealed-clear' })],
      ['a value that is not a string', (_keys: PushKeys): unknown => ({ clear: 12345 })],
      ['an unopenable clear nested in dataString', (_keys: PushKeys): unknown => ({ dataString: JSON.stringify({ clear: 'garbage' }) })],
      [
        'a clear sealed with another push key',
        (keys: PushKeys): unknown => ({ clear: sealPushClear(randomBytes(32), keys.identityPublicKey, { clears: [clearEntry()], sentAt: Date.now() }) }),
      ],
      [
        'a stale clear',
        (keys: PushKeys): unknown => ({
          clear: sealPushClear(keys.pushKey, keys.identityPublicKey, { clears: [clearEntry()], sentAt: Date.now() - 25 * 60 * 60 * 1000 }),
        }),
      ],
    ])('displays and cancels nothing for %s', async (_label, buildPayload) => {
      const keys = armPushKeys();
      taskManagerState.getDisplayedNotifications.mockResolvedValue([displayedAlert('sess-1', Date.now() - 60_000)]);

      await runTask(buildPayload(keys));

      expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
      expect(taskManagerState.cancelNotification).not.toHaveBeenCalled();
    });

    it('displays nothing for a clear sealed for another device entirely', async () => {
      const otherKeys = { pushKey: randomBytes(32), identityPublicKey: generateX25519KeyPair().publicKey };
      await runTask({ clear: sealPushClear(otherKeys.pushKey, otherKeys.identityPublicKey, { clears: [clearEntry()], sentAt: Date.now() }) });

      expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
      expect(taskManagerState.cancelNotification).not.toHaveBeenCalled();
    });

    it('applies a clear even while the app is in front and connected', async () => {
      appStateMock.currentState = 'active';
      await setChannelState({ established: true, transportState: 'connected' });
      const keys = armPushKeys();
      const alertSentAt = Date.now() - 60_000;
      taskManagerState.getDisplayedNotifications.mockResolvedValue([displayedAlert('sess-1', alertSentAt)]);

      await runTask({ clear: sealPushClear(keys.pushKey, keys.identityPublicKey, { clears: [clearEntry({ notifiedAt: alertSentAt })], sentAt: Date.now() }) });

      expect(taskManagerState.cancelNotification).toHaveBeenCalledTimes(1);
    });

    it('keeps an alert sent after the clear was, and a local alert that carries no sentAt', async () => {
      const keys = armPushKeys();
      const notifiedAt = Date.now() - 60_000;
      taskManagerState.getDisplayedNotifications.mockResolvedValue([displayedAlert('sess-1', notifiedAt + 1), displayedAlert('sess-2', null)]);

      await runTask({
        clear: sealPushClear(keys.pushKey, keys.identityPublicKey, {
          clears: [clearEntry({ notifiedAt }), clearEntry({ sessionId: 'sess-2', notifiedAt: Date.now() })],
          sentAt: Date.now(),
        }),
      });

      expect(taskManagerState.cancelNotification).not.toHaveBeenCalled();
    });

    /**
     * Mutations that redden this, each seen red: apply the envelope's clears
     * AFTER displayNotification (the call-order assertion); drop them entirely
     * (no cancel); drop `sentAt` from decryptPushBlob's `data` (the stored
     * sentAt).
     */
    it('cancels what a piggybacked clear covers BEFORE displaying its envelope, which stores its own sentAt', async () => {
      const keys = armPushKeys();
      const olderSentAt = Date.now() - 120_000;
      taskManagerState.getDisplayedNotifications.mockResolvedValue([displayedAlert('sess-old', olderSentAt)]);
      const incoming = envelope({ sessionId: 'sess-new', sentAt: Date.now() - 1_000, clears: [clearEntry({ sessionId: 'sess-old', notifiedAt: olderSentAt })] });

      await runTask({ blob: sealPushEnvelope(keys.pushKey, keys.identityPublicKey, incoming) });

      expect(taskManagerState.cancelNotification.mock.calls).toEqual([['kangentic:input-required:session:sess-old']]);
      expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
      expect(taskManagerState.cancelNotification.mock.invocationCallOrder[0]).toBeLessThan(
        taskManagerState.displayNotification.mock.invocationCallOrder[0],
      );
      const notification = taskManagerState.displayNotification.mock.calls[0][0] as { id?: string; data?: Record<string, string> };
      expect(notification.id).toBe('kangentic:input-required:session:sess-new');
      expect(notification.data?.sentAt).toBe(String(incoming.sentAt));
    });

    /**
     * An Android piggyback is consumed once Expo accepts the push, so a phone
     * that drops it while the user is looking loses the only copy.
     */
    it('applies piggybacked clears while the user is watching, and still suppresses the display', async () => {
      appStateMock.currentState = 'active';
      await setChannelState({ established: true, transportState: 'connected' });
      const keys = armPushKeys();
      const olderSentAt = Date.now() - 120_000;
      taskManagerState.getDisplayedNotifications.mockResolvedValue([displayedAlert('sess-old', olderSentAt)]);
      const incoming = envelope({ sessionId: 'sess-new', clears: [clearEntry({ sessionId: 'sess-old', notifiedAt: olderSentAt })] });

      await runTask({ blob: sealPushEnvelope(keys.pushKey, keys.identityPublicKey, incoming) });

      expect(taskManagerState.cancelNotification).toHaveBeenCalledTimes(1);
      expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
    });

    describe('on iOS', () => {
      beforeEach(() => {
        platformMock.OS = 'ios';
      });

      /**
       * expo-notifications runs this task for a visible push received in the
       * foreground too. iOS already draws that alert, so a notifee post here
       * would be a duplicate on top of it.
       *
       * Mutation that reddens this: delete the `Platform.OS !== 'android'`
       * return. Seen red (the rich notification was posted through notifee).
       */
      it('posts nothing through notifee for a visible push', async () => {
        const keys = armPushKeys();
        const blob = sealPushEnvelope(keys.pushKey, keys.identityPublicKey, envelope());

        await runTask({ dataString: JSON.stringify({ blob }), body: { blob } });

        expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
        expect(taskManagerState.createChannels).not.toHaveBeenCalled();
        expect(decryptPushBlobMock).not.toHaveBeenCalled();
      });

      it('dismisses the presented alert a standalone clear covers, through expo-notifications', async () => {
        const keys = armPushKeys();
        const coveredSentAt = Date.now() - 120_000;
        const presented = (identifier: string, sessionId: string, alertSentAt: number) => ({
          date: alertSentAt / 1000,
          request: {
            identifier,
            content: { data: { blob: sealPushEnvelope(keys.pushKey, keys.identityPublicKey, envelope({ sessionId, sentAt: alertSentAt })) } },
          },
        });
        taskManagerState.getPresentedNotificationsAsync.mockResolvedValue([
          presented('ios-covered', 'sess-1', coveredSentAt),
          presented('ios-other-session', 'sess-2', coveredSentAt),
        ]);
        const blob = sealPushClear(keys.pushKey, keys.identityPublicKey, { clears: [clearEntry({ notifiedAt: coveredSentAt })], sentAt: Date.now() });

        // The shape the iOS task receives: Expo's `body` dictionary still nested, plus its dataString copy.
        await runTask({ dataString: JSON.stringify({ clear: blob }), body: { clear: blob } });

        expect(taskManagerState.dismissNotificationAsync.mock.calls).toEqual([['ios-covered']]);
        expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
        expect(taskManagerState.cancelNotification).not.toHaveBeenCalled();
      });

      /**
       * The Settings push line reads this status to say whether a push can be
       * SEEN, which on iOS this task never decides.
       *
       * Mutation that reddens this: record the status on every platform. Seen
       * red ('registered' where 'pending' was expected).
       */
      it('leaves the Settings task status pending whether registration resolves or rejects', async () => {
        const { registerBackgroundPushTask, getBackgroundPushTaskStatus } = await loadModule();
        registerBackgroundPushTask();
        await flushMicrotasks();
        expect(getBackgroundPushTaskStatus()).toBe('pending');

        vi.resetModules();
        taskManagerState.registerTaskAsync.mockRejectedValueOnce(new Error('no remote-notification background mode'));
        const reloaded = await loadModule();
        reloaded.registerBackgroundPushTask();
        await flushMicrotasks();
        expect(reloaded.getBackgroundPushTaskStatus()).toBe('pending');
      });
    });
  });
});
