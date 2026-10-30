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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent } from '@kangentic/protocol';
import { boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import type { DisplayedNotificationNote } from '@/notifications/notificationSignals';
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

/** A `session-ended` event for a session, which is recorded even when the phone holds no entry for it. */
function sessionEndedEvent(sessionId: string, taskId: string): ActivityEvent {
  return { kind: 'activity', sessionId, taskId, payload: { type: 'session-ended', intentional: true } };
}

/** One project the phone knows about. The Android placeholder is judged against "every project", so it needs at least one. */
function setProjects(modules: Modules): void {
  modules.useBoardStore.setState({ projects: [{ id: 'project-1', name: 'Project', path: '/repo' } as never] });
}

/** The id notificationIdForRouting gives a session's alert of this category, which is what both display paths post under. */
function sessionAlertId(category: 'input-required' | 'turn-complete', sessionId: string): string {
  return `kangentic:${category}:session:${sessionId}`;
}

/** What the local notifier tells the reconciler it just posted for a session. */
function sessionAlertNote(
  category: 'input-required' | 'turn-complete',
  sessionId: string,
  taskId: string,
  postedAt: number,
  promptIdAtPost: string | null,
): DisplayedNotificationNote {
  return {
    platformId: sessionAlertId(category, sessionId),
    routing: { category, taskId, projectId: 'project-1', sessionId, sessionKind: null, authored: false },
    postedAt,
    promptIdAtPost,
  };
}

/** What decryptPushBlob returns for a sealed "needs your input" push about a session. */
function decryptedInputRequired(sessionId: string, taskId: string): unknown {
  return {
    title: 'Agent needs your input',
    body: 'Task',
    category: 'input-required',
    data: { category: 'input-required', taskId, projectId: 'project-1', sessionId },
  };
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

/** A promise the test settles by hand, to hold a native call open while something else happens. */
function deferred<Value>(): Deferred<Value> {
  let resolve: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface ControlledClock {
  set: (epochMs: number) => void;
  restore: () => void;
}

/**
 * Freezes Date.now at a time the test moves by hand. The stores stamp their
 * writes with it and the staleness rules order every alert against those stamps
 * ("fresh" is strictly after), so a test that needs "this write came after that
 * alert, and the next one did not" cannot lean on the wall clock without a tie
 * on a fast machine. Timers are untouched, so settle() still works.
 */
function controlClock(startMs: number): ControlledClock {
  let currentMs = startMs;
  const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentMs);
  return {
    set: (epochMs) => {
      currentMs = epochMs;
    },
    restore: () => dateNowSpy.mockRestore(),
  };
}

describe('notificationReconciler', () => {
  let stopReconciler: (() => void) | null = null;
  let clock: ControlledClock | null = null;

  afterEach(() => {
    // Date is global: a spy left by a failing test would reorder every later one.
    clock?.restore();
    clock = null;
  });

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
      routing: { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false },
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
      { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false },
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
      routing: { category: 'turn-complete', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false },
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
   * prompt-0, which has since resolved with no prompt awaited, and inheriting
   * would dismiss the very alert just posted. The control arm (same posting)
   * keeps what it knew and dismisses.
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
      routing: { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false },
      postedAt: firstPostedAt,
      promptIdAtPost: 'prompt-0',
    });
    await settle();
    seedSession(modules, 'sess-1', 'task-1', 'permission', null);
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
      routing: { category: 'turn-complete', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false },
      postedAt: Date.now() - 1,
      promptIdAtPost: null,
    });
    modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
    await settle();

    expect(notifeeMock.cancelNotification).toHaveBeenCalledTimes(1);
  });

  /**
   * The keepalive's connection notification is recognised two ways, each pinned
   * on its own. The setup makes the placeholder rule WOULD-dismiss it (a project
   * whose board and both sessions landed after it), so its absence from the
   * cancels is the skip and not the placeholder rule's own caution. The control
   * placeholder shares the connection stub's old date, so the same run proves
   * the setup does dismiss one.
   *
   * Mutations that redden this: drop the `platformId === CONNECTION_NOTIFICATION_ID`
   * half of the skip in readAndroidDisplayed (only the fixed-id arm goes red), or
   * the `channelId === CONNECTION_CHANNEL_ID` half (only the channel arm goes
   * red). Seen red both ways.
   */
  it.each([
    ['its fixed id, with no channel', { id: 'kangentic-connection', notification: {} }],
    ['its channel, under another id', { id: 'renamed-keepalive', notification: { android: { channelId: 'connection' } } }],
  ])('never judges the keepalive connection notification, recognised by %s', async (_name, connectionStub) => {
    const modules = await loadModules();
    setProjects(modules);
    seedBoard(modules);
    seedSession(modules, 'sess-1', 'task-1', 'idle', null);
    seedSession(modules, 'sess-2', 'task-2', 'idle', null);
    // Older than every store write above.
    const alertedAt = String(Date.now() - 60_000);
    notifeeMock.getDisplayedNotifications.mockResolvedValue([
      { ...connectionStub, date: alertedAt },
      { id: 'placeholder-control', date: alertedAt, notification: {} },
    ]);
    stopReconciler = modules.reconciler.startNotificationReconciler();

    appStateMock.emit('active');
    await settle();

    expect(notifeeMock.cancelNotification.mock.calls).toEqual([['placeholder-control']]);
  });

  /**
   * A note can land while the native read is awaiting the bridge, and that read
   * may predate the alert (it is missing), catch the same posting, or catch the
   * posting it replaced under the same stable id. Each is its own case.
   */
  describe('an alert noted while the native read is in flight', () => {
    /**
     * Starts the reconciler and a foreground read that stays open until the
     * returned deferred resolves. Seed the stores BEFORE calling it: a store
     * change after start would be the "first board" and make a read of its own.
     */
    async function openReadAfterSeeding(modules: Modules): Promise<Deferred<DisplayedStub[]>> {
      const read = deferred<DisplayedStub[]>();
      notifeeMock.getDisplayedNotifications.mockImplementationOnce(() => read.promise);
      stopReconciler = modules.reconciler.startNotificationReconciler();
      appStateMock.emit('active');
      await settle();
      // The read really is in flight: asked for, and not yet answered.
      expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(1);
      return read;
    }

    // Mutation that reddens this: build `tracked` from `merged` alone, dropping
    // `...notedLate`, in refreshTracked. Seen red that way.
    it('stays tracked when the read does not list it, and is cancelled by the stream event that resolves it', async () => {
      const modules = await loadModules();
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'permission', 'prompt-1');
      const read = await openReadAfterSeeding(modules);

      const note = sessionAlertNote('input-required', 'sess-1', 'task-1', Date.now() - 10_000, 'prompt-1');
      modules.signals.noteNotificationDisplayed(note);
      // The read was taken before the alert existed.
      read.resolve([]);
      await settle();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
      await settle();

      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[note.platformId]]);
    });

    // Mutation that reddens this: return `read` instead of `mergeTracked(noted, read)`
    // at the end of mergeReadWithNote. Seen red that way.
    it('keeps the prompt the note recorded when the read caught the same posting', async () => {
      const modules = await loadModules();
      seedBoard(modules);
      // The prompt resolved in place: the session still reads 'permission', but awaits nothing now.
      seedSession(modules, 'sess-1', 'task-1', 'permission', null);
      const read = await openReadAfterSeeding(modules);

      const postedAt = Date.now() - 10_000;
      const note = sessionAlertNote('input-required', 'sess-1', 'task-1', postedAt, 'prompt-1');
      modules.signals.noteNotificationDisplayed(note);
      read.resolve([{ id: note.platformId, notification: { data: taskData('input-required', 'sess-1', 'task-1', postedAt) } }]);
      await settle();

      // Dismissed only because the merge kept 'prompt-1': first sight alone would have recorded null.
      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[note.platformId]]);
    });

    // Mutation that reddens this: delete the `noted.postedAt > read.postedAt` line
    // in mergeReadWithNote. Seen red that way.
    it('tracks the note, not the older posting the read caught under the same id', async () => {
      const modules = await loadModules();
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'thinking', null);
      const read = await openReadAfterSeeding(modules);

      const storesWrittenAt = Date.now();
      // The stores are newer than the posting the read returned and older than the repost.
      const olderPostedAt = storesWrittenAt - 5_000;
      const repostedAt = storesWrittenAt + 5_000;
      const note = sessionAlertNote('turn-complete', 'sess-1', 'task-1', repostedAt, null);
      modules.signals.noteNotificationDisplayed(note);
      read.resolve([{ id: note.platformId, notification: { data: taskData('turn-complete', 'sess-1', 'task-1', olderPostedAt) } }]);
      await settle();

      // Judged as the old posting it would go: the session is thinking again, after it. As the repost it stays.
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();
    });
  });

  describe('a note taken for the reconciler', () => {
    // Mutation that reddens this: drop the `note.platformId.length === 0` check in
    // onNotificationDisplayed (the stale '' record is then cancelled as ''). Seen
    // red that way.
    it('ignores one that names no platform id', async () => {
      const modules = await loadModules();
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'permission', 'prompt-1');
      stopReconciler = modules.reconciler.startNotificationReconciler();

      const postedAt = Date.now() - 10_000;
      const real = sessionAlertNote('input-required', 'sess-1', 'task-1', postedAt, 'prompt-1');
      modules.signals.noteNotificationDisplayed({ ...real, platformId: '' });
      modules.signals.noteNotificationDisplayed(real);
      await settle();
      modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
      await settle();

      // Both are stale now. Only the one with an id can be cancelled by it.
      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[real.platformId]]);
    });

    // Mutation that reddens this: return early from onNotificationDisplayed when
    // `note.routing === null`. Seen red that way.
    it('tracks a placeholder note as a placeholder, cancelled once every board and session it names is fresh', async () => {
      const baseTime = Date.now();
      clock = controlClock(baseTime);
      const modules = await loadModules();
      setProjects(modules);
      stopReconciler = modules.reconciler.startNotificationReconciler();
      // The first board after start makes the one native read, which would drop a note taken before it.
      seedBoard(modules);
      await settle();

      clock.set(baseTime + 1_000);
      modules.signals.noteNotificationDisplayed({ platformId: 'placeholder-1', routing: null, postedAt: baseTime + 1_000, promptIdAtPost: null });
      await settle();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      // A board newer than the alert, but neither session it names has been seen since.
      clock.set(baseTime + 2_000);
      seedBoard(modules);
      await settle();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      seedSession(modules, 'sess-1', 'task-1', 'idle', null);
      await settle();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      seedSession(modules, 'sess-2', 'task-2', 'idle', null);
      await settle();

      expect(notifeeMock.cancelNotification.mock.calls).toEqual([['placeholder-1']]);
    });

    /**
     * Noting an id twice REPLACES the record: it is judged by the second note's
     * posting time and prompt, and is one alert to cancel, not two. Both notes
     * land in one tick, so only the surviving record is ever judged. Each arm
     * is built so the first note alone would be dismissed and the second alone
     * kept; the stream event afterwards proves the survivor is still tracked.
     *
     * Mutations that redden both arms: keep the first record when an id is
     * already tracked, or append without filtering the old record out. Seen red
     * both ways.
     */
    it.each([
      {
        name: 'posting time',
        category: 'turn-complete' as const,
        entryState: 'thinking' as const,
        firstNote: { postedAtOffset: -5_000, promptIdAtPost: null },
        secondNote: { postedAtOffset: 5_000, promptIdAtPost: null },
      },
      {
        name: 'prompt',
        category: 'input-required' as const,
        entryState: 'permission' as const,
        firstNote: { postedAtOffset: -5_000, promptIdAtPost: 'prompt-0' },
        secondNote: { postedAtOffset: -5_000, promptIdAtPost: null },
      },
    ])('judges a repeated id by the second note, not the first: $name', async ({ category, entryState, firstNote, secondNote }) => {
      const baseTime = Date.now();
      clock = controlClock(baseTime);
      const modules = await loadModules();
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', entryState, null);
      stopReconciler = modules.reconciler.startNotificationReconciler();

      const first = sessionAlertNote(category, 'sess-1', 'task-1', baseTime + firstNote.postedAtOffset, firstNote.promptIdAtPost);
      const second = sessionAlertNote(category, 'sess-1', 'task-1', baseTime + secondNote.postedAtOffset, secondNote.promptIdAtPost);
      modules.signals.noteNotificationDisplayed(first);
      modules.signals.noteNotificationDisplayed(second);
      await settle();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      clock.set(baseTime + 10_000);
      modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
      await settle();

      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[second.platformId]]);
    });
  });

  /**
   * A request that arrives while a pass is awaiting its cancels is not lost and
   * not run in parallel: it makes exactly one more pass after the first.
   *
   * Mutation that reddens this: `while` to `if` in runPasses (the second alert is
   * never cancelled). Seen red that way.
   */
  it('runs exactly one more pass for a request that arrives while a pass is running', async () => {
    const modules = await loadModules();
    seedBoard(modules);
    seedSession(modules, 'sess-1', 'task-1', 'permission', 'prompt-1');
    seedSession(modules, 'sess-2', 'task-2', 'permission', 'prompt-2');
    stopReconciler = modules.reconciler.startNotificationReconciler();
    const postedAt = Date.now() - 10_000;
    const firstAlert = sessionAlertNote('input-required', 'sess-1', 'task-1', postedAt, 'prompt-1');
    const secondAlert = sessionAlertNote('input-required', 'sess-2', 'task-2', postedAt, 'prompt-2');
    modules.signals.noteNotificationDisplayed(firstAlert);
    modules.signals.noteNotificationDisplayed(secondAlert);
    await settle();
    expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

    const holdFirstCancel = deferred<undefined>();
    notifeeMock.cancelNotification.mockImplementationOnce(() => holdFirstCancel.promise);
    // A pass reads the board store once, in readContext, so this counts passes.
    const passes = vi.spyOn(modules.useBoardStore, 'getState');
    modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
    await settle();
    expect(notifeeMock.cancelNotification.mock.calls).toEqual([[firstAlert.platformId]]);
    expect(passes).toHaveBeenCalledTimes(1);

    // The second alert goes stale while the first pass is parked on its cancel.
    modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-2', 'task-2', 'thinking'));
    await settle();
    expect(notifeeMock.cancelNotification).toHaveBeenCalledTimes(1);

    holdFirstCancel.resolve(undefined);
    await settle();

    expect(notifeeMock.cancelNotification.mock.calls).toEqual([[firstAlert.platformId], [secondAlert.platformId]]);
    expect(passes).toHaveBeenCalledTimes(2);
  });

  /**
   * The dismissal is what releases the local notifier's cooldown, and a next
   * prompt landing inside the bridge round trip would otherwise meet the old
   * one and post nothing.
   *
   * Mutation that reddens this: move the publishNotificationDismissed loop after
   * the `await Promise.allSettled` in rejudgeTracked. Seen red that way.
   */
  it('publishes the dismissal before the native cancel settles', async () => {
    const modules = await loadModules();
    seedBoard(modules);
    seedSession(modules, 'sess-1', 'task-1', 'permission', 'prompt-1');
    stopReconciler = modules.reconciler.startNotificationReconciler();
    const dismissed: unknown[] = [];
    modules.signals.subscribeToNotificationDismissals((routing) => dismissed.push(routing));
    const holdCancel = deferred<undefined>();
    let cancelSettled = false;
    void holdCancel.promise.then(() => {
      cancelSettled = true;
    });
    notifeeMock.cancelNotification.mockImplementationOnce(() => holdCancel.promise);

    const note = sessionAlertNote('input-required', 'sess-1', 'task-1', Date.now() - 10_000, 'prompt-1');
    modules.signals.noteNotificationDisplayed(note);
    modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
    await settle();

    expect(notifeeMock.cancelNotification.mock.calls).toEqual([[note.platformId]]);
    expect(cancelSettled).toBe(false);
    expect(dismissed).toEqual([note.routing]);

    holdCancel.resolve(undefined);
    await settle();
  });

  describe('start and stop', () => {
    // Coalescing hides a second subscription from any "one cancel" assertion, so
    // this pins the mechanism: the stop identity, the AppState listener count and
    // the store subscribe calls.
    // Mutations that redden this: delete the `stopActiveReconciler !== null` early
    // return (red on the stop identity, the first assertion), or move it below the
    // subscriptions so the same stop comes back but everything is subscribed twice
    // (red on the AppState listener count, 2 instead of 1). Seen red both ways.
    it('is idempotent: a second start returns the same stop and subscribes to nothing more', async () => {
      const modules = await loadModules();
      const boardSubscribe = vi.spyOn(modules.useBoardStore, 'subscribe');
      const activitySubscribe = vi.spyOn(modules.useActivityStore, 'subscribe');

      const firstStop = modules.reconciler.startNotificationReconciler();
      stopReconciler = firstStop;
      const secondStop = modules.reconciler.startNotificationReconciler();

      expect(secondStop).toBe(firstStop);
      expect(appStateMock.listeners.size).toBe(1);
      expect(boardSubscribe).toHaveBeenCalledTimes(1);
      expect(activitySubscribe).toHaveBeenCalledTimes(1);

      // And it still does its job once: one change, one pass, one cancel.
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'permission', 'prompt-1');
      await settle();
      const note = sessionAlertNote('input-required', 'sess-1', 'task-1', Date.now() - 10_000, 'prompt-1');
      modules.signals.noteNotificationDisplayed(note);
      modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
      await settle();
      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[note.platformId]]);
    });

    // Mutations that redden this: drop one of appStateSubscription.remove(),
    // unsubscribeBoard(), unsubscribeSurfaces() or unsubscribeDisplayed() from
    // stop(). Each seen red (the AppState listener count, then the native read
    // twice, then the cancel). unsubscribeActivity() is NOT observable here: stop()
    // also empties the tracked list, so a late activity change has nothing to
    // re-judge.
    it('reacts to nothing once stopped: no native read, no cancel', async () => {
      const modules = await loadModules();
      // A state in which an input-required alert for sess-1 is stale, so a cancel would be the verdict.
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'thinking', null);
      const stop = modules.reconciler.startNotificationReconciler();
      stop();
      expect(appStateMock.listeners.size).toBe(0);

      appStateMock.emit('active');
      const releaseSurface = modules.signals.openNotificationSurface({ kind: 'task', taskId: 'task-9' });
      seedBoard(modules);
      modules.signals.noteNotificationDisplayed(sessionAlertNote('input-required', 'sess-1', 'task-1', Date.now() - 10_000, 'prompt-1'));
      await settle();
      releaseSurface();

      expect(notifeeMock.getDisplayedNotifications).not.toHaveBeenCalled();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();
    });

    it('can start again after a stop, and the new start is a different subscription', async () => {
      const modules = await loadModules();
      const firstStop = modules.reconciler.startNotificationReconciler();
      firstStop();
      const secondStop = modules.reconciler.startNotificationReconciler();
      stopReconciler = secondStop;

      expect(secondStop).not.toBe(firstStop);
      expect(appStateMock.listeners.size).toBe(1);
    });

    /**
     * A native read can be minutes old by the time the bridge answers. One that
     * began before a stop belongs to a reconciler that no longer exists and must
     * not write into the one that started since.
     *
     * Mutation that reddens this: delete the `generation !== startedIn` check in
     * refreshTracked. Seen red that way.
     */
    it('discards a native read that was in flight when the reconciler stopped and started again', async () => {
      const modules = await loadModules();
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'thinking', null);
      const oldRead = deferred<DisplayedStub[]>();
      notifeeMock.getDisplayedNotifications.mockImplementationOnce(() => oldRead.promise);
      const firstStop = modules.reconciler.startNotificationReconciler();
      appStateMock.emit('active');
      await settle();
      expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(1);

      firstStop();
      stopReconciler = modules.reconciler.startNotificationReconciler();
      // The old read lists an alert the stores say is stale: the session is thinking after it.
      oldRead.resolve([
        {
          id: sessionAlertId('input-required', 'sess-1'),
          notification: { data: taskData('input-required', 'sess-1', 'task-1', Date.now() - 10_000) },
        },
      ]);
      await settle();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      // The new reconciler is alive: it judges what it is told about itself.
      const note = sessionAlertNote('input-required', 'sess-1', 'task-1', Date.now() - 10_000, 'prompt-1');
      modules.signals.noteNotificationDisplayed(note);
      await settle();
      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[note.platformId]]);
    });
  });

  /**
   * An activity change re-judges only when it can alter a verdict. The stream
   * rewrites an entry on every event, so without the gate every streamed token
   * would walk the whole list. The mechanism is observable: a pass is the only
   * thing that reads the board store (readContext), so a spy on its getState,
   * taken after the setup, counts them.
   *
   * Mutations that redden these: make entryChangeReachesTracked true for any
   * routed alert (first test), drop its `android-placeholder` line (second test,
   * and the placeholder note test), force `endRecorded` to false (third test).
   * Each seen red that way.
   */
  describe('the activity gate', () => {
    async function startWithRoutedAlertOnSessionOne(): Promise<Modules> {
      const modules = await loadModules();
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'permission', 'prompt-1');
      seedSession(modules, 'sess-2', 'task-2', 'permission', 'prompt-2');
      stopReconciler = modules.reconciler.startNotificationReconciler();
      modules.signals.noteNotificationDisplayed(sessionAlertNote('input-required', 'sess-1', 'task-1', Date.now() - 10_000, 'prompt-1'));
      await settle();
      return modules;
    }

    it('re-judges for a change to a tracked alert\'s own session and not for another', async () => {
      const modules = await startWithRoutedAlertOnSessionOne();
      const passes = vi.spyOn(modules.useBoardStore, 'getState');

      modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-2', 'task-2', 'thinking'));
      await settle();
      expect(passes).not.toHaveBeenCalled();

      modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', 'task-1', 'thinking'));
      await settle();
      expect(passes).toHaveBeenCalled();
    });

    it('re-judges for a change to any session while a placeholder is tracked', async () => {
      const modules = await loadModules();
      seedSession(modules, 'sess-2', 'task-2', 'permission', 'prompt-2');
      stopReconciler = modules.reconciler.startNotificationReconciler();
      modules.signals.noteNotificationDisplayed({ platformId: 'placeholder-1', routing: null, postedAt: Date.now() - 10_000, promptIdAtPost: null });
      await settle();
      const passes = vi.spyOn(modules.useBoardStore, 'getState');

      modules.useActivityStore.getState().applyActivityEvent(activityEvent('sess-2', 'task-2', 'thinking'));
      await settle();

      expect(passes).toHaveBeenCalled();
    });

    it('re-judges when an end is recorded, even for a session no alert is about', async () => {
      const modules = await startWithRoutedAlertOnSessionOne();
      const passes = vi.spyOn(modules.useBoardStore, 'getState');

      // No entry for sess-9: this writes endedSessionIds and nothing in bySessionId.
      modules.useActivityStore.getState().applyActivityEvent(sessionEndedEvent('sess-9', 'task-9'));
      await settle();

      expect(passes).toHaveBeenCalled();
    });
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

    /**
     * An iOS identifier names one delivered push for its whole life, and a
     * refresh runs on every foreground and screen focus, so a decrypt already
     * done is reused rather than repeated.
     *
     * Mutation that reddens this: disable the `previous.kind === 'routed'` reuse
     * in readIosPresented. Seen red that way.
     */
    it('decrypts a routed presented alert once, however many refreshes run', async () => {
      expoNotificationsMock.getPresentedNotificationsAsync.mockResolvedValue([
        { date: (Date.now() - 1_000) / 1000, request: { identifier: 'ios-1', content: { data: { blob: 'blob-1' } } } },
      ]);
      decryptPushBlobMock.mockResolvedValue(decryptedInputRequired('sess-1', 'task-1'));
      const modules = await loadModules();
      stopReconciler = modules.reconciler.startNotificationReconciler();

      appStateMock.emit('active');
      await settle();
      appStateMock.emit('active');
      await settle();

      expect(expoNotificationsMock.getPresentedNotificationsAsync).toHaveBeenCalledTimes(2);
      expect(decryptPushBlobMock).toHaveBeenCalledTimes(1);
    });

    /**
     * An alert that could not be opened is retried, because the key may simply
     * not have been readable the last time, but not on every refresh: only once
     * UNDECRYPTABLE_RETRY_MS (60 s) has passed since the last try. Once it does
     * open, it is judged like any routed alert.
     *
     * Mutations that redden this: make the retry skip never apply (compare
     * against 0 instead of UNDECRYPTABLE_RETRY_MS), which goes red inside the
     * window; and make it always apply (compare against Infinity), which goes red
     * once the window has passed. Seen red both ways.
     */
    it('retries an alert it could not open only after the retry window, then judges it', async () => {
      const baseTime = Date.now();
      clock = controlClock(baseTime);
      expoNotificationsMock.getPresentedNotificationsAsync.mockResolvedValue([
        { date: (baseTime - 5_000) / 1000, request: { identifier: 'ios-late', content: { data: { blob: 'blob-late' } } } },
      ]);
      // The first try finds no key; every later one opens it.
      decryptPushBlobMock.mockResolvedValueOnce(null);
      decryptPushBlobMock.mockResolvedValue(decryptedInputRequired('sess-1', 'task-1'));
      const modules = await loadModules();
      // Seeded before start so only the emits below drive reads. The session is thinking
      // after the alert was posted, so once the alert can be read it is stale.
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'thinking', null);
      stopReconciler = modules.reconciler.startNotificationReconciler();

      appStateMock.emit('active');
      await settle();
      expect(decryptPushBlobMock).toHaveBeenCalledTimes(1);

      // One millisecond inside the window: not tried again.
      clock.set(baseTime + 59_999);
      appStateMock.emit('active');
      await settle();
      expect(decryptPushBlobMock).toHaveBeenCalledTimes(1);
      expect(expoNotificationsMock.dismissNotificationAsync).not.toHaveBeenCalled();

      clock.set(baseTime + 60_000);
      appStateMock.emit('active');
      await settle();

      expect(decryptPushBlobMock).toHaveBeenCalledTimes(2);
      expect(expoNotificationsMock.dismissNotificationAsync.mock.calls).toEqual([['ios-late']]);
    });

    /**
     * expo-notifications reports the date in SECONDS, but the reconciler
     * normalises by magnitude so a date that is already in milliseconds is not
     * read as the year 50000. Here the session was last touched at `storesAt`:
     * a posting before that is stale, one after it is not, and a date of 0 says
     * nothing about when, so the alert is kept.
     *
     * Mutations that redden these: always multiply by 1000 in
     * epochMsFromPresentedDate (the "before" arm); let `date: 0` through by
     * loosening `date <= 0` to `date < 0` (the "0" arm); read every millisecond
     * date as the instant 1 ms after the epoch (the "after" arm). Seen red each way.
     */
    it.each([
      ['a millisecond date from before the stores is judged against its real time', -60_000, 1],
      ['a millisecond date from after the stores keeps the alert', 60_000, 0],
      ['a date of 0 names no posting time and keeps the alert', null, 0],
    ])('%s', async (_name, offsetFromStoresMs, expectedDismissals) => {
      const modules = await loadModules();
      seedBoard(modules);
      seedSession(modules, 'sess-1', 'task-1', 'thinking', null);
      const storesAt = Date.now();
      expoNotificationsMock.getPresentedNotificationsAsync.mockResolvedValue([
        {
          date: offsetFromStoresMs === null ? 0 : storesAt + offsetFromStoresMs,
          request: { identifier: 'ios-ms', content: { data: { blob: 'blob-ms' } } },
        },
      ]);
      decryptPushBlobMock.mockResolvedValue(decryptedInputRequired('sess-1', 'task-1'));
      stopReconciler = modules.reconciler.startNotificationReconciler();

      appStateMock.emit('active');
      await settle();

      expect(expoNotificationsMock.dismissNotificationAsync).toHaveBeenCalledTimes(expectedDismissals);
    });
  });

  /**
   * Sealed clears (protocol 0.23.0): the desktop saw a notified condition
   * resolve, so the entry IS the verdict and no staleness rule is consulted.
   * What must hold is the bound: an alert is removed only when its category and
   * ids match AND its own envelope `sentAt` is at or before `notifiedAt`, and an
   * alert carrying no `sentAt` (a local alert under the same stable id) is kept.
   * A blind cancel by stable id, the obvious shortcut, breaks both.
   */
  describe('dismissNotificationsClearedBy', () => {
    const sentAt = Date.now() - 60_000;

    function clearEntry(category: 'input-required' | 'turn-complete', sessionId: string, taskId: string, notifiedAt: number) {
      return { category, projectId: 'project-1', taskId, sessionId, notifiedAt };
    }

    function pushedData(category: 'input-required' | 'turn-complete', sessionId: string, taskId: string, alertSentAt: number) {
      return { ...taskData(category, sessionId, taskId, Date.now()), sentAt: String(alertSentAt) };
    }

    /**
     * Mutations that redden this, each seen red: drop the `sentAt <=
     * notifiedAt` bound from clearEntryCovers (the newer turn-complete is
     * cancelled too, and the iOS case below goes red the same way); drop its
     * `sentAt === null` guard (the local alert under sess-2's id is cancelled,
     * since `null <= notifiedAt` is true in JavaScript).
     */
    it('on Android cancels only the alerts an entry covers, by their own sentAt', async () => {
      const modules = await loadModules();
      notifeeMock.getDisplayedNotifications.mockResolvedValue([
        { id: sessionAlertId('input-required', 'sess-1'), notification: { data: pushedData('input-required', 'sess-1', 'task-1', sentAt) } },
        { id: sessionAlertId('turn-complete', 'sess-1'), notification: { data: pushedData('turn-complete', 'sess-1', 'task-1', sentAt) } },
        // A local alert: the same stable id a push would use, but no desktop sentAt.
        { id: sessionAlertId('input-required', 'sess-2'), notification: { data: taskData('input-required', 'sess-2', 'task-2', Date.now()) } },
        { id: 'kangentic-connection', notification: { android: { channelId: 'connection' } } },
      ]);

      await modules.reconciler.dismissNotificationsClearedBy([
        clearEntry('input-required', 'sess-1', 'task-1', sentAt + 1_000),
        // Sealed before the alert on screen was: that alert is newer, and stays.
        clearEntry('turn-complete', 'sess-1', 'task-1', sentAt - 1),
        clearEntry('input-required', 'sess-2', 'task-2', Date.now()),
      ]);

      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[sessionAlertId('input-required', 'sess-1')]]);
    });

    it('covers an alert sealed exactly at notifiedAt, and nothing for another task', async () => {
      const modules = await loadModules();
      notifeeMock.getDisplayedNotifications.mockResolvedValue([
        { id: sessionAlertId('input-required', 'sess-1'), notification: { data: pushedData('input-required', 'sess-1', 'task-1', sentAt) } },
      ]);

      await modules.reconciler.dismissNotificationsClearedBy([clearEntry('input-required', 'sess-1', 'task-9', sentAt)]);
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      await modules.reconciler.dismissNotificationsClearedBy([clearEntry('input-required', 'sess-1', 'task-1', sentAt)]);
      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[sessionAlertId('input-required', 'sess-1')]]);
    });

    /**
     * The local notifier holds a cooldown per session and category that a
     * dismissal releases; a cleared alert must release it like a stale one.
     */
    it('publishes each cleared alert as dismissed', async () => {
      const modules = await loadModules();
      const dismissed: unknown[] = [];
      modules.signals.subscribeToNotificationDismissals((routing) => dismissed.push(routing));
      notifeeMock.getDisplayedNotifications.mockResolvedValue([
        { id: sessionAlertId('input-required', 'sess-1'), notification: { data: pushedData('input-required', 'sess-1', 'task-1', sentAt) } },
      ]);

      await modules.reconciler.dismissNotificationsClearedBy([clearEntry('input-required', 'sess-1', 'task-1', sentAt)]);

      expect(dismissed).toEqual([{ category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false }]);
    });

    /**
     * A cleared alert has to leave the TRACKED list as well as the tray. The
     * tray is read fresh by a refresh, but a pass that makes no native read (an
     * end recorded, an activity change reaching a tracked alert) judges the list
     * the reconciler already holds, so a record left in it is dismissed and
     * cancelled a second time once the staleness rules agree it is stale.
     *
     * The setup is shaped around that: the board exists before start (so seeding
     * it is not the first-board native read), a SECOND uncovered alert keeps the
     * list non-empty (the activity subscriber skips an empty list, which would
     * make the follow-up pass never run), and ending both sessions in one tick
     * makes one rejudge-only pass that provably ran, because it cancels the
     * second alert. Reading the tray twice in total (one refresh, one clear)
     * proves the pass made no read of its own, which would have replaced the
     * tracked list and hidden the bug.
     *
     * Mutation that reddens this, seen red: delete the
     * `tracked = tracked.filter((record) => !clearedIds.has(record.platformId))`
     * line in dismissNotificationsClearedBy. The cleared alert is then cancelled
     * and published as dismissed a second time by the rejudge-only pass, and the
     * cancel-calls assertion reads sess-1's id twice.
     */
    it('does not dismiss a cleared alert a second time when a later pass judges the tracked list', async () => {
      const modules = await loadModules();
      seedBoard(modules);
      const clearedAlertId = sessionAlertId('input-required', 'sess-1');
      const uncoveredAlertId = sessionAlertId('input-required', 'sess-2');
      notifeeMock.getDisplayedNotifications.mockResolvedValue([
        { id: clearedAlertId, notification: { data: pushedData('input-required', 'sess-1', 'task-1', sentAt) } },
        { id: uncoveredAlertId, notification: { data: pushedData('input-required', 'sess-2', 'task-2', sentAt) } },
      ]);
      stopReconciler = modules.reconciler.startNotificationReconciler();
      const dismissed: unknown[] = [];
      modules.signals.subscribeToNotificationDismissals((routing) => dismissed.push(routing));

      // Both alerts enter the tracked list through a refresh, and neither is stale yet.
      appStateMock.emit('active');
      await settle();
      expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(1);
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();

      await modules.reconciler.dismissNotificationsClearedBy([clearEntry('input-required', 'sess-1', 'task-1', sentAt)]);
      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[clearedAlertId]]);
      expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(2);

      // Both sessions end: the staleness rules now dismiss an input-required alert
      // for either one, so a record still tracked for sess-1 would be dismissed again.
      modules.useActivityStore.getState().applyActivityEvent(sessionEndedEvent('sess-1', 'task-1'));
      modules.useActivityStore.getState().applyActivityEvent(sessionEndedEvent('sess-2', 'task-2'));
      await settle();

      // The pass ran (it cancelled the uncovered alert) and made no read of its own.
      expect(notifeeMock.getDisplayedNotifications).toHaveBeenCalledTimes(2);
      expect(notifeeMock.cancelNotification.mock.calls).toEqual([[clearedAlertId], [uncoveredAlertId]]);
      expect(dismissed).toEqual([
        { category: 'input-required', taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', sessionKind: null, authored: false },
        { category: 'input-required', taskId: 'task-2', projectId: 'project-1', sessionId: 'sess-2', sessionKind: null, authored: false },
      ]);
    });

    it('on iOS decrypts what is presented and dismisses the covered alert by its request identifier', async () => {
      platformMock.OS = 'ios';
      const modules = await loadModules();
      expoNotificationsMock.getPresentedNotificationsAsync.mockResolvedValue([
        { date: sentAt / 1000, request: { identifier: 'ios-covered', content: { data: { blob: 'blob-covered' } } } },
        { date: sentAt / 1000, request: { identifier: 'ios-newer', content: { data: { blob: 'blob-newer' } } } },
      ]);
      decryptPushBlobMock.mockImplementation(async (blob: string) => ({
        ...(decryptedInputRequired(blob === 'blob-covered' ? 'sess-1' : 'sess-2', blob === 'blob-covered' ? 'task-1' : 'task-2') as object),
        sentAt: blob === 'blob-covered' ? sentAt : Date.now(),
      }));

      await modules.reconciler.dismissNotificationsClearedBy([
        clearEntry('input-required', 'sess-1', 'task-1', sentAt + 1_000),
        clearEntry('input-required', 'sess-2', 'task-2', sentAt + 1_000),
      ]);

      expect(expoNotificationsMock.dismissNotificationAsync.mock.calls).toEqual([['ios-covered']]);
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();
    });

    it('makes no native read for an empty clear, and swallows a read that fails', async () => {
      const modules = await loadModules();
      await modules.reconciler.dismissNotificationsClearedBy([]);
      expect(notifeeMock.getDisplayedNotifications).not.toHaveBeenCalled();

      notifeeMock.getDisplayedNotifications.mockRejectedValueOnce(new Error('notifee unavailable'));
      await expect(
        modules.reconciler.dismissNotificationsClearedBy([clearEntry('input-required', 'sess-1', 'task-1', sentAt)]),
      ).resolves.toBeUndefined();
      expect(notifeeMock.cancelNotification).not.toHaveBeenCalled();
    });
  });
});
