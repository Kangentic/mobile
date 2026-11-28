/**
 * The bootstrap's push repair (protocol 0.30.0, Sentry DESKTOP-5H). A desktop
 * that set a corrupt registrations file aside holds no registration for this
 * phone and says so on the project list (`pushRegistered: false`), while the
 * phone believes it registered earlier in this process. The bootstrap then
 * registers again; `true` and an absent field (an older desktop) leave it be.
 *
 * The REAL pushRegistration module runs here, because "registers although this
 * process already registered" is only provable through its own idempotence
 * check, and the project list travels the real VerbClient and the protocol's
 * decoder over the loopback, so a decoder that dropped the field (0.29.0 did)
 * fails these tests too.
 *
 * Mutations seen failing:
 * - dropping the reset in registerPushAgainWithDesktop: case 1 sends nothing;
 * - `=== false` loosened to a falsy check: the absent case sends;
 * - dropping the demo gate in runBootstrap: the demo case sends;
 * - dropping the 'off' check: the notifications-off case sends;
 * - registrations no longer queued: the cold-start case sends twice (only
 *   while the first is on the wire: a first one still waiting on its token
 *   finishes after the re-registration and skips by itself, so that is what
 *   the case holds);
 * - skipping the re-registration while another is in flight: the reconnect
 *   case sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateX25519KeyPair,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type JsonValue,
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { VerbClient } from '@/channel/verbClient';
import type { SubscriptionManager } from '@/channel/subscriptionManager';
import { runBootstrap } from '@/connection/bootstrap';
import { registerPushWithDesktop, resetPushRegistrationProcessState } from '@/notifications/pushRegistration';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { waitUntil } from '../helpers/async';

const EXPO_PUSH_TOKEN = 'ExponentPushToken[bootstrap]';

const secureStoreState = vi.hoisted(() => ({ storedValues: new Map<string, string>() }));
const expoNotificationsState = vi.hoisted(() => ({
  getExpoPushTokenAsync: vi.fn<(options?: { projectId?: string }) => Promise<{ type: 'expo'; data: string }>>(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreState.storedValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.storedValues.set(key, value);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

vi.mock('expo-constants', () => ({
  default: {
    easConfig: null,
    expoConfig: { extra: { eas: { projectId: 'project-id-from-config' } } },
  },
}));

vi.mock('expo-notifications', () => ({
  getExpoPushTokenAsync: expoNotificationsState.getExpoPushTokenAsync,
}));

// The NSE identity hand-off after a successful registration is not what these
// tests are about, so both halves are inert (pushRegistration.test.ts covers it).
vi.mock('@/notifications/pushIdentity', () => ({
  getPushIdentityPublicKey: vi.fn(async () => null),
}));

vi.mock('@/notifications/pushKeys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/notifications/pushKeys')>()),
  persistNsePushIdentityPublicKey: vi.fn(async () => undefined),
}));

interface Rig {
  verbs: VerbClient;
  subscriptions: SubscriptionManager;
  stub: StubSessionInitiator;
  /** What the next project list says; undefined omits the field, as an older desktop does. */
  setPushRegistered(value: boolean | undefined): void;
  /** Leaves the next register-push unanswered until released, so a registration can be caught on the wire. */
  holdNextRegisterPushAnswer(): { release: () => void };
  registrationsSent(): number;
}

async function flushLoopback(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Lets everything the bootstrap may have started finish: its lazy import of
 * pushRegistration, then the registration's token fetch, Keychain reads and
 * loopback round trip. Every positive case below asserts an exact count after
 * this same settle, and each one was seen failing by mutation, so it is long
 * enough for the negative cases to mean something.
 */
async function settle(): Promise<void> {
  await import('@/notifications/pushRegistration');
  await flushLoopback(16);
}

/**
 * Waits for every registration queued so far, deterministically: one with no
 * verbs queues behind them all and sends nothing. The "sends nothing" cases end
 * on it, so a re-registration that is merely slow cannot pass them by landing
 * after the assertion.
 */
async function drainRegistrations(): Promise<void> {
  await registerPushWithDesktop(null);
}

let rigs: StubSessionInitiator[] = [];

async function connectRig(): Promise<Rig> {
  const [phoneTransport, desktopTransport] = createLoopbackPair();
  await phoneTransport.connect();
  await desktopTransport.connect();
  const phoneIdentity = generateX25519KeyPair();
  const desktopIdentity = generateX25519KeyPair();
  const session = new SessionManager({
    identity: phoneIdentity,
    remoteStaticPublicKey: desktopIdentity.publicKey,
    transport: phoneTransport,
  });
  session.start();
  const stub = new StubSessionInitiator(desktopTransport, {
    desktopStatic: desktopIdentity,
    phoneStaticPublicKey: phoneIdentity.publicKey,
  });
  rigs.push(stub);

  let pushRegistered: boolean | undefined;
  let holdNextRegisterPush = false;
  const heldRegisterPushRequests: CapabilityRequestMessage[] = [];
  stub.setRequestHandler((request: CapabilityRequestMessage): CapabilityResponseMessage | null => {
    const payload = request.payload as { projectId?: string };
    if (request.verb === 'read-board' && !payload.projectId) {
      const projectList: JsonValue = {
        projects: [{ id: 'project-1', name: 'Alpha' }],
        ...(pushRegistered !== undefined ? { pushRegistered } : {}),
      };
      return { type: 'capability-response', requestId: request.requestId, ok: true, payload: projectList };
    }
    if (request.verb === 'register-push' && holdNextRegisterPush) {
      holdNextRegisterPush = false;
      heldRegisterPushRequests.push(request);
      return null;
    }
    if (request.verb === 'register-push') {
      return { type: 'capability-response', requestId: request.requestId, ok: true, payload: { registered: true } };
    }
    return { type: 'capability-response', requestId: request.requestId, ok: true };
  });

  stub.beginHandshake();
  await flushLoopback();

  // Only setDesiredBoards is reached; the board fan-out is bootstrap.test.ts's.
  const subscriptions = { setDesiredBoards: vi.fn() } as unknown as SubscriptionManager;
  return {
    verbs: new VerbClient(new CapabilityClient(session)),
    subscriptions,
    stub,
    setPushRegistered: (value) => {
      pushRegistered = value;
    },
    holdNextRegisterPushAnswer: () => {
      holdNextRegisterPush = true;
      return {
        release: () => {
          const heldRequest = heldRegisterPushRequests.shift();
          if (!heldRequest) throw new Error('no register-push was held');
          stub.send({ type: 'capability-response', requestId: heldRequest.requestId, ok: true, payload: { registered: true } });
        },
      };
    },
    registrationsSent: () =>
      stub.messages.filter(
        (message) =>
          message.type === 'capability-request' &&
          message.verb === 'register-push' &&
          (message.payload as { action?: string }).action === 'register',
      ).length,
  };
}

/** The established-handshake registration, as connectionManager.ts fires it, awaited to completion. */
async function registerOnEstablished(rig: Rig): Promise<void> {
  await registerPushWithDesktop(rig.verbs);
  expect(rig.registrationsSent()).toBe(1);
}

/** Holds the next Expo token fetch until released, so a registration can be caught in flight. */
function holdNextTokenFetch(): { release: () => void; reached: () => boolean } {
  let release: (() => void) | null = null;
  expoNotificationsState.getExpoPushTokenAsync.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ type: 'expo', data: EXPO_PUSH_TOKEN });
      }),
  );
  return {
    release: () => {
      if (!release) throw new Error('the held token fetch was never reached');
      release();
    },
    reached: () => release !== null,
  };
}

beforeEach(() => {
  secureStoreState.storedValues.clear();
  expoNotificationsState.getExpoPushTokenAsync.mockReset();
  expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: EXPO_PUSH_TOKEN });
  resetPushRegistrationProcessState();
  useSettingsStore.setState({ backgroundNotificationsMode: 'foreground-service' });
  useBoardStore.getState().reset();
});

afterEach(() => {
  for (const stub of rigs) stub.dispose();
  rigs = [];
  useSettingsStore.setState({ backgroundNotificationsMode: 'foreground-service' });
  useBoardStore.getState().reset();
});

describe('the bootstrap re-registers push when the desktop holds none', () => {
  it('registers again on pushRegistered: false, although this process already registered', async () => {
    const rig = await connectRig();
    await registerOnEstablished(rig);

    rig.setPushRegistered(false);
    await runBootstrap(rig.verbs, rig.subscriptions, { demoConnection: false });
    await settle();

    expect(rig.registrationsSent()).toBe(2);
    expect(useBoardStore.getState().projects).toEqual([{ id: 'project-1', name: 'Alpha' }]);
  });

  it('leaves the registration alone on pushRegistered: true', async () => {
    const rig = await connectRig();
    await registerOnEstablished(rig);

    rig.setPushRegistered(true);
    await runBootstrap(rig.verbs, rig.subscriptions, { demoConnection: false });
    await settle();
    await drainRegistrations();

    expect(rig.registrationsSent()).toBe(1);
  });

  it('leaves the registration alone when the field is absent (an older desktop, or one that cannot read its file)', async () => {
    const rig = await connectRig();
    await registerOnEstablished(rig);

    rig.setPushRegistered(undefined);
    await runBootstrap(rig.verbs, rig.subscriptions, { demoConnection: false });
    await settle();
    await drainRegistrations();

    expect(rig.registrationsSent()).toBe(1);
  });

  it('never registers for the demo pairing, which must stay networkless', async () => {
    const rig = await connectRig();

    rig.setPushRegistered(false);
    await runBootstrap(rig.verbs, rig.subscriptions, { demoConnection: true });
    await settle();
    await drainRegistrations();

    expect(rig.registrationsSent()).toBe(0);
    expect(expoNotificationsState.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('never registers with notifications off, though a desktop holds none for that phone on every bootstrap', async () => {
    useSettingsStore.setState({ backgroundNotificationsMode: 'off' });
    const rig = await connectRig();

    rig.setPushRegistered(false);
    await runBootstrap(rig.verbs, rig.subscriptions, { demoConnection: false });
    await settle();
    await drainRegistrations();

    expect(rig.registrationsSent()).toBe(0);
    expect(expoNotificationsState.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });
});

describe('a re-registration while the established-handshake one is in flight', () => {
  /**
   * A cold start: the project list arrives before the established
   * registration lands, still saying false. Here that
   * registration is already on the wire, past its idempotence check, with the
   * desktop's answer outstanding. The desktop upsert is idempotent, so two
   * sends would be harmless, but one is enough: the re-registration waits for
   * this one and then finds the process registered.
   */
  it('sends once on a cold start', async () => {
    const rig = await connectRig();
    const heldAnswer = rig.holdNextRegisterPushAnswer();
    const establishedRegistration = registerPushWithDesktop(rig.verbs);
    await waitUntil(() => rig.registrationsSent() === 1, { label: 'the established registration is on the wire' });

    rig.setPushRegistered(false);
    await runBootstrap(rig.verbs, rig.subscriptions, { demoConnection: false });
    await settle();
    heldAnswer.release();
    await establishedRegistration;
    await settle();

    expect(rig.registrationsSent()).toBe(1);
  });

  /**
   * DESKTOP-5H's usual shape: the desktop restarted with its file set aside, so
   * the phone RECONNECTS. This process registered earlier, so the established
   * registration in flight still believes it is registered and would send
   * nothing; skipping the re-registration because one is in flight would leave
   * push dead, the very bug this repairs.
   */
  it('sends once on a reconnect, where the in-flight one believes this process is registered', async () => {
    const rig = await connectRig();
    await registerOnEstablished(rig);

    const heldToken = holdNextTokenFetch();
    const establishedRegistration = registerPushWithDesktop(rig.verbs);
    await waitUntil(heldToken.reached, { label: 'the established registration is waiting on its token' });

    rig.setPushRegistered(false);
    await runBootstrap(rig.verbs, rig.subscriptions, { demoConnection: false });
    await settle();
    heldToken.release();
    await establishedRegistration;
    await settle();

    expect(rig.registrationsSent()).toBe(2);
  });
});
