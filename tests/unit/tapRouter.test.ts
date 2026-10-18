/**
 * Notification tap routing, and specifically the iOS half.
 *
 * The iOS Notification Service Extension rewrites a push's title and body
 * before the OS renders it, but deliberately never touches `userInfo`, so the
 * tapped notification still carries only the sealed blob. The router decrypts
 * it on tap - which is what keeps taskId out of the OS-visible payload, per
 * e2e-notification-privacy.md. The failure path matters as much as the happy
 * one: a blob that will not decrypt must route NOWHERE rather than guess,
 * leaving the user on Home.
 *
 * This module publishes a resolved target to the shared pending-navigation slot
 * and NEVER navigates; PendingNavigationRunner performs the navigation from
 * inside the mounted navigator. The assertions below are written against that
 * slot, and one of them pins the negative directly (see 'never navigates from
 * module scope'), because calling expo-router's imperative router from
 * bundle-entry scope is what crashed iOS on a cold-start tap in 0.6.3 build 13.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushMicrotasks } from '../helpers/async';

const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'android' | 'ios' }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), navigate: vi.fn(), canDismiss: vi.fn(), dismissAll: vi.fn() }));
const notifeeMock = vi.hoisted(() => ({
  onForegroundEvent: vi.fn(),
  onBackgroundEvent: vi.fn(),
  getInitialNotification: vi.fn(async () => null as unknown),
}));
const expoNotificationsMock = vi.hoisted(() => ({
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(async () => null as unknown),
}));
const decryptPushBlobMock = vi.hoisted(() => vi.fn<(blob: string) => Promise<unknown>>());

// pushDecrypt reaches expo-secure-store for the push key, and importActual
// below pulls that in for real; unmocked it drags expo-modules-core into this
// node run and dies on a missing __DEV__.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.mock('react-native', () => ({ Platform: platformMock }));
// tapRouter must NOT import expo-router any more. The mock stays so the
// 'never navigates from module scope' case can prove that as a negative
// rather than merely asserting the slot was written.
vi.mock('expo-router', () => ({ router: routerMock }));
vi.mock('@notifee/react-native', () => ({
  default: notifeeMock,
  EventType: { PRESS: 1 },
}));
vi.mock('expo-notifications', () => expoNotificationsMock);
vi.mock('@/notifications/pushDecrypt', async () => {
  const actual = await vi.importActual<typeof import('@/notifications/pushDecrypt')>('@/notifications/pushDecrypt');
  return { ...actual, decryptPushBlob: decryptPushBlobMock };
});

type TapRouterModule = typeof import('@/notifications/tapRouter');
type PendingNavigationModule = typeof import('@/navigation/pendingNavigation');
type PendingNavigation = NonNullable<ReturnType<PendingNavigationModule['getPendingNavigation']>>;

/**
 * Both modules are loaded together and AFTER `vi.resetModules()`, so they share
 * one fresh module registry - tapRouter's own import of the slot resolves to
 * the same instance this returns. Loading them in separate turns would hand the
 * test a different slot than the one under test.
 */
async function loadModules(): Promise<{
  tapRouter: TapRouterModule;
  pendingNavigation: PendingNavigationModule;
}> {
  const tapRouter = await import('@/notifications/tapRouter');
  const pendingNavigation = await import('@/navigation/pendingNavigation');
  return { tapRouter, pendingNavigation };
}

/**
 * Every published navigation, in order. The slot holds only the latest value,
 * so counting publishes needs the subscription rather than a read - which is
 * also the mechanism the React consumer depends on, so a broken notify loop
 * fails here rather than only on device.
 */
function recordPublished(pendingNavigation: PendingNavigationModule): PendingNavigation[] {
  const published: PendingNavigation[] = [];
  pendingNavigation.subscribePendingNavigation(() => {
    const pending = pendingNavigation.getPendingNavigation();
    if (pending) published.push(pending);
  });
  return published;
}

/**
 * `identifier` is optional because most cases here do not care about it. The
 * de-duplication guard only engages on a non-empty string, so omitting it keeps
 * every single-tap case routing exactly as it reads.
 */
function pushResponse(data: unknown, identifier?: string): Parameters<TapRouterModule['routeFromPushResponse']>[0] {
  return { notification: { request: { identifier, content: { data } } } } as Parameters<
    TapRouterModule['routeFromPushResponse']
  >[0];
}

const DECRYPTED = {
  title: 'Agent needs your input',
  body: 'Ship the release',
  category: 'input-required',
  data: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' },
};

const DECRYPTED_TARGET = {
  kind: 'open-task',
  taskId: 'task-1',
  projectId: 'project-1',
  sessionId: 'sess-1',
};

/**
 * A Command Terminal's decrypted envelope (protocol 0.20.0). The desktop stamps
 * a made-up `taskId` on it that names no board row, so the only thing that can
 * route it correctly is `sessionKind`. The expected target carries no `taskId`
 * at all: opening the made-up id as a task is the blank "Task" screen that
 * never connects.
 */
const DECRYPTED_COMMAND_TERMINAL = {
  title: 'Agent went idle',
  body: 'Fix The Flaky Test',
  category: 'turn-complete',
  data: { taskId: 'made-up-terminal-task', projectId: 'project-1', sessionId: 'terminal-sess-1', sessionKind: 'command-terminal' },
};

/** The string-valued notifee `data` Android posts for a decrypted Command Terminal push (decryptPushBlob's routing). */
const COMMAND_TERMINAL_PRESS_DATA = DECRYPTED_COMMAND_TERMINAL.data;

const COMMAND_TERMINAL_TARGET = {
  kind: 'open-command-terminal',
  projectId: 'project-1',
  sessionId: 'terminal-sess-1',
};

/**
 * A workflow-complete envelope (protocol 0.21.0): every task of a workflow
 * reached Done. `taskTitle` is the workflow's name, `projectId` is the
 * workflow's HOME project, and the task and session ids are EMPTY strings,
 * because no one task or session owns the event. The tap opens that project's
 * board; an `open-task` with an empty id is the blank task screen.
 */
const DECRYPTED_WORKFLOW_COMPLETE = {
  title: 'Workflow complete',
  body: 'Checkout hardening - All 6 tasks are in Done.',
  category: 'workflow-complete',
  data: { taskId: '', projectId: 'home-project', sessionId: '', category: 'workflow-complete' },
};

/** The string-valued notifee `data` Android posts for a decrypted workflow-complete push. */
const WORKFLOW_COMPLETE_PRESS_DATA = DECRYPTED_WORKFLOW_COMPLETE.data;

const PROJECT_BOARD_TARGET = {
  kind: 'open-project-board',
  projectId: 'home-project',
};

describe('tapRouter - iOS push responses', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.OS = 'ios';
    routerMock.push.mockClear();
    routerMock.navigate.mockClear();
    notifeeMock.onForegroundEvent.mockClear();
    notifeeMock.onBackgroundEvent.mockClear();
    expoNotificationsMock.addNotificationResponseReceivedListener.mockClear();
    expoNotificationsMock.getLastNotificationResponseAsync.mockClear();
    expoNotificationsMock.getLastNotificationResponseAsync.mockResolvedValue(null);
    decryptPushBlobMock.mockReset();
    decryptPushBlobMock.mockResolvedValue(DECRYPTED);
  });

  it('decrypts the tapped blob and publishes the task open, with no lens, so the screen opens the remembered one', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('sealed-blob');
    expect(published).toEqual([DECRYPTED_TARGET]);
    expect(pendingNavigation.getPendingNavigation()).toEqual(DECRYPTED_TARGET);
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR. `router.push` does not navigate, it
   * appends to expo-router's routing queue; the queue is drained by a React
   * effect that throws 'Attempted to navigate before mounting the Root Layout
   * component' when no navigator has mounted. On a native cold start that
   * window is real, the effect sits above every error boundary, and the throw
   * aborts the process - which is the 0.6.3 build 13 TestFlight crash. A
   * try/catch cannot help, because push itself never throws.
   *
   * So the invariant is structural: nothing in this module may navigate.
   */
  it('never navigates from module scope, publishing a pending open instead', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(pendingNavigation.getPendingNavigation()).toEqual(DECRYPTED_TARGET);
  });

  /**
   * The snapshot feeds useSyncExternalStore, which re-renders forever if the
   * getter allocates. Identity, not deep equality, is the assertion.
   */
  it('returns a stable snapshot reference between publishes', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(pendingNavigation.getPendingNavigation()).toBe(pendingNavigation.getPendingNavigation());
  });

  it('clears the slot when consumed, so one tap cannot route twice', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(pendingNavigation.consumePendingNavigation()).toEqual(DECRYPTED_TARGET);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
    expect(pendingNavigation.consumePendingNavigation()).toBeNull();
  });

  /** Expo wraps the data payload as a JSON string on some delivery paths. */
  it('reads the blob out of the JSON-wrapped payload shape too', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ body: JSON.stringify({ blob: 'wrapped-blob' }) }));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('wrapped-blob');
    expect(published).toHaveLength(1);
  });

  /**
   * Mutation that reddens this: drop the `sessionKind === 'command-terminal'`
   * branch in resolveTapTarget (the tap publishes open-task for the made-up task id).
   */
  it('publishes open-command-terminal, not open-task, for a decrypted Command Terminal envelope', async () => {
    decryptPushBlobMock.mockResolvedValue(DECRYPTED_COMMAND_TERMINAL);
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(published).toEqual([COMMAND_TERMINAL_TARGET]);
    // Strict, so a stray `taskId: undefined` key (or the made-up id) cannot ride along.
    expect(pendingNavigation.getPendingNavigation()).toStrictEqual(COMMAND_TERMINAL_TARGET);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('routes a Command Terminal envelope with no session id nowhere, rather than opening the made-up task', async () => {
    decryptPushBlobMock.mockResolvedValue({
      ...DECRYPTED_COMMAND_TERMINAL,
      data: { ...DECRYPTED_COMMAND_TERMINAL.data, sessionId: '' },
    });
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(decryptPushBlobMock).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(0);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
  });

  it('still publishes open-task for a decrypted envelope that carries no sessionKind', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'task-blob' }, 'task-notification'));
    decryptPushBlobMock.mockResolvedValue(DECRYPTED_COMMAND_TERMINAL);
    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'terminal-blob' }, 'terminal-notification'));
    decryptPushBlobMock.mockResolvedValue(DECRYPTED);
    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'task-blob-again' }, 'task-notification-again'));

    // Each tap routes by ITS OWN envelope: the terminal in the middle does not
    // turn the task taps around it into terminal opens, or the reverse.
    expect(published).toEqual([DECRYPTED_TARGET, COMMAND_TERMINAL_TARGET, DECRYPTED_TARGET]);
  });

  /**
   * REGRESSION. A workflow-complete envelope carries EMPTY task and session
   * ids, and the iOS router used to publish it as `open-task` with
   * `taskId: ''`, which is the blank task screen. It opens the workflow's home
   * project on the Board instead.
   *
   * Mutation that reddens this: drop the `workflow-complete` branch in the tap
   * resolution (the tap publishes open-task with an empty task id).
   */
  it('publishes open-project-board with the home project for a workflow-complete envelope with empty ids', async () => {
    decryptPushBlobMock.mockResolvedValue(DECRYPTED_WORKFLOW_COMPLETE);
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'workflow-notification'));

    expect(published).toEqual([PROJECT_BOARD_TARGET]);
    // Strict, so a stray empty `taskId` or `sessionId` cannot ride along.
    expect(published[0]).toStrictEqual(PROJECT_BOARD_TARGET);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('routes a workflow-complete envelope with no project id nowhere', async () => {
    decryptPushBlobMock.mockResolvedValue({
      ...DECRYPTED_WORKFLOW_COMPLETE,
      data: { ...DECRYPTED_WORKFLOW_COMPLETE.data, projectId: '' },
    });
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'workflow-notification-no-project'));

    expect(published).toHaveLength(0);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
  });

  /**
   * REGRESSION. iOS had no empty-task-id guard at all, so any task envelope
   * with an empty task id opened a blank task screen. A task's alert needs its
   * task, on both platforms: this one routes nowhere.
   *
   * Mutation that reddens this: drop the `taskId.length === 0` check from the
   * task branch of the tap resolution.
   */
  it('publishes nothing for a task envelope whose task id is empty', async () => {
    decryptPushBlobMock.mockResolvedValue({ ...DECRYPTED, data: { ...DECRYPTED.data, taskId: '' } });
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'empty-task-notification'));

    expect(published).toHaveLength(0);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
  });

  it('routes nowhere when the blob cannot be decrypted', async () => {
    decryptPushBlobMock.mockResolvedValue(null);
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'tampered-blob' }));

    expect(published).toHaveLength(0);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
  });

  it('routes nowhere when the payload carries no blob at all', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ someOtherKey: 'value' }));

    expect(decryptPushBlobMock).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it('routes nowhere for a null response (no cold-start tap)', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(null);

    expect(published).toHaveLength(0);
  });

  /**
   * The cold-start read and the warm listener are two independent deliveries of
   * the SAME tap, and expo-notifications can surface one tap through both (its
   * own useLastNotificationResponse de-duplicates by request identifier for
   * exactly this reason). Routing both would push the task screen twice, so the
   * user needs two back presses to leave it.
   */
  it('routes one tap once when both deliveries carry the same notification identifier', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));
    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));

    expect(published).toHaveLength(1);
    expect(decryptPushBlobMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half of the guard: de-duplication must not swallow a genuinely
   * different tap, which is the failure mode that would silently break routing.
   */
  it('still routes a second tap carrying a different notification identifier', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));
    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-2'));

    expect(published).toHaveLength(2);
  });

  /**
   * The de-dup guard is deliberately keyed on `typeof identifier === 'string'
   * && identifier.length > 0`, not on blind equality against the last-routed
   * value. A payload that carries no identifier at all must still route EVERY
   * time - dropping a real tap is worse than a rare double - so two separate
   * taps that both omit an identifier are two separate routes, not a dedup
   * pair. Blind equality would compare `undefined === undefined` on the
   * second call and silently swallow it.
   */
  it('routes every tap that omits a notification identifier, never deduping them against each other', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));
    await tapRouter.routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(published).toHaveLength(2);
  });

  /**
   * A cold-start tap happened before any listener existed, so the warm listener
   * alone would drop it. Both paths have to be wired, and neither may reach for
   * notifee, whose events only ever fire for notifications notifee itself
   * displayed - which on iOS is none of them.
   */
  it('registers both the warm listener and the cold-start read, and no notifee handlers', async () => {
    const { tapRouter } = await loadModules();

    tapRouter.registerNotificationTapHandlers();

    expect(expoNotificationsMock.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(expoNotificationsMock.getLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
    expect(notifeeMock.onForegroundEvent).not.toHaveBeenCalled();
    expect(notifeeMock.onBackgroundEvent).not.toHaveBeenCalled();
  });

  /**
   * The test above only proves getLastNotificationResponseAsync was CALLED,
   * not that its resolution actually reaches routeFromPushResponse. A broken
   * `.then((response) => routeFromPushResponse(response))` - a dropped
   * argument, a typo - would leave every cold-start tap silently unrouted
   * while that assertion still passed.
   */
  it('routes a cold-start tap through the getLastNotificationResponseAsync resolution', async () => {
    expoNotificationsMock.getLastNotificationResponseAsync.mockResolvedValue(
      pushResponse({ blob: 'sealed-blob' }, 'cold-start-notification'),
    );
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    tapRouter.registerNotificationTapHandlers();
    await vi.waitFor(() => expect(published).toHaveLength(1));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('sealed-blob');
    expect(published[0]).toEqual(DECRYPTED_TARGET);
    // Even the cold-start path, the one that runs earliest of all, must not
    // reach the router itself.
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  /**
   * The other failure shape of the same wiring: no cold-start response at all
   * (a fresh install) resolves the module unavailable and getLastNotificationResponseAsync
   * rejects. The `.catch()` after the `.then()` has to swallow it - an
   * unswallowed rejection would surface as an unhandled rejection rather than
   * a quiet "nothing to route".
   */
  it('swallows a rejected cold-start read without throwing or routing', async () => {
    expoNotificationsMock.getLastNotificationResponseAsync.mockRejectedValue(new Error('module unavailable'));
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    expect(() => tapRouter.registerNotificationTapHandlers()).not.toThrow();
    // Give the rejected promise's .catch() a turn to run.
    await flushMicrotasks();

    expect(published).toHaveLength(0);
  });

  it('registers the notifee handlers on Android instead, and never the expo listener', async () => {
    platformMock.OS = 'android';
    const { tapRouter } = await loadModules();

    tapRouter.registerNotificationTapHandlers();

    expect(notifeeMock.onForegroundEvent).toHaveBeenCalledTimes(1);
    expect(notifeeMock.onBackgroundEvent).toHaveBeenCalledTimes(1);
    expect(expoNotificationsMock.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
  });

  it('registers once however many times it is called', async () => {
    const { tapRouter } = await loadModules();

    tapRouter.registerNotificationTapHandlers();
    tapRouter.registerNotificationTapHandlers();

    expect(expoNotificationsMock.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
  });
});

describe('tapRouter - Android notifee presses', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.OS = 'android';
    routerMock.push.mockClear();
    routerMock.navigate.mockClear();
    notifeeMock.onForegroundEvent.mockClear();
    notifeeMock.onBackgroundEvent.mockClear();
    notifeeMock.getInitialNotification.mockReset();
    notifeeMock.getInitialNotification.mockResolvedValue(null);
    decryptPushBlobMock.mockReset();
  });

  /**
   * A tap on an alert for an app the OS had KILLED launches the process, and
   * notifee reports that press only through getInitialNotification - neither
   * listener fires. The router never read it on Android, so the tap opened
   * the Agents feed and dropped the task (measured on a release build: no
   * session-open at all after the tap).
   *
   * Mutation that reddens this: drop the getInitialNotification read.
   */
  it('routes the press that launched a killed process', async () => {
    notifeeMock.getInitialNotification.mockResolvedValue({
      notification: { id: 'alert-1', data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' } },
      pressAction: { id: 'default' },
    });
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    tapRouter.registerNotificationTapHandlers();
    await flushMicrotasks();

    expect(published).toEqual([
      { kind: 'open-task', taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' },
    ]);
  });

  /**
   * When FCM had started the process headlessly, the same press can arrive
   * through the background listener AND as the launching notification. It
   * routes once.
   *
   * Mutation that reddens this: drop the notification-id latch.
   */
  it('routes a press reported by both the listener and the launch read once', async () => {
    const launchingNotification = {
      id: 'alert-2',
      data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' },
    };
    notifeeMock.getInitialNotification.mockResolvedValue({ notification: launchingNotification, pressAction: { id: 'default' } });
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onBackgroundEvent = notifeeMock.onBackgroundEvent.mock.calls[0][0] as (event: unknown) => Promise<void>;
    await onBackgroundEvent({ type: 1, detail: { notification: launchingNotification } });
    await flushMicrotasks();

    expect(published).toHaveLength(1);
  });

  it('still routes a second, different notification for the same task', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    const data = { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' };
    onForegroundEvent({ type: 1, detail: { notification: { id: 'alert-3', data } } });
    onForegroundEvent({ type: 1, detail: { notification: { id: 'alert-4', data } } });

    expect(published).toHaveLength(2);
  });

  /**
   * Task alerts now post under a STABLE id (one per session and category), so a
   * repeat alert replaces the one on screen. A tap on the replacement is a
   * genuine second tap and must route; an id-only latch swallowed it, leaving a
   * tap that does nothing. Each posting carries its own `postedAt`.
   *
   * Mutation that reddens this: key the latch on the notification id alone
   * (drop the `@postedAt` suffix in pressLatchKey). Seen red that way.
   */
  it('routes a tap on an alert reposted under the same stable id', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    const stableId = 'kangentic:input-required:session:sess-9';
    const routing = { category: 'input-required', taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' };
    onForegroundEvent({ type: 1, detail: { notification: { id: stableId, data: { ...routing, postedAt: '1000' } } } });
    onForegroundEvent({ type: 1, detail: { notification: { id: stableId, data: { ...routing, postedAt: '2000' } } } });

    expect(published).toHaveLength(2);
  });

  /**
   * The other half of the same key: one press on a stable-id alert, reported by
   * both the background listener and the launch read, is the SAME posting
   * (same id, same postedAt) and still routes once.
   *
   * Mutation that reddens this: key the latch on something unique per report.
   */
  it('routes a stable-id press reported by both the listener and the launch read once', async () => {
    const launchingNotification = {
      id: 'kangentic:turn-complete:session:sess-9',
      data: { category: 'turn-complete', taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9', postedAt: '1000' },
    };
    notifeeMock.getInitialNotification.mockResolvedValue({ notification: launchingNotification, pressAction: { id: 'default' } });
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onBackgroundEvent = notifeeMock.onBackgroundEvent.mock.calls[0][0] as (event: unknown) => Promise<void>;
    await onBackgroundEvent({ type: 1, detail: { notification: launchingNotification } });
    await flushMicrotasks();

    expect(published).toHaveLength(1);
  });

  /**
   * The id latch only engages on a non-empty string id: a press whose
   * notification carries none still routes every time, because dropping a real
   * tap is worse than a rare double. Two presses, since a single one routes
   * with or without the guard.
   *
   * Mutation that reddens this: latch unconditionally (make pressLatchKey
   * return a key for a missing or empty id).
   */
  it('routes every press of a notification that has no id, rather than latching on its absence', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    const data = { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' };
    onForegroundEvent({ type: 1, detail: { notification: { data } } });
    onForegroundEvent({ type: 1, detail: { notification: { data } } });
    onForegroundEvent({ type: 1, detail: { notification: { id: '', data } } });
    onForegroundEvent({ type: 1, detail: { notification: { id: '', data } } });

    expect(published).toHaveLength(4);
  });

  /**
   * getInitialNotification rejects when there is no launching press to report
   * or the native module is unavailable. That is "nothing to route", never an
   * unhandled rejection out of the boot path, and the live listeners still work.
   *
   * Mutation that reddens this: drop the `.catch` on the launch read (vitest
   * reports the unhandled rejection and fails the run).
   */
  it('treats a failed launch read as no launching press, and still routes later presses', async () => {
    notifeeMock.getInitialNotification.mockRejectedValue(new Error('native module unavailable'));
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);

    tapRouter.registerNotificationTapHandlers();
    await flushMicrotasks();

    expect(notifeeMock.getInitialNotification).toHaveBeenCalledTimes(1);
    expect(published).toEqual([]);

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { id: 'alert-5', data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' } } },
    });
    expect(published).toHaveLength(1);
  });

  /**
   * Android notifications are posted by notifee AFTER decryption, so the ids
   * are already on the notification and nothing is decrypted a second time.
   */
  it('opens the task straight from the notification data, without decrypting', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' } } },
    });

    expect(decryptPushBlobMock).not.toHaveBeenCalled();
    expect(published).toEqual([
      { kind: 'open-task', taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' },
    ]);
  });

  /**
   * Android reaches the same unmounted-navigator window on its second commit,
   * so the no-navigation invariant is not an iOS-only concern.
   */
  it('never navigates from the notifee press handler either', async () => {
    const { tapRouter } = await loadModules();
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' } } },
    });

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  /**
   * Android posts a push AFTER decrypting it, so its press carries the
   * envelope's routing identity in notifee `data`, string-valued, with
   * `sessionKind` only for a Command Terminal. The made-up `taskId` is present
   * and must be ignored.
   *
   * Mutation that reddens this: drop the `data.sessionKind` read in
   * routeFromNotificationPress (the press publishes open-task).
   */
  it('publishes open-command-terminal for a press whose data names a Command Terminal', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { id: 'terminal-alert-1', data: COMMAND_TERMINAL_PRESS_DATA } },
    });

    expect(decryptPushBlobMock).not.toHaveBeenCalled();
    expect(published).toEqual([COMMAND_TERMINAL_TARGET]);
    expect(published[0]).toStrictEqual(COMMAND_TERMINAL_TARGET);
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  /**
   * All three Android delivery paths share the resolution: the foreground
   * listener, the background listener, and the one-time read of the press that
   * launched a killed process. A branch wired into only one of them would send
   * the others' terminal taps to the made-up task.
   */
  it.each(['foreground', 'background', 'launch'] as const)(
    'resolves a Command Terminal press delivered through the %s path',
    async (deliveryPath) => {
      const terminalNotification = { id: `terminal-alert-${deliveryPath}`, data: COMMAND_TERMINAL_PRESS_DATA };
      if (deliveryPath === 'launch') {
        notifeeMock.getInitialNotification.mockResolvedValue({ notification: terminalNotification, pressAction: { id: 'default' } });
      }
      const { tapRouter, pendingNavigation } = await loadModules();
      const published = recordPublished(pendingNavigation);
      tapRouter.registerNotificationTapHandlers();

      if (deliveryPath === 'foreground') {
        const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
        onForegroundEvent({ type: 1, detail: { notification: terminalNotification } });
      } else if (deliveryPath === 'background') {
        const onBackgroundEvent = notifeeMock.onBackgroundEvent.mock.calls[0][0] as (event: unknown) => Promise<void>;
        await onBackgroundEvent({ type: 1, detail: { notification: terminalNotification } });
      }
      await flushMicrotasks();

      expect(published).toEqual([COMMAND_TERMINAL_TARGET]);
    },
  );

  it('publishes nothing for a Command Terminal press with an empty session id, not the made-up task', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { id: 'terminal-alert-2', data: { ...COMMAND_TERMINAL_PRESS_DATA, sessionId: '' } } },
    });

    expect(published).toHaveLength(0);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
  });

  it('keeps routing a task press as open-task between two Command Terminal presses', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({ type: 1, detail: { notification: { id: 'terminal-alert-3', data: COMMAND_TERMINAL_PRESS_DATA } } });
    onForegroundEvent({
      type: 1,
      detail: { notification: { id: 'task-alert-1', data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' } } },
    });
    onForegroundEvent({ type: 1, detail: { notification: { id: 'terminal-alert-4', data: COMMAND_TERMINAL_PRESS_DATA } } });

    expect(published).toEqual([
      COMMAND_TERMINAL_TARGET,
      { kind: 'open-task', taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' },
      COMMAND_TERMINAL_TARGET,
    ]);
  });

  /**
   * REGRESSION. The local notifier (foreground-service mode, app backgrounded)
   * posts a Command Terminal alert whose data comes from its activity-store
   * entry, and a terminal's entry has NO task: `taskId` is the empty string
   * (localNotifier.test.ts pins this exact data shape). The press router
   * used to bail on `!taskId` BEFORE it read `sessionKind`, so tapping that alert
   * routed nowhere while the same terminal's PUSH alert (made-up non-empty taskId,
   * the test above) opened it. The identity that matters for a terminal is its
   * sessionId, so the task-id requirement must not apply to it.
   *
   * Mutation that reddens this: restore `if (!taskId) return;` right after the
   * taskId read (the press publishes nothing).
   */
  it('publishes open-command-terminal for a LOCAL notifier press, whose data carries an empty taskId', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: {
        notification: {
          id: 'local-terminal-alert-1',
          data: { taskId: '', projectId: 'project-1', sessionId: 'sess-term', sessionKind: 'command-terminal' },
        },
      },
    });

    expect(published).toEqual([{ kind: 'open-command-terminal', projectId: 'project-1', sessionId: 'sess-term' }]);
    expect(published[0]).toStrictEqual({ kind: 'open-command-terminal', projectId: 'project-1', sessionId: 'sess-term' });
  });

  it('publishes nothing for a local Command Terminal press with neither a task id nor a session id', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { data: { taskId: '', projectId: 'project-1', sessionId: '', sessionKind: 'command-terminal' } } },
    });

    expect(published).toHaveLength(0);
  });

  /**
   * The other side of the same relaxation: it is keyed on `sessionKind`, so a
   * TASK press with an empty task id (a session id alone is not enough for a
   * task) must still publish nothing rather than open a blank task screen.
   *
   * Mutation that reddens this: relax the guard to "taskId or sessionId" for
   * every press (the task press publishes open-task with an empty task id).
   */
  it('still publishes nothing for a task press whose task id is empty, even with a session id', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { id: 'task-alert-empty', data: { taskId: '', projectId: 'project-1', sessionId: 'sess-term' } } },
    });

    expect(published).toHaveLength(0);
  });

  /**
   * REGRESSION. A decrypted workflow-complete push is posted with EMPTY task
   * and session ids in its notifee `data`, and the press router dropped
   * every press whose task id was empty, so tapping "Workflow complete" did
   * nothing. It opens the workflow's home project on the Board, through all
   * three Android delivery paths (a killed app reports only the launch read).
   *
   * Mutation that reddens this: drop the `workflow-complete` branch in the tap
   * resolution (the press publishes nothing).
   */
  it.each(['foreground', 'background', 'launch'] as const)(
    'publishes open-project-board for a workflow-complete press with empty ids, delivered through the %s path',
    async (deliveryPath) => {
      const workflowNotification = { id: `workflow-alert-${deliveryPath}`, data: WORKFLOW_COMPLETE_PRESS_DATA };
      if (deliveryPath === 'launch') {
        notifeeMock.getInitialNotification.mockResolvedValue({ notification: workflowNotification, pressAction: { id: 'default' } });
      }
      const { tapRouter, pendingNavigation } = await loadModules();
      const published = recordPublished(pendingNavigation);
      tapRouter.registerNotificationTapHandlers();

      if (deliveryPath === 'foreground') {
        const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
        onForegroundEvent({ type: 1, detail: { notification: workflowNotification } });
      } else if (deliveryPath === 'background') {
        const onBackgroundEvent = notifeeMock.onBackgroundEvent.mock.calls[0][0] as (event: unknown) => Promise<void>;
        await onBackgroundEvent({ type: 1, detail: { notification: workflowNotification } });
      }
      await flushMicrotasks();

      expect(decryptPushBlobMock).not.toHaveBeenCalled();
      expect(published).toEqual([PROJECT_BOARD_TARGET]);
      expect(published[0]).toStrictEqual(PROJECT_BOARD_TARGET);
      expect(routerMock.push).not.toHaveBeenCalled();
      expect(routerMock.navigate).not.toHaveBeenCalled();
    },
  );

  /** One press, two reports (FCM had started the process headlessly): it routes once, as a task press does. */
  it('routes a workflow-complete press reported by both the listener and the launch read once', async () => {
    const launchingNotification = { id: 'workflow-alert-twice', data: WORKFLOW_COMPLETE_PRESS_DATA };
    notifeeMock.getInitialNotification.mockResolvedValue({ notification: launchingNotification, pressAction: { id: 'default' } });
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onBackgroundEvent = notifeeMock.onBackgroundEvent.mock.calls[0][0] as (event: unknown) => Promise<void>;
    await onBackgroundEvent({ type: 1, detail: { notification: launchingNotification } });
    await flushMicrotasks();

    expect(published).toEqual([PROJECT_BOARD_TARGET]);
  });

  it('publishes nothing for a workflow-complete press with no project id', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { id: 'workflow-alert-no-project', data: { ...WORKFLOW_COMPLETE_PRESS_DATA, projectId: '' } } },
    });

    expect(published).toHaveLength(0);
    expect(pendingNavigation.getPendingNavigation()).toBeNull();
  });

  /**
   * The relaxation is keyed on the CATEGORY: any other category's press with
   * the same empty ids and a project id still publishes nothing, rather than
   * opening a board (or a blank task) for an alert that names a task.
   *
   * Mutation that reddens this: route every empty-task-id press with a project
   * id to its board.
   */
  it('still publishes nothing for another category whose press carries empty ids and a project id', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { id: 'idle-alert-empty', data: { ...WORKFLOW_COMPLETE_PRESS_DATA, category: 'turn-complete' } } },
    });

    expect(published).toHaveLength(0);
  });

  it('ignores a press carrying no taskId', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({ type: 1, detail: { notification: { data: {} } } });

    expect(published).toHaveLength(0);
  });

  it('ignores non-press events', async () => {
    const { tapRouter, pendingNavigation } = await loadModules();
    const published = recordPublished(pendingNavigation);
    tapRouter.registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({ type: 0, detail: { notification: { data: { taskId: 'task-9' } } } });

    expect(published).toHaveLength(0);
  });
});
