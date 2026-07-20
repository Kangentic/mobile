import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { ChannelController, SubscriptionManager, type VerbClient } from '@/channel';
import { DeviceIdentityManager } from '@/pairing/deviceIdentity';
import { TrustAnchorStore } from '@/pairing/trustAnchor';
import { setActivePushIdentityPublicKey } from '@/notifications/pushIdentity';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { bindFeedToStores, createSnapshotSinks } from './storeFeed';
import { runBootstrap } from './bootstrap';

// The notifee-backed notification modules (foreground service, local
// notifier, push registration) load lazily: notifee throws at import time
// when its native module is absent (Jest component tests reach this file
// through actions.ts), and the lifecycle only needs them at established/
// background time anyway. pushIdentity stays static - it is pure TS over
// the already-imported device identity.

/**
 * The app's one connection lifecycle owner, a module-level singleton
 * following the activePairing.ts pattern: a live ChannelController is a
 * stateful crypto object with a transport, not serializable UI state.
 * Screens read channelStore (which this feeds) and call actions.ts (which
 * reads the active connection from here).
 *
 * Lifecycle policy: connect while the app is foregrounded and paired.
 * On background it depends on settings: with backgroundNotificationsMode
 * 'foreground-service' (Android only) and an established connection, the
 * channel stays alive under a notifee foreground service and the local
 * notifier turns activity transitions into notifications; in every other
 * case ('push-only', 'off', iOS, or no established connection) the
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

export interface ActiveConnection {
  controller: ChannelController;
  verbs: VerbClient;
  subscriptions: SubscriptionManager;
}

const deviceIdentityManager = new DeviceIdentityManager();
const trustAnchorStore = new TrustAnchorStore();

let appStateSubscription: NativeEventSubscription | null = null;
let activeConnection: ActiveConnection | null = null;
let teardownActiveConnection: (() => void) | null = null;
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

async function openConnection(): Promise<void> {
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
  const unsubscribeEstablished = controller.session.onEstablished(() => {
    useChannelStore.getState().markEstablished();
    void runBootstrap(controller.verbs, subscriptions).catch(() => {
      // Bootstrap failures (a request timing out mid-rekey) self-heal on
      // the next established handshake; the stores keep their last state.
    });
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
  });

  useChannelStore.getState().setRelayUrl(anchor.relayAddress);
  activeConnection = { controller, verbs: controller.verbs, subscriptions };
  teardownActiveConnection = () => {
    inspectStateModule?.setInspectSubscriptions(null);
    unsubscribeTransportState();
    unsubscribeEstablished();
    unbindFeed();
    subscriptions.dispose();
    controller.dispose();
    mockDesktop?.dispose();
  };

  await controller.connect().catch(() => {
    // The transport keeps retrying with backoff on its own; channelStore
    // already reflects the connecting/reconnecting state.
  });
  // The desktop always initiates the KK handshake; the in-process fake one
  // is no exception.
  await mockDesktop?.start();
}

function closeConnection(): void {
  connectGeneration += 1;
  teardownActiveConnection?.();
  teardownActiveConnection = null;
  activeConnection = null;
  useChannelStore.getState().reset();
}

let stopLocalNotifier: (() => void) | null = null;
let backgroundKeepaliveActive = false;
let keepaliveGeneration = 0;

/** Foreground service + local notifier while backgrounded with the channel alive (Android, mode 'foreground-service'). */
function startBackgroundKeepalive(): void {
  if (backgroundKeepaliveActive) return;
  backgroundKeepaliveActive = true;
  keepaliveGeneration += 1;
  const generation = keepaliveGeneration;
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
  } else if (status === 'background') {
    const backgroundMode = useSettingsStore.getState().backgroundNotificationsMode;
    const hasEstablishedConnection = activeConnection?.controller.session.isEstablished === true;
    if (Platform.OS === 'android' && backgroundMode === 'foreground-service' && hasEstablishedConnection) {
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
 */
export function reconnectNow(): void {
  closeConnection();
  void openConnection();
}
