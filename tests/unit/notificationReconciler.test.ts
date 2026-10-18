/**
 * The stale-notification reconciler's platform glue: what it reads, what it
 * cancels, when, and what it must never touch. The rules themselves are pinned
 * in notificationStaleness.test.ts; this file drives the REAL stores and the
 * real staleness decision through mocked notifee / expo-notifications, so a
 * wiring mistake (judging before the prune, a wrong platform API, a read on
 * every token) shows up here.
 *
 * Every test loads a fresh module registry, so the reconciler's process-wide
 * state (the tracked list, the started flag) and the stores start empty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent } from '@kangentic/protocol';
import { boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { flushMicrotasks } from '../helpers/async';

const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
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
  Platform: platformMock,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

interface DisplayedStub {
  id?: string;
  date?: string;
  notification: { id?: string; data?: Record<string, string>; android?: { channelId?: string; asForegroundService?: boolean } };
}

const notifeeMock = vi.hoisted(() => ({
  getDisplayedNotifications: vi.fn(async (): Promise<DisplayedStub[]> => []),
  cancelNotification: vi.fn(async (_notificationId: string) => undefined),
}));
vi.mock('@notifee/react-native', () => ({ default: notifeeMock }));

interface PresentedStub {
  date: number;
  request: { identifier: string; content: { data: unknown } };
}

const expoNotificationsMock = vi.hoisted(() => ({
  getPresentedNotificationsAsync: vi.fn(async (): Promise<PresentedStub[]> => []),
  dismissNotificationAsync: vi.fn(async (_identifier: string) => undefined),
}));
vi.mock('expo-notifications', () => expoNotificationsMock);

const decryptPushBlobMock = vi.hoisted(() => vi.fn<(blob: string) => Promise<unknown>>());
vi.mock('@/notifications/pushDecrypt', async () => {
  const actual = await vi.importActual<typeof import('@/notifications/pushDecrypt')>('@/notifications/pushDecrypt');
  return { ...actual, decryptPushBlob: decryptPushBlobMock };
});

async function loadModules() {
  const reconciler = await import('@/notifications/notificationReconciler');
  const signals = await import('@/notifications/notificationSignals');
  const { useActivityStore } = await import('@/state/activityStore');
  const { useBoardStore } = await import('@/state/boardStore');
  return { reconciler, signals, useActivityStore, useBoardStore };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

/** Lets the coalesced pass (a microtask) and its awaited native calls settle. */
async function settle(): Promise<void> {
  await flushMicrotasks();
  await flushMicrotasks();
}

function taskData(category: string, sessionId: string, taskId: string, postedAt: number): Record<string, string> {
  return { category, taskId, projectId: 'project-1', sessionId, postedAt: String(postedAt) };
}

/** A fresh 'sessions' board naming two task sessions, applied NOW (after any alert posted earlier). */
function seedBoard(modules: Modules): void {
  modules.useBoardStore.getState().applyBoardSnapshot(
    boardSnapshotFixture({
      projectId: 'project-1',
      view: 'sessions',
      tasks: [
        boardTaskFixture({ id: 'task-1', session_id: 'sess-1', swimlane_id: 'lane-doing' }),
        boardTaskFixture({ id: 'task-2', session_id: 'sess-2', swimlane_id: 'lane-doing' }),
      ],
    }),
  );
}

function seedSession(modules: Modules, sessionId: string, taskId: string, state: 'thinking' | 'idle' | 'permission', promptId: string | null): void {
  modules.useActivityStore.getState().registerSession(sessionId, taskId, 'project-1');
  modules.useActivityStore
    .getState()
    .applySnapshot(sessionId, taskId, 'project-1', streamSnapshotFixture({ activity: { state, reason: null }, awaitedPromptId: promptId }));
}

function activityEvent(sessionId: string, taskId: string, state: 'thinking' | 'idle'): ActivityEvent {
  return {
    kind: 'activity',
    sessionId,
    taskId,
    payload: { type: 'activity', state, reason: state === 'thinking' ? { kind: 'turn-active' } : { kind: 'idle' } },
  };
}

describe('notificationReconciler', () => {
  let stopReconciler: (() => void) | null = null;

  beforeEach(() => {
    stopReconciler?.();
    stopReconciler = null;
    vi.resetModules();
    platformMock.OS = 'android';
    appStateMock.currentState = 'active';
    appStateMock.listeners.clear();
    notifeeMock.getDisplayedNotifications.mockReset();
    notifeeMock.getDisplayedNotifications.mockResolvedValue([]);
    notifeeMock.cancelNotification.mockReset();
    notifeeMock.cancelNotification.mockResolvedValue(undefined);
    expoNotificationsMock.getPresentedNotificationsAsync.mockReset();
    expoNotificationsMock.getPresentedNotificationsAsync.mockResolvedValue([]);
    expoNotificationsMock.dismissNotificationAsync.mockReset();
    expoNotificationsMock.dismissNotificationAsync.mockResolvedValue(undefined);
    decryptPushBlobMock.mockReset();
    decryptPushBlobMock.mockResolvedValue(null);
  });

  /**
   * THE WIPE-AT-LAUNCH GUARD. A cold start reads every displayed alert against
   * empty stores, and then against stores whose data predates the alerts. Both
   * must cancel nothing at all.
   */
  it('cancels nothing on a cold start, nor against stores older than the alerts', async () => {
    const postedAt = Date.now() - 1_000;
    notifeeMock.getDisplayedNotifications.mockResolvedValue([
      { id: 'kangentic:input-required:session:sess-1', notification: { data: taskData('input-required', 'sess-1', 'task-1', postedAt) } },
      { id: 'kangentic:turn-complete:session:sess-2', notification: { data: taskData('turn-complete', 'sess-2', 'task-2', postedAt) } },
      { id: 'placeholder-1', notification: { data: { postedAt: String(postedAt) } } },
      { id: 'legacy-1', notification: { data: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' } } },
    ]);
    const modules = await loadModules();
    // Stores from BEFORE the alerts (they survive a disconnect): a full board
    // that no longer holds either task, and sessions that look resolved.
    modules.useBoardStore.setState({
      projects: [{ id: 'project-1', name: 'Project', path: '/repo' } as never],
      boardsByProjectId: {
        'project-1': {
          columns: [],
          tasksById: {},
          snapshotAt: postedAt - 60_000,
          showTicketNumbers: true,
          view: 'full',
          taskCountsByColumnId: {},
          commandTerminals: [],
          commandTerminalsOffered: false,
        },
      },
    });
    stopReconciler = modules.reconciler.startNotificationReconciler();

    appStateMock.emit('active');
    await settle();

    expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(1);
    expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();
  });

  it('cancels only the stale alert on Android, and never the keepalive connection notification', async () => {
    const postedAt = Date.now() - 1_000;
    notifeeMock.getDisplayedNotifications.mockResolvedValue([
      {
        id: 'kangentic-connection',
        notification: { id: 'kangentic-connection', android: { channelId: 'connection', asForegroundService: true } },
      },
      { id: 'kangentic:input-required:session:sess-1', notification: { data: taskData('input-required', 'sess-1', 'task-1', postedAt) } },
      { id: 'kangentic:input-required:session:sess-2', notification: { data: taskData('input-required', 'sess-2', 'task-2', postedAt) } },
    ]);
    const modules = await loadModules();
    stopReconciler = modules.reconciler.startNotificationReconciler();
    seedBoard(modules);
    // sess-1 was answered (working again); sess-2 still awaits its prompt.
    seedSession(modules, 'sess-1', 'task-1', 'thinking', null);
    seedSession(modules, 'sess-2', 'task-2', 'permission', 'prompt-2');
    await settle();

    expect(notifeeMock.cancelNotification.mock.calls).toEqual([['kangentic:input-required:session:sess-1']]);
  });

  /**
   * The keepalive's live cancel: an answer at the desk arrives as a stream event
   * while the app is backgrounded, against a board older than the alert. The
   * activity trigger re-judges what is already tracked, with no native read.
   */
  it('cancels a just-posted alert on the stream event that resolves it, without a native read', async () => {
    const modules = await loadModules();
    seedBoard(modules);
    seedSession(modules, 'sess-1', 'task-1', 'permission', 'prompt-1');
    stopReconciler = modules.reconciler.startNotificationReconciler();
    appStateMock.emit('background');
    await settle();
    notifeeMock.getDisplayedNotifications.mockClear();
    const dismissed: unknown[] = [];
    modules.signals.subscribeToNotificationDismissals((routing) => dismissed.push(routing));

    modules.signals.noteNotificationDisplayed({
      platformId: 'kangentic:input-required:session:sess-1',
      routing: { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null },
      postedAt: Date.now() - 1,
      promptIdAtPost: 'prompt-1',
    });
    await settle();
    expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

    modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
    await settle();

    expect(notifeeMock.cancelNotification.mock.calls).toEqual([['kangentic:input-required:session:sess-1']]);
    expect(notifeeMock.getDisplayedNotifications).not.toHaveBeenCalled();
    expect(dismissed).toEqual([
      { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null },
    ]);
  });

  /**
   * The headline case end to end: a task closed at the desk. The next sessions
   * board drops it and storeFeed's prune removes its entry in the same tick.
   */
  it('dismisses a turn-complete once the board drops the task and the prune removes its entry', async () => {
    const modules = await loadModules();
    seedBoard(modules);
    seedSession(modules, 'sess-1', 'task-1', 'idle', null);
    stopReconciler = modules.reconciler.startNotificationReconciler();
    const postedAt = Date.now() - 1;
    // What the tray holds, for the native read the first board after start makes.
    notifeeMock.getDisplayedNotifications.mockResolvedValue([
      { id: 'kangentic:turn-complete:session:sess-1', notification: { data: taskData('turn-complete', 'sess-1', 'task-1', postedAt) } },
    ]);
    modules.signals.noteNotificationDisplayed({
      platformId: 'kangentic:turn-complete:session:sess-1',
      routing: { category: 'turn-complete', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null },
      postedAt,
      promptIdAtPost: null,
    });
    await settle();
    notifeeMock.cancelNotification.mockClear();

    // The task is closed at the desk: the next sessions board drops it, and the
    // prune that follows in the same tick removes its entry.
    modules.useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', view: 'sessions', tasks: [] }));
    modules.useActivityStore.getState().removeSession('sess-1');
    await settle();

    expect(notifeeMock.cancelNotification.mock.calls).toEqual([['kangentic:turn-complete:session:sess-1']]);
  });

  /**
   * Requests are coalesced a microtask later, so a burst inside one tick (a
   * bootstrap's board snapshots, a foreground with a screen opening) costs one
   * native read, not one per write.
   *
   * Mutation that reddens this: run the pass synchronously in requestPass
   * instead of from queueMicrotask. Seen red that way.
   */
  it('coalesces the requests of one tick into one native read', async () => {
    const modules = await loadModules();
    stopReconciler = modules.reconciler.startNotificationReconciler();

    appStateMock.emit('active');
    const releaseTask = modules.signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });
    const releaseBoard = modules.signals.openNotificationSurface({ kind: 'project-board', projectId: 'project-1' });
    await settle();
    releaseTask();
    releaseBoard();

    expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(1);
  });

  it('reads the native list on the first board after start, and not on later boards with nothing tracked', async () => {
    const modules = await loadModules();
    stopReconciler = modules.reconciler.startNotificationReconciler();

    seedBoard(modules);
    await settle();
    expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(1);

    seedBoard(modules);
    await settle();
    expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(1);
  });

  describe('clear on open', () => {
    async function seedOneAlert(): Promise<Modules> {
      notifeeMock.getDisplayedNotifications.mockResolvedValue([
        { id: 'kangentic:turn-complete:session:sess-1', notification: { data: taskData('turn-complete', 'sess-1', 'task-1', Date.now() - 1_000) } },
      ]);
      const modules = await loadModules();
      stopReconciler = modules.reconciler.startNotificationReconciler();
      return modules;
    }

    it('dismisses a task alert when that task screen opens while the app is in front', async () => {
      const modules = await seedOneAlert();

      const release = modules.signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });
      await settle();
      release();

      expect(notifeeMock.cancelNotification.mock.calls).toEqual([['kangentic:turn-complete:session:sess-1']]);
    });

    /**
     * A session screen stays mounted when the app goes to the background, and
     * the keepalive's alert for that very task must not be eaten on posting.
     */
    it('leaves it alone while the app is in the background, then clears it on the return', async () => {
      const modules = await seedOneAlert();
      appStateMock.emit('background');

      const release = modules.signals.openNotificationSurface({ kind: 'task', taskId: 'task-1' });
      await settle();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      appStateMock.emit('active');
      await settle();
      release();
      expect(notifeeMock.cancelNotification.mock.calls).toEqual([['kangentic:turn-complete:session:sess-1']]);
    });
  });

  /**
   * A fixed id now means a repost REPLACES. The replacement is a new alert and
   * must not inherit the old one's first sight: here the old record had seen
   * prompt-0, the session now awaits prompt-1, and inheriting would dismiss the
   * very alert just posted for prompt-1. The control arm (same posting) keeps
   * what it knew and dismisses.
   */
  it.each([
    ['a repost under the same id (new posting time) starts fresh', 'repost', 0],
    ['the same posting read again keeps what was learned', 'same', 1],
  ])('%s', async (_name, arm, expectedCancels) => {
    const firstPostedAt = Date.now() - 2_000;
    const secondPostedAt = Date.now() - 1_000;
    const modules = await loadModules();
    stopReconciler = modules.reconciler.startNotificationReconciler();
    seedBoard(modules);
    await settle();
    modules.signals.noteNotificationDisplayed({
      platformId: 'kangentic:input-required:session:sess-1',
      routing: { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null },
      postedAt: firstPostedAt,
      promptIdAtPost: 'prompt-0',
    });
    await settle();
    seedSession(modules, 'sess-1', 'task-1', 'permission', 'prompt-1');
    notifeeMock.getDisplayedNotifications.mockResolvedValue([
      {
        id: 'kangentic:input-required:session:sess-1',
        notification: { data: taskData('input-required', 'sess-1', 'task-1', arm === 'repost' ? secondPostedAt : firstPostedAt) },
      },
    ]);
    notifeeMock.cancelNotification.mockClear();

    appStateMock.emit('active');
    await settle();

    expect(notifeeMock.cancelNotification).toHaveBeenCalledTimes(expectedCancels);
  });

  it('swallows a failed native read and a failed cancel', async () => {
    notifeeMock.getDisplayedNotifications.mockRejectedValue(new Error('bridge down'));
    notifeeMock.cancelNotification.mockRejectedValue(new Error('bridge down'));
    const modules = await loadModules();
    stopReconciler = modules.reconciler.startNotificationReconciler();
    seedBoard(modules);
    seedSession(modules, 'sess-1', 'task-1', 'thinking', null);
    await settle();

    modules.signals.noteNotificationDisplayed({
      platformId: 'kangentic:turn-complete:session:sess-1',
      routing: { category: 'turn-complete', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null },
      postedAt: Date.now() - 1,
      promptIdAtPost: null,
    });
    modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
    await settle();

    expect(notifeeMock.cancelNotification).toHaveBeenCalledTimes(1);
  });

  describe('iOS', () => {
    beforeEach(() => {
      platformMock.OS = 'ios';
    });

    /**
     * iOS carries only the sealed blob; the app decrypts each presented alert
     * in memory to judge it, and dismisses by request identifier. An alert with
     * no blob is not ours and is never touched. The date arrives in SECONDS.
     */
    it('decrypts presented alerts to judge them and dismisses the stale one by identifier', async () => {
      const postedAtSeconds = (Date.now() - 1_000) / 1000;
      expoNotificationsMock.getPresentedNotificationsAsync.mockResolvedValue([
        { date: postedAtSeconds, request: { identifier: 'ios-stale', content: { data: { blob: 'blob-1' } } } },
        { date: postedAtSeconds, request: { identifier: 'ios-live', content: { data: { blob: 'blob-2' } } } },
        { date: postedAtSeconds, request: { identifier: 'not-ours', content: { data: { other: 'field' } } } },
      ]);
      decryptPushBlobMock.mockImplementation(async (blob) => ({
        title: 'Agent needs your input',
        body: 'Task',
        category: 'input-required',
        data:
          blob === 'blob-1'
            ? { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' }
            : { category: 'input-required', taskId: 'task-2', projectId: 'project-1', sessionId: 'sess-2' },
      }));
      const modules = await loadModules();
      stopReconciler = modules.reconciler.startNotificationReconciler();
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'thinking', null);
      seedSession(modules, 'sess-2', 'task-2', 'permission', 'prompt-2');
      await settle();

      expect(expoNotificationsMock.dismissNotificationAsync.mock.calls).toEqual([['ios-stale']]);
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();
    });

    it('dismisses an alert it cannot open once it is older than the envelope window', async () => {
      const dayAndAnHourAgoSeconds = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
      expoNotificationsMock.getPresentedNotificationsAsync.mockResolvedValue([
        { date: dayAndAnHourAgoSeconds, request: { identifier: 'ios-expired', content: { data: { blob: 'stale-blob' } } } },
        { date: Date.now() / 1000, request: { identifier: 'ios-unreadable-now', content: { data: { blob: 'other-blob' } } } },
      ]);
      const modules = await loadModules();
      stopReconciler = modules.reconciler.startNotificationReconciler();

      appStateMock.emit('active');
      await settle();

      expect(expoNotificationsMock.dismissNotificationAsync.mock.calls).toEqual([['ios-expired']]);
    });
  });
});
