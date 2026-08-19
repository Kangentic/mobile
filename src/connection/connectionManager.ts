import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { ChannelController, SubscriptionManager, type VerbClient } from '@/channel';
import { DeviceIdentityManager } from '@/pairing/deviceIdentity';
import { TrustAnchorStore } from '@/pairing/trustAnchor';
import { setActivePushIdentityPublicKey } from '@/notifications/pushIdentity';
import { notificationPermissionGranted, notificationPermissionStatus } from '@/notifications/permissionCache';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { bindFeedToStores, createSnapshotSinks } from './storeFeed';
import { runBootstrap } from './bootstrap';

// The notifee-backed notification modules (foreground service, local
// notifier, push registration, channels) load lazily: notifee throws at import
// time when its native module is absent (Jest component tests reach this file
// through actions.ts), and the lifecycle only needs them at established/
// background time anyway. pushIdentity and permissionCache stay static - both
// are pure TS, and the permission cache specifically MUST be readable
// synchronously on the background transition (see its own header).

/**
 * The app's one connection lifecycle owner, a module-level singleton
 * following the activePairing.ts pattern: a live ChannelController is a
 * stateful crypto object with a transport, not serializable UI state.
 * Screens read channelStore (which this feeds) and call actions.ts (which
 * reads the active connection from here).
 *
 * Lifecycle policy: connect while the app is foregrounded and paired.
 * On background it depends on settings: with backgroundNotificationsMode
 * 'foreground-service' (Android only), hydrated settings, an established
 * connection, and POST_NOTIFICATIONS not known-denied, the channel stays
 * alive under a notifee foreground service and the local notifier turns
 * activity transitions into notifications - for at most five minutes
 * (BACKGROUND_KEEPALIVE_MAX_MS), after which the service stops and the
 * channel is disposed, handing alerting over to remote push. In every other
 * case ('push-only', 'off', iOS, no established connection, settings not yet
 * hydrated, or a permission the user was asked for and refused) the
 * connection is disposed immediately as before (iOS suspends the socket
 * within seconds anyway, the desktop treats a vanished phone fine - relay
 * close tears its subscriptions down - and remote E2E push covers the
 * away-from-app case). iOS 'inactive' (app switcher, permission dialogs)
 * counts as still-active.
 *
 * This module composes pairing (trust anchor), channel, and stores, so it
 * lives in its own src/connection/ directory: src/channel/ stays a pure
 * protocol layer and src/pairing/ already imports channel, so parking the
 * composer in either would tangle the layering. It carries the same
 * accountless-core discipline as both (see .claude/rules/accountless-core.md).
 */

// Bootstrap retry backoff: 2s, 4s, 8s, ... capped at 30s, while the session
// stays established (see the retry comment inside openConnection).
const BOOTSTRAP_RETRY_BASE_MS = 2000;
const BOOTSTRAP_RETRY_MAX_MS = 30_000;

export interface ActiveConnection {
  controller: ChannelController;
  verbs: VerbClient;
  subscriptions: SubscriptionManager;
}

/**
 * Why a connection is being torn down, expressed as what the desktop is TOLD
 * rather than as a cause - because the causes do not sort cleanly. Unpairing
 * is deliberate and permanent; backgrounding is equally deliberate but the
 * phone intends to come back, and announcing on every foreground/background
 * cycle would flap the desktop's badge. An app kill or a dead network never
 * gets here at all.
 *
 * 'stay-silent' is the default everywhere on purpose: a new call site that
 * forgets to think about this falls back to today's behaviour (the desktop
 * infers departure from the dropped socket), never to a spurious goodbye.
 */
export type ConnectionTeardownIntent = 'announce-departure' | 'stay-silent';

const deviceIdentityManager = new DeviceIdentityManager();
const trustAnchorStore = new TrustAnchorStore();

let appStateSubscription: NativeEventSubscription | null = null;
let activeConnection: ActiveConnection | null = null;
let teardownActiveConnection: ((intent: ConnectionTeardownIntent) => void) | null = null;
let connectGeneration = 0;

export class NotConnectedError extends Error {
  constructor() {
    super('Not connected to the desktop');
    this.name = 'NotConnectedError';
  }
}

export function getActiveConnection(): ActiveConnection | null {
  return activeConnection;
}

/** For action call sites: throws a typed error the UI maps to "reconnect first". */
export function requireVerbClient(): VerbClient {
  if (!activeConnection || !activeConnection.controller.session.isEstablished) throw new NotConnectedError();
  return activeConnection.verbs;
}

export function requireSubscriptions(): SubscriptionManager {
  if (!activeConnection) throw new NotConnectedError();
  return activeConnection.subscriptions;
}

/**
 * Unpairing must leave the old desktop unable to push: send the unregister
 * request while the channel is still up (called from DevicesScreen BEFORE
 * the trust anchor is cleared and the connection torn down), then wipe the
 * local push key so a stale key can never open a future envelope. Lives
 * here (not in the screen) so its dynamic imports follow this module's own
 * lazy-load convention (notifee/expo-notifications throw at import time
 * without their native module, which the Jest component tier hits with no
 * dynamic-import support). Best-effort: a failure here must never block
 * the rest of unpairing.
 */
export async function revokePushRegistrationForUnpair(): Promise<void> {
  // Two independent try blocks on purpose: the local key wipe is the half
  // that actually secures THIS device, so it must not be reachable only
  // when the network unregister succeeds. Sharing one block would let a
  // throw from the import or the verb call skip the wipe entirely and
  // leave a usable push key behind on an unpaired phone.
  try {
    const { unregisterPushWithDesktop } = await import('@/notifications/pushRegistration');
    await unregisterPushWithDesktop(activeConnection?.verbs ?? null);
  } catch {
    // Best-effort; the desktop's own roster revocation is the backstop.
  }
  try {
    const { clearPushRegistration } = await import('@/notifications/pushKeys');
    await clearPushRegistration();
  } catch {
    // Best-effort; see the doc comment above.
  }
}

/**
 * A desktop-side revoke, delivered as the session's Final frame. Final is
 * only ever sent on deliberate unpair - never on quit, sleep, backgrounding,
 * or reconnect (see docs/security.md) - so it is a certain signal: clear the
 * pairing and land the UI on the unpaired home. The push unregister here is
 * LOCAL-only, unlike revokePushRegistrationForUnpair: the desktop that just
 * revoked us has already dropped this device's registration, and the channel
 * an unregister request would ride is being torn down under us.
 */
let remoteRevocationInFlight = false;

async function handleDesktopRevocation(controller: ChannelController): Promise<void> {
  // Two Finals back-to-back would interleave at the awaits without this.
  if (remoteRevocationInFlight) return;
  // A Final racing a local unpair or a background teardown belongs to a
  // connection whose fate was already decided.
  if (activeConnection?.controller !== controller) return;
  remoteRevocationInFlight = true;
  try {
    // Flip the UI first: closeConnection's store reset preserves pairedState,
    // and the reopen re-derives 'unpaired' from the cleared anchor.
    useChannelStore.getState().setPairedState('unpaired');
    try {
      const { clearPushRegistration } = await import('@/notifications/pushKeys');
      await clearPushRegistration();
    } catch {
      // Best-effort, same as revokePushRegistrationForUnpair's local half.
    }
    try {
      const { unpairLocally } = await import('./actions');
      await unpairLocally('stay-silent');
    } catch {
      // A failed Keychain delete leaves a stale anchor behind; the desktop
      // no longer answers it, and Devices still offers a manual unpair.
    }
    try {
      const { router } = await import('expo-router');
      if (router.canDismiss()) router.dismissAll();
      router.navigate('/');
    } catch {
      // Navigator not mounted (a background revoke); the next launch renders
      // the unpaired home on its own.
    }
  } finally {
    remoteRevocationInFlight = false;
  }
}

/**
 * Re-sends the register-push payload after the user changes a category
 * toggle in Settings, so the desktop's filter reflects the new preference
 * immediately rather than waiting for the next reconnect. Fire-and-forget,
 * best-effort, and a no-op while disconnected (the next established
 * bootstrap already sends the current preference set). Lives here for the
 * same lazy-load reason as revokePushRegistrationForUnpair above.
 */
export async function resyncPushRegistrationCategories(): Promise<void> {
  try {
    const { registerPushWithDesktop } = await import('@/notifications/pushRegistration');
    await registerPushWithDesktop(activeConnection?.verbs ?? null);
  } catch {
    // Best-effort; the next established bootstrap retries.
  }
}

/**
 * Every call site invokes this as a bare `void openConnection()`, so a rejection
 * has nowhere to go. That is not merely untidy: `pairedState` starts at 'unknown'
 * and only leaves it inside openConnectionOrThrow, so a throw anywhere before that
 * point strands it at 'unknown' forever. TriageHomeScreen renders the pair CTA only
 * for 'unpaired', which means the user sits on "Connecting to your desktop..."
 * permanently with no error, no retry, and no route to pairing.
 *
 * Found on iOS by the CI simulator smoke test, where a fresh install never offered
 * to pair. Note the sibling bug task #14 fixed independently: a lost bootstrap
 * leaving a PAIRED app on the same screen. Two different paths, one dead end, which
 * is the real lesson - this screen has no state meaning "something failed, here is
 * how to recover".
 *
 * Falling back to 'unpaired' is deliberate over inventing an error state. It is
 * always recoverable (the pair CTA appears, and re-pairing overwrites the anchor),
 * and it is self-correcting: the next foreground calls this again, and a load that
 * now succeeds sets 'paired'. Only the stranded 'unknown' case is rescued; a failure
 * after 'paired' is already covered by the existing reconnect paths.
 */
async function openConnection(): Promise<void> {
  try {
    await openConnectionOrThrow();
  } catch (error: unknown) {
    if (useChannelStore.getState().pairedState === 'unknown') {
      useChannelStore.getState().setPairedState('unpaired');
    }
    if (__DEV__) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`[connection] open failed before the trust anchor resolved (${reason}); showing the pairing CTA`);
    }
  }
}

/**
 * Serializes opens, between the swallowing wrapper above and the work below.
 * performOpenConnection awaits secure storage before it can even tell whether
 * it should proceed, so two callers arriving in that window (the lifecycle's
 * initial connect and an AppState 'active', say) both saw no active connection
 * and both built one. Whichever finished last became `activeConnection` and the
 * other was orphaned while still connected - reconnecting on its own backoff
 * forever and writing its transport state into the shared channel store, which
 * presented as a status flickering between connected and reconnecting on a
 * phone whose session was fine. Concurrent callers now join the attempt already
 * running.
 */
let openAttempt: Promise<void> | null = null;

function openConnectionOrThrow(): Promise<void> {
  if (activeConnection) return Promise.resolve();
  if (openAttempt) return openAttempt;
  const attempt = performOpenConnection().finally(() => {
    // Only clear if this attempt is still the current one: closeConnection
    // abandons it deliberately, and a newer attempt may already have taken
    // its place.
    if (openAttempt === attempt) openAttempt = null;
  });
  openAttempt = attempt;
  return attempt;
}

async function performOpenConnection(): Promise<void> {
  if (activeConnection) return;
  const generation = connectGeneration;

  // Dev-only mock desktop (the dev rig's mock mode sets
  // EXPO_PUBLIC_KANGENTIC_MOCK=1): the real channel stack runs against an
  // in-process fake desktop over a loopback transport - no relay, no
  // pairing, no trust anchor. Metro strips this branch and the dynamically
  // imported module from production bundles.
  let mockDesktop: import('./mockDesktop').MockDesktop | null = null;
  if (__DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_MOCK === '1') {
    const { createMockDesktop } = await import('./mockDesktop');
    mockDesktop = createMockDesktop();
  }

  // Dev-only instant pairing (the dev rig's live mode): identity and the
  // pinned desktop key arrive via EXPO_PUBLIC_KANGENTIC_DEV_PAIRING and
  // the SecureStore trust anchor is bypassed entirely. See devPairing.ts.
  let devPairing: import('./devPairing').DevPairing | null = null;
  if (__DEV__ && !mockDesktop && process.env.EXPO_PUBLIC_KANGENTIC_DEV_PAIRING) {
    const { getDevPairing } = await import('./devPairing');
    devPairing = getDevPairing();
  }

  const anchor: { desktopStaticPublicKey: Uint8Array; relayAddress: string } | null = mockDesktop
    ? { desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey, relayAddress: 'loopback://mock-desktop' }
    : devPairing
      ? { desktopStaticPublicKey: devPairing.desktopStaticPublicKey, relayAddress: devPairing.relayAddress }
      : await trustAnchorStore.load();
  if (!anchor) {
    // Not paired (or a partial/legacy anchor): stay idle; the pairing flow
    // triggers a reconnect via reconnectNow() when it completes.
    useChannelStore.getState().setPairedState('unpaired');
    return;
  }
  useChannelStore.getState().setPairedState('paired');
  const identity = mockDesktop ? mockDesktop.identity : devPairing ? devPairing.identity : await deviceIdentityManager.getIdentity();
  // The AAD every push envelope is sealed against - whichever identity
  // this connection actually pairs under (mock/dev identities included).
  setActivePushIdentityPublicKey(identity.publicKey);
  // A background/dispose (or a second open) raced our secure-store reads.
  if (generation !== connectGeneration || activeConnection) {
    mockDesktop?.dispose();
    return;
  }

  const controller = new ChannelController({
    identity,
    desktopStaticPublicKey: anchor.desktopStaticPublicKey,
    relayUrl: anchor.relayAddress,
    ...(mockDesktop ? { transport: mockDesktop.phoneTransport } : {}),
  });

  // The sinks need the manager back (board snapshots re-declare the stream
  // desired set), so hand them a lazy getter resolved after construction.
  let subscriptionsHolder: SubscriptionManager | null = null;
  const subscriptions: SubscriptionManager = new SubscriptionManager({
    session: controller.session,
    verbs: controller.verbs,
    sinks: createSnapshotSinks((): SubscriptionManager => {
      if (!subscriptionsHolder) throw new Error('SubscriptionManager sink resolved before construction completed');
      return subscriptionsHolder;
    }),
  });
  subscriptionsHolder = subscriptions;

  // Dev-only inspect loop: expose this connection's SubscriptionManager to
  // the state-dump bridge (dynamic import keeps it out of prod bundles).
  let inspectStateModule: typeof import('@/devsupport/inspectState') | null = null;
  if (__DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1') {
    inspectStateModule = await import('@/devsupport/inspectState');
    inspectStateModule.setInspectSubscriptions(subscriptions);
  }

  const unbindFeed = bindFeedToStores(controller.feed, subscriptions);
  const unsubscribeTransportState = controller.transport.onStateChange((state) => {
    useChannelStore.getState().setTransportState(state);
  });

  // Bootstrap must eventually succeed while the session stays established.
  // The first attempt can die silently - the request can be lost in the
  // pairing-to-session transition or time out mid-rekey - and a QUIET rekey
  // never re-fires onEstablished (only a transport drop does), so without
  // this retry one lost bootstrap leaves the app on "Connecting..." with a
  // healthy channel until a manual pull-to-refresh.
  let bootstrapRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let bootstrapGeneration = 0;
  const runBootstrapWithRetry = (attempt: number, generation: number): void => {
    void runBootstrap(controller.verbs, subscriptions).catch((bootstrapError: unknown) => {
      if (generation !== bootstrapGeneration) return;
      if (!controller.session.isEstablished) return;
      const delayMs = Math.min(BOOTSTRAP_RETRY_MAX_MS, BOOTSTRAP_RETRY_BASE_MS * 2 ** attempt);
      if (__DEV__) {
        const reason = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
        console.log(`[bootstrap] attempt ${attempt + 1} failed (${reason}); retrying in ${delayMs}ms`);
      }
      bootstrapRetryTimer = setTimeout(() => runBootstrapWithRetry(attempt + 1, generation), delayMs);
    });
  };

  const unsubscribeEstablished = controller.session.onEstablished(() => {
    useChannelStore.getState().markEstablished();
    if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer);
    bootstrapGeneration += 1;
    runBootstrapWithRetry(0, bootstrapGeneration);
    // Fire-and-forget push registration on every established handshake
    // (idempotent; re-hits the wire only on first run or token rotation).
    // Never fatal: registerPushWithDesktop records a status instead.
    if (useSettingsStore.getState().backgroundNotificationsMode !== 'off') {
      void import('@/notifications/pushRegistration')
        .then(({ registerPushWithDesktop }) => registerPushWithDesktop(controller.verbs))
        .catch(() => {
          // Registration is best-effort; the status surface stays 'pending'.
        });
    }
    maybeRequestNotificationPermission();
  });

  // The only observable that a rekey happened. Streams and subscriptions
  // survive it untouched, so nothing else here reacts.
  const unsubscribeRekey = controller.session.onRekey(() => {
    useChannelStore.getState().noteRekey();
  });

  // The desktop's revoke goodbye (see handleDesktopRevocation). Deferred a
  // microtask because this listener fires inside the session's own frame
  // handling, and the revocation handler tears that very session down.
  const unsubscribeRemoteClosed = controller.session.onRemoteClosed(() => {
    queueMicrotask(() => {
      void handleDesktopRevocation(controller);
    });
  });

  const teardownThisAttempt = (intent: ConnectionTeardownIntent): void => {
    inspectStateModule?.setInspectSubscriptions(null);
    bootstrapGeneration += 1;
    if (bootstrapRetryTimer) clearTimeout(bootstrapRetryTimer);
    unsubscribeTransportState();
    unsubscribeEstablished();
    unsubscribeRekey();
    unsubscribeRemoteClosed();
    unbindFeed();
    subscriptions.dispose();
    controller.dispose({ sendFinalFrame: intent === 'announce-departure' });
    mockDesktop?.dispose();
  };

  // The generation check at the top of this function guards the awaits BEFORE
  // the controller exists. Everything built since then has to be re-checked
  // here, because there are awaits in between (the inspect module's dynamic
  // import) and a close or a second open can land inside one.
  //
  // Dropping an attempt without this teardown does not leave it inert: its
  // transport is already dialing and reconnects on its own backoff forever,
  // and its onStateChange listener keeps writing into the shared channel
  // store. Two connections then fight over one store - the live one writing
  // 'connected' while the orphan writes 'reconnecting' - which is exactly the
  // status that was seen flickering on a phone whose session was fine. The
  // orphan can never recover either: the relay slot already holds the desktop
  // and the winning connection, so it is refused and loops.
  if (generation !== connectGeneration || activeConnection) {
    // This attempt never reached controller.connect(), so it has no session
    // to say goodbye on - silent by construction, not merely by guard.
    teardownThisAttempt('stay-silent');
    return;
  }

  useChannelStore.getState().setRelayUrl(anchor.relayAddress);
  activeConnection = { controller, verbs: controller.verbs, subscriptions };
  teardownActiveConnection = teardownThisAttempt;

  await controller.connect().catch(() => {
    // The transport keeps retrying with backoff on its own; channelStore
    // already reflects the connecting/reconnecting state.
  });
  // The desktop always initiates the KK handshake; the in-process fake one
  // is no exception.
  await mockDesktop?.start();
}

function closeConnection(intent: ConnectionTeardownIntent = 'stay-silent'): void {
  connectGeneration += 1;
  // Abandon any attempt still in flight rather than letting the next
  // openConnection join it: that attempt is bound to the OLD generation and
  // will bail, so joining it would return a connection that never opens.
  // It still tears itself down on the generation check.
  openAttempt = null;
  teardownActiveConnection?.(intent);
  teardownActiveConnection = null;
  activeConnection = null;
  useChannelStore.getState().reset();
}

/**
 * Ask for the runtime notification permission once, the first time a session
 * actually establishes. BOTH platforms: Android's POST_NOTIFICATIONS and iOS's
 * UNUserNotificationCenter authorization.
 *
 * Establishment IS the paired signal, which is what makes this one rule cover
 * both populations: an install that has been paired for weeks prompts on its
 * first establishment after updating (nothing else would ever reach it again),
 * and a fresh install prompts the moment pairing first connects rather than on
 * a cold first launch before the user knows what the app is.
 *
 * The permission was never requested anywhere before this - the function
 * existed and was exported, but its only callers were tests - so every Android
 * install ran with notifications silently undeliverable. iOS was worse and for
 * longer: this function returned early there, so iOS was NEVER asked, and the
 * failure was invisible because registration still succeeded.
 * getDevicePushTokenAsync only calls registerForRemoteNotifications(), which
 * yields an APNs token with no user authorization whatsoever - so the phone got
 * a token, the desktop sent, APNs delivered, and iOS discarded every alert.
 *
 * onEstablished re-fires on every reconnect, so the persisted flag is what
 * makes this once-ever, and it has to be read from a HYDRATED store:
 * startConnectionLifecycle runs before hydrate() resolves, and an
 * establishment that beats hydration would re-prompt someone who already
 * answered. (A rekey does NOT re-fire it - SessionManager routes an
 * already-established re-handshake to onRekey instead, as the bootstrap-retry
 * comment above also notes.)
 */
let notificationPermissionPromptInFlight = false;

function maybeRequestNotificationPermission(): void {
  // An open system dialog pauses the activity, which Android reports as a
  // background transition. In the modes where that transition closes the
  // channel ('push-only', or settings not yet hydrated) answering the prompt
  // reconnects and re-establishes, and that second onEstablished can land
  // before the persisted flag is written. This guard is what stops the user
  // being asked twice in a row. Under 'foreground-service' the keepalive holds
  // the channel open instead, so the race cannot arise there.
  if (notificationPermissionPromptInFlight) return;
  const settings = useSettingsStore.getState();
  if (!settings.hydrated) return;
  if (settings.backgroundNotificationsMode === 'off') return;
  // The persisted flag is the once-ever gate on Android, and the whole gate:
  // decided synchronously, nothing else to consult.
  //
  // On iOS the flag can OUTLIVE the authorization it describes. Keychain items
  // survive app deletion, so a reinstall starts with the flag still true while
  // iOS has reset authorization to NOT_DETERMINED - that install would never be
  // asked AND would be told in Settings that notifications are blocked. So iOS
  // falls through to ask the OS below instead of trusting the flag.
  const alreadyAsked = settings.hasRequestedNotificationPermission;
  if (alreadyAsked && Platform.OS !== 'ios') return;
  notificationPermissionPromptInFlight = true;
  void import('@/notifications/channels')
    .then(async ({ refreshNotificationPermission, requestNotificationPermission }) => {
      if (alreadyAsked) {
        // iOS only (Android returned above). READ THE OS, do not read the
        // cache: initializeNotifications seeds it fire-and-forget at bundle
        // entry, and nothing orders that against establishment, so a
        // synchronous read here can still be null - which would look like
        // "not not-determined" and silently skip the prompt on exactly the
        // reinstalled device this branch exists for. One extra native read per
        // establishment is the price, and it keeps the cache fresh besides.
        await refreshNotificationPermission();
        if (notificationPermissionStatus() !== 'not-determined') return;
      }
      // A denial resolves false rather than throwing, so the flag is still
      // written: neither platform re-shows the prompt after a refusal anyway
      // (Android stops after two dismissals, iOS asks exactly once ever), and
      // Settings carries the recovery route from there.
      await requestNotificationPermission();
      await useSettingsStore.getState().markNotificationPermissionRequested();
    })
    .catch(() => {
      // Leaving the flag unset retries on the next establishment, which is
      // the right side to fail on: a prompt that never appeared is worse
      // than one offered again.
    })
    .finally(() => {
      notificationPermissionPromptInFlight = false;
    });
}

/**
 * Hard ceiling on the background keepalive.
 *
 * Android 15+ gives a dataSync foreground service a cumulative 6h/24h budget
 * and kills the process with ForegroundServiceDidNotStopInTimeException when it
 * overruns; notifee 9.1.8 exposes no Service.onTimeout hook, so there is no
 * signal to react to and this timer is the only bound in the stack.
 *
 * It also bounds process LIFETIME, which is how it bears on the REACT-NATIVE-5
 * OOM. Do not read that as "the background path leaks": four measured probes
 * say it does not (see the developer guide). What an unbounded service did was
 * hold the process resident for hours, so ordinary FOREGROUND accumulation - a
 * session screen leaking a WebView per open - was never reset by an OS kill.
 * The ceiling makes the process reapable again; fixing the unmount is the
 * actual repair.
 *
 * Five minutes covers the case the keepalive is actually for - switched apps
 * for a moment - and puts budget exhaustion out of realistic reach: it would
 * take 72 separate background stretches, each running the full five minutes,
 * inside one 24h window. Anything longer is remote push's job, and push covers
 * the same alert categories: the desktop suppresses its own push only while
 * this phone's channel is established, so tearing the channel down hands
 * alerting over rather than dropping it.
 */
const BACKGROUND_KEEPALIVE_MAX_MS = 5 * 60_000;

let stopLocalNotifier: (() => void) | null = null;
let backgroundKeepaliveActive = false;
let keepaliveGeneration = 0;
let keepaliveCeilingTimer: ReturnType<typeof setTimeout> | null = null;

/** Foreground service + local notifier while backgrounded with the channel alive (Android, mode 'foreground-service'). */
function startBackgroundKeepalive(): void {
  if (backgroundKeepaliveActive) return;
  backgroundKeepaliveActive = true;
  keepaliveGeneration += 1;
  const generation = keepaliveGeneration;
  keepaliveCeilingTimer = setTimeout(() => {
    keepaliveCeilingTimer = null;
    if (generation !== keepaliveGeneration) return;
    // Order is load-bearing: stop THEN close. closeConnection() does not stop
    // the keepalive, so closing first would leave the foreground-service
    // notification posted with no channel behind it.
    stopBackgroundKeepalive();
    closeConnection();
  }, BACKGROUND_KEEPALIVE_MAX_MS);
  void import('@/notifications/foregroundService')
    .then(({ startConnectedForegroundService }) => {
      // A foreground bounce can beat the import; never start a stale service.
      if (generation !== keepaliveGeneration) return;
      return startConnectedForegroundService();
    })
    .catch(() => {
      // The service notification failing to post (permission denied) leaves
      // a plain background socket; the OS may reap it sooner, nothing worse.
    });
  void import('@/notifications/localNotifier')
    .then(({ startLocalNotifier }) => {
      if (generation !== keepaliveGeneration) return;
      stopLocalNotifier = startLocalNotifier();
    })
    .catch(() => {
      // Without the notifier the channel still stays alive; store state
      // simply surfaces on the next foreground instead.
    });
}

function stopBackgroundKeepalive(): void {
  // Before the early return: a timer with no active keepalive behind it is
  // exactly the state worth clearing, not one worth skipping.
  if (keepaliveCeilingTimer) {
    clearTimeout(keepaliveCeilingTimer);
    keepaliveCeilingTimer = null;
  }
  if (!backgroundKeepaliveActive) return;
  backgroundKeepaliveActive = false;
  keepaliveGeneration += 1;
  stopLocalNotifier?.();
  stopLocalNotifier = null;
  void import('@/notifications/foregroundService')
    .then(({ stopConnectedForegroundService }) => stopConnectedForegroundService())
    .catch(() => {
      // Already stopped or never started; nothing to clean up.
    });
}

function onAppStateChange(status: AppStateStatus): void {
  if (status === 'active') {
    stopBackgroundKeepalive();
    void openConnection();
    // Keeps the cache the background gate reads synchronously current: the
    // user can revoke the permission from system settings at any time, and
    // returning to the app is the only moment we get to notice. Android-only,
    // like every reader of that cache and like initializeNotifications itself -
    // otherwise this pulls notifee into the graph on every iOS foreground to
    // compute a value nothing on iOS ever reads.
    if (Platform.OS === 'android') {
      void import('@/notifications/channels')
        .then(({ refreshNotificationPermission }) => refreshNotificationPermission())
        .catch(() => {
          // Cache keeps its previous value; the gate fails open either way.
        });
    }
  } else if (status === 'background') {
    const settings = useSettingsStore.getState();
    const hasEstablishedConnection = activeConnection?.controller.session.isEstablished === true;
    // hydrated matters: startConnectionLifecycle runs before hydrate()
    // resolves, so an early background would otherwise read the in-memory
    // 'foreground-service' default and start a service a 'push-only' user
    // turned off. Unhydrated falls through to closeConnection, the safe side.
    //
    // A denied permission means the local notifier can display nothing, so the
    // service would burn the dataSync budget to deliver nothing at all.
    //
    // "Denied" has to mean ASKED AND REFUSED, which the cache alone cannot say:
    // Android has no NOT_DETERMINED status (notifee reports only DENIED or
    // AUTHORIZED there), so a permission nobody has requested yet reads exactly
    // like one the user refused. initializeNotifications seeds the cache at
    // boot, so on a never-granted install it holds `false` long before the
    // prompt fires - and gating on the cache alone would withdraw the keepalive
    // from every install that has not answered yet, which before this change
    // had it. The persisted flag is the only record of whether we ever asked.
    const notificationsKnownDenied =
      settings.hasRequestedNotificationPermission && notificationPermissionGranted() === false;
    const wantsKeepalive =
      Platform.OS === 'android' &&
      settings.hydrated &&
      settings.backgroundNotificationsMode === 'foreground-service' &&
      hasEstablishedConnection &&
      !notificationsKnownDenied;
    if (wantsKeepalive) {
      startBackgroundKeepalive();
    } else {
      closeConnection();
    }
  }
  // 'inactive' (iOS app switcher / permission dialog) is still-active.
}

/** Idempotent; called once from the root layout. */
export function startConnectionLifecycle(): void {
  if (appStateSubscription) return;
  // Dev-only inspect loop: the bridge dials the local inspect server once
  // per app boot and survives connection churn (it reads stores, not the
  // connection). Dynamic import keeps it out of prod bundles.
  if (__DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_INSPECT === '1') {
    void import('@/devsupport/inspectBridge').then(({ startInspectBridge }) => startInspectBridge());
  }
  appStateSubscription = AppState.addEventListener('change', onAppStateChange);
  if (AppState.currentState === 'active' || AppState.currentState === 'unknown') void openConnection();
}

export function stopConnectionLifecycle(): void {
  appStateSubscription?.remove();
  appStateSubscription = null;
  stopBackgroundKeepalive();
  closeConnection();
}

/**
 * For the pairing flow: pick up a freshly saved trust anchor without an app
 * restart. Callers reacting to a CHANGED trust context (unpair, a completed
 * pairing) must call actions.ts's wipeDesktopContent() first - this only
 * swaps the connection, it does not clear the previous desktop's content.
 *
 * The intent describes the CLOSE half only, not the reopen that always
 * follows - 'announce-departure' tells the OLD desktop this phone is
 * deliberately leaving it, which is exactly unpair's situation.
 */
export function reconnectNow(intent: ConnectionTeardownIntent = 'stay-silent'): void {
  // closeConnection() does not own the keepalive, so this has to. Without it a
  // ceiling timer armed by an earlier background would still be holding the OLD
  // generation, and would fire against the connection opened just below - a
  // teardown of a live foreground session five minutes later. Today's callers
  // are all foreground taps, and the 'active' transition has already stopped
  // the keepalive by then, so this is closing the invariant rather than fixing
  // a reachable bug.
  stopBackgroundKeepalive();
  closeConnection(intent);
  void openConnection();
}
