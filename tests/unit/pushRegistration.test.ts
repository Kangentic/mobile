/**
 * Push registration over the channel: skips cleanly when FCM is absent
 * (getExpoPushTokenAsync throws without google-services.json), treats a
 * CapabilityError from an old/ungranting desktop as non-fatal, registers
 * the 32-byte push key base64url-encoded, and re-registers only when the
 * Expo token rotates. The status surface feeds the Settings UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterPushRequestPayload, RegisterPushResponsePayload } from '@kangentic/protocol';

const secureStoreState = vi.hoisted(() => ({
  storedValues: new Map<string, string>(),
  /**
   * One-shot: the next read of this key waits until `releaseHeldRead` is
   * called, so a registration can be caught inside a Keychain read.
   */
  holdNextReadOf: null as string | null,
  releaseHeldRead: null as (() => void) | null,
}));
const expoNotificationsState = vi.hoisted(() => ({
  getExpoPushTokenAsync: vi.fn<(options?: { projectId?: string }) => Promise<{ type: 'expo'; data: string }>>(),
}));
const pushIdentityState = vi.hoisted(() => ({
  getPushIdentityPublicKey: vi.fn<() => Promise<Uint8Array | null>>(),
}));
const pushKeysState = vi.hoisted(() => ({
  persistNsePushIdentityPublicKey: vi.fn<(identityPublicKey: Uint8Array) => Promise<void>>(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (secureStoreState.holdNextReadOf === key) {
      secureStoreState.holdNextReadOf = null;
      await new Promise<void>((resolve) => {
        secureStoreState.releaseHeldRead = resolve;
      });
    }
    return secureStoreState.storedValues.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.storedValues.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStoreState.storedValues.delete(key);
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

// The NSE identity-key hand-off (registerPushWithDesktop calling
// getPushIdentityPublicKey then persistNsePushIdentityPublicKey) is asserted
// as a mock call, so pushIdentity is mocked outright and pushKeys is
// partially mocked: every other pushKeys export (getOrCreatePushKey,
// base64UrlEncode, get/setLastRegisteredExpoToken) stays real, backed by the
// secureStoreState fake above, so the existing tests in this file keep
// exercising the real key round trip.
vi.mock('@/notifications/pushIdentity', () => ({
  getPushIdentityPublicKey: pushIdentityState.getPushIdentityPublicKey,
}));

vi.mock('@/notifications/pushKeys', async (importOriginal) => {
  const actualPushKeys = await importOriginal<typeof import('@/notifications/pushKeys')>();
  return {
    ...actualPushKeys,
    persistNsePushIdentityPublicKey: pushKeysState.persistNsePushIdentityPublicKey,
  };
});

type PushRegistrationModule = typeof import('@/notifications/pushRegistration');
type VerbClientModule = typeof import('@/channel/verbClient');
type SettingsStoreModule = typeof import('@/state/settingsStore');

interface Harness {
  pushRegistration: PushRegistrationModule;
  verbClientModule: VerbClientModule;
  settingsStoreModule: SettingsStoreModule;
  registerPush: ReturnType<typeof vi.fn<(payload: RegisterPushRequestPayload) => Promise<RegisterPushResponsePayload>>>;
  verbs: { registerPush: (payload: RegisterPushRequestPayload) => Promise<RegisterPushResponsePayload> };
}

async function loadHarness(): Promise<Harness> {
  const pushRegistration = await import('@/notifications/pushRegistration');
  // Imported from the SAME fresh module graph so instanceof CapabilityError
  // (and the settings store singleton) inside the module matches what this
  // test constructs/reads.
  const verbClientModule = await import('@/channel/verbClient');
  const settingsStoreModule = await import('@/state/settingsStore');
  // A push key an earlier test minted survives vi.resetModules in the real
  // pushKeys behind the partial mock, and is then returned from memory with no
  // Keychain read: 'registers with the token...' failed on its own second
  // repeat (`-t ... --repeats 1`) and under --sequence.shuffle until this. Drop
  // it, as an unpair would, so no test depends on running first.
  await (await import('@/notifications/pushKeys')).clearPushRegistration();
  const registerPush = vi.fn<(payload: RegisterPushRequestPayload) => Promise<RegisterPushResponsePayload>>();
  return { pushRegistration, verbClientModule, settingsStoreModule, registerPush, verbs: { registerPush } };
}

describe('registerPushWithDesktop', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
    expoNotificationsState.getExpoPushTokenAsync.mockReset();
    pushIdentityState.getPushIdentityPublicKey.mockReset();
    pushKeysState.persistNsePushIdentityPublicKey.mockReset();
  });

  it('starts pending and reports not-connected without a verb client', async () => {
    const { pushRegistration } = await loadHarness();
    expect(pushRegistration.getPushRegistrationStatus()).toBe('pending');
    await pushRegistration.registerPushWithDesktop(null);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('not-connected');
  });

  it('skips cleanly when FCM is unavailable (no google-services.json): status only, no verb call, no throw', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockRejectedValue(new Error('Default FirebaseApp is not initialized'));
    const { pushRegistration, registerPush, verbs } = await loadHarness();

    await expect(pushRegistration.registerPushWithDesktop(verbs)).resolves.toBeUndefined();

    expect(pushRegistration.getPushRegistrationStatus()).toBe('unavailable-no-fcm');
    expect(registerPush).not.toHaveBeenCalled();
  });

  it('registers with the token, the base64url 32-byte push key, and the platform', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });

    await pushRegistration.registerPushWithDesktop(verbs);

    expect(expoNotificationsState.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-id-from-config' });
    expect(registerPush).toHaveBeenCalledTimes(1);
    const payload = registerPush.mock.calls[0][0];
    expect(payload.action).toBe('register');
    expect(payload.expoPushToken).toBe('ExponentPushToken[alpha]');
    expect(payload.platform).toBe('android');
    // Sealed clears (protocol 0.23.0): the desktop sends none to a
    // registration without this, because a build that cannot handle one would
    // render it as the placeholder. Seen red with the field removed.
    expect(payload.acceptsClears).toBe(true);
    const sentKey = Buffer.from(payload.pushKeyBase64 ?? '', 'base64url');
    expect(sentKey).toHaveLength(32);
    expect(sentKey.toString('hex')).toBe(secureStoreState.storedValues.get('push.decrypt.key'));
    expect(pushRegistration.getPushRegistrationStatus()).toBe('registered');
    expect(secureStoreState.storedValues.get('push.expoToken.lastRegistered')).toBe('ExponentPushToken[alpha]');
  });

  it('treats a CapabilityError (old desktop / verb not granted) as non-fatal', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, verbClientModule, registerPush, verbs } = await loadHarness();
    registerPush.mockRejectedValue(new verbClientModule.CapabilityError('register-push', 'Unknown capability verb'));

    await expect(pushRegistration.registerPushWithDesktop(verbs)).resolves.toBeUndefined();

    expect(pushRegistration.getPushRegistrationStatus()).toBe('capability-denied');
  });

  it('is idempotent for an unchanged token but re-registers after rotation', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });

    await pushRegistration.registerPushWithDesktop(verbs);
    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush).toHaveBeenCalledTimes(1);

    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[rotated]' });
    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush).toHaveBeenCalledTimes(2);
    expect(registerPush.mock.calls[1][0].expoPushToken).toBe('ExponentPushToken[rotated]');
    expect(secureStoreState.storedValues.get('push.expoToken.lastRegistered')).toBe('ExponentPushToken[rotated]');
  });

  it('retries the verb call after a denial (a re-established grant should register)', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, verbClientModule, registerPush, verbs } = await loadHarness();
    registerPush.mockRejectedValueOnce(new verbClientModule.CapabilityError('register-push', 'Unknown capability verb'));
    registerPush.mockResolvedValue({ registered: true });

    await pushRegistration.registerPushWithDesktop(verbs);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('capability-denied');

    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush).toHaveBeenCalledTimes(2);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('registered');
  });

  it('a desktop answering registered:false is recorded as capability-denied', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: false });

    await pushRegistration.registerPushWithDesktop(verbs);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('capability-denied');
  });

  it('sends every category except spawn-stalled by default, and re-registers (not idempotent-skipped) when a category is toggled', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, settingsStoreModule, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });

    // spawn-stalled ("slow starts") defaults OFF, so the desktop is told not to
    // send it without the user having to find the toggle. workflow-complete
    // (protocol 0.21.0) defaults ON, in PUSH_CATEGORIES order (it is last).
    const defaultCategories = ['input-required', 'turn-complete', 'session-failed', 'plan-complete', 'workflow-complete'];
    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush.mock.calls[0][0].categories).toEqual(defaultCategories);

    await settingsStoreModule.useSettingsStore.getState().setPushCategoryEnabled('spawn-stalled', true);
    await pushRegistration.registerPushWithDesktop(verbs);

    expect(registerPush).toHaveBeenCalledTimes(2); // NOT skipped by the token-unchanged idempotence guard
    expect(registerPush.mock.calls[1][0].categories).toEqual([
      'input-required',
      'turn-complete',
      'session-failed',
      'plan-complete',
      'spawn-stalled',
      'workflow-complete',
    ]);

    // Revert the toggle: sameCategories compares the CURRENT category list
    // against whatever was registered last (now the 6-category list from the
    // call above), not against some remembered "have I ever seen this exact
    // set" latch. Turning spawn-stalled back off makes the current list (5
    // categories) unequal to the last-registered list (6), so this must hit
    // the wire again - a one-way latch that only re-registers on the FIRST
    // change away from the default would instead skip this call.
    await settingsStoreModule.useSettingsStore.getState().setPushCategoryEnabled('spawn-stalled', false);
    await pushRegistration.registerPushWithDesktop(verbs);

    expect(registerPush).toHaveBeenCalledTimes(3);
    expect(registerPush.mock.calls[2][0].categories).toEqual(defaultCategories);
  });
});

describe('registerPushWithDesktop - the registration queue', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
    secureStoreState.holdNextReadOf = null;
    secureStoreState.releaseHeldRead = null;
    expoNotificationsState.getExpoPushTokenAsync.mockReset();
    pushIdentityState.getPushIdentityPublicKey.mockReset();
    pushKeysState.persistNsePushIdentityPublicKey.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Holds the next Expo token fetch until released, so a registration can be caught waiting on it. */
  function holdNextTokenFetch(tokenValue: string): { release: () => void } {
    let releaseFetch: (() => void) | null = null;
    expoNotificationsState.getExpoPushTokenAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFetch = () => resolve({ type: 'expo', data: tokenValue });
        }),
    );
    return {
      release: () => {
        if (!releaseFetch) throw new Error('the held token fetch was never reached');
        releaseFetch();
      },
    };
  }

  async function flushMicrotasks(): Promise<void> {
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
  }

  /**
   * Mutation seen failing: replacing settledOrCapped(registrationQueue, ...)
   * with a plain registrationQueue.then(...), after which the second
   * registration never sends and the 30 s assertion fails.
   */
  it('stops waiting for a registration whose token fetch never settles after 30 s, and not before', async () => {
    vi.useFakeTimers();
    expoNotificationsState.getExpoPushTokenAsync.mockImplementationOnce(() => new Promise(() => undefined));
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });

    void pushRegistration.registerPushWithDesktop(verbs);
    const secondRegistration = pushRegistration.registerPushWithDesktop(verbs);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(registerPush).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // Asserted before awaiting, so a registration still stuck behind the first
    // fails here rather than as a timeout.
    await vi.waitFor(() => expect(registerPush).toHaveBeenCalledTimes(1));
    await secondRegistration;
    expect(registerPush.mock.calls[0][0].action).toBe('register');
    expect(pushRegistration.getPushRegistrationStatus()).toBe('registered');
  });

  it('does not wait out the cap when the previous registration settles: a later one runs at once', async () => {
    vi.useFakeTimers();
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: false });

    await pushRegistration.registerPushWithDesktop(verbs);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('capability-denied');

    registerPush.mockResolvedValue({ registered: true });
    await pushRegistration.registerPushWithDesktop(verbs);

    expect(registerPush).toHaveBeenCalledTimes(2);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('registered');
  });

  /**
   * Mutation seen failing: deleting the `unregisterGeneration += 1;` line, after
   * which the held registration sends a register after the unregister.
   */
  it('an unregister cancels a registration waiting on its token fetch: nothing is sent or minted after it', async () => {
    const heldToken = holdNextTokenFetch('ExponentPushToken[alpha]');
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });

    const waitingRegistration = pushRegistration.registerPushWithDesktop(verbs);
    await flushMicrotasks();
    await pushRegistration.unregisterPushWithDesktop(verbs);

    heldToken.release();
    await waitingRegistration;

    expect(registerPush.mock.calls.map(([payload]) => payload.action)).toEqual(['unregister']);
    // No push key was minted after the unpair's wipe.
    expect(secureStoreState.storedValues.has('push.decrypt.key')).toBe(false);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('pending');

    // The cancelled registration left nothing marked registered, so a re-pair
    // with the same desktop in this process registers afresh.
    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush.mock.calls.map(([payload]) => payload.action)).toEqual(['unregister', 'register']);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('registered');
  });

  /**
   * Mutation seen failing: deleting the check after `await verbs.registerPush`,
   * after which the late answer marks this process registered and the fresh
   * registration below is skipped as already done.
   */
  it('an unregister during a register on the wire stops its answer being recorded', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    let answerRegister: (() => void) | null = null;
    registerPush.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerRegister = () => resolve({ registered: true });
        }),
    );
    registerPush.mockResolvedValue({ registered: true });

    const registrationOnTheWire = pushRegistration.registerPushWithDesktop(verbs);
    await vi.waitFor(() => expect(answerRegister).not.toBeNull());
    await pushRegistration.unregisterPushWithDesktop(verbs);
    (answerRegister as unknown as () => void)();
    await registrationOnTheWire;

    expect(pushRegistration.getPushRegistrationStatus()).toBe('pending');
    expect(secureStoreState.storedValues.has('push.expoToken.lastRegistered')).toBe(false);

    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush.mock.calls.map(([payload]) => payload.action)).toEqual(['register', 'unregister', 'register']);
  });

  /**
   * Past the token fetch and its cancel check, but not yet on the wire: the
   * unregister lands while the push key is read from the Keychain. The
   * register built after that read must not follow the unregister out.
   *
   * Mutation seen failing: deleting the check between the key read and
   * `verbs.registerPush`, after which the actions read
   * ['unregister', 'register'] (the device is put back on the desktop it left).
   */
  it('an unregister during the push key read cancels the register that read was building', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });
    // loadHarness dropped any cached key, so this read reaches the Keychain.
    secureStoreState.holdNextReadOf = 'push.decrypt.key';

    const registrationReadingKey = pushRegistration.registerPushWithDesktop(verbs);
    await vi.waitFor(() => expect(secureStoreState.releaseHeldRead).not.toBeNull());
    await pushRegistration.unregisterPushWithDesktop(verbs);
    (secureStoreState.releaseHeldRead as unknown as () => void)();
    await registrationReadingKey;

    expect(registerPush.mock.calls.map(([payload]) => payload.action)).toEqual(['unregister']);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('pending');

    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush.mock.calls.map(([payload]) => payload.action)).toEqual(['unregister', 'register']);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('registered');
  });

  /**
   * A registration cancelled while it still waits in the queue, behind one
   * held on its token fetch: it notes the unregister generation when it is
   * QUEUED, not when its turn comes, so an unpair before its turn cancels it.
   *
   * Mutation seen failing: reading the generation inside the queue's `.then`
   * callback in registerPushWithDesktop instead of before it, after which the
   * queued registration sends a register after the unregister.
   */
  it('an unregister cancels a registration still waiting in the queue behind another', async () => {
    const heldToken = holdNextTokenFetch('ExponentPushToken[alpha]');
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });

    const firstRegistration = pushRegistration.registerPushWithDesktop(verbs);
    const queuedRegistration = pushRegistration.registerPushWithDesktop(verbs);
    await flushMicrotasks();
    await pushRegistration.unregisterPushWithDesktop(verbs);

    heldToken.release();
    await firstRegistration;
    await queuedRegistration;

    expect(registerPush.mock.calls.map(([payload]) => payload.action)).toEqual(['unregister']);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('pending');

    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush.mock.calls.map(([payload]) => payload.action)).toEqual(['unregister', 'register']);
  });
});

describe('registerPushWithDesktop - NSE identity key hand-off', () => {
  // That stored public key is the AAD the Notification Service Extension
  // needs to open every push envelope: if this call silently stops firing,
  // every iOS notification degrades to the generic placeholder while every
  // OTHER part of registration still reports success, so nothing else in
  // this file would catch the regression.
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
    expoNotificationsState.getExpoPushTokenAsync.mockReset();
    pushIdentityState.getPushIdentityPublicKey.mockReset();
    pushKeysState.persistNsePushIdentityPublicKey.mockReset();
  });

  it('persists the identity public key getPushIdentityPublicKey resolved after a successful registration', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });
    const resolvedIdentityPublicKey = new Uint8Array(32).fill(0x42);
    pushIdentityState.getPushIdentityPublicKey.mockResolvedValue(resolvedIdentityPublicKey);
    pushKeysState.persistNsePushIdentityPublicKey.mockResolvedValue(undefined);

    await pushRegistration.registerPushWithDesktop(verbs);

    expect(pushKeysState.persistNsePushIdentityPublicKey).toHaveBeenCalledTimes(1);
    // The exact object getPushIdentityPublicKey resolved, not a re-derived
    // copy: this is the key the ACTIVE registration used, and persisting a
    // different one would pin the NSE's AAD to the wrong identity.
    expect(pushKeysState.persistNsePushIdentityPublicKey).toHaveBeenCalledWith(resolvedIdentityPublicKey);
  });

  it('does not persist when getPushIdentityPublicKey resolves null (SecureStore unavailable)', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });
    pushIdentityState.getPushIdentityPublicKey.mockResolvedValue(null);

    await pushRegistration.registerPushWithDesktop(verbs);

    expect(pushKeysState.persistNsePushIdentityPublicKey).not.toHaveBeenCalled();
  });

  it('does not persist when the desktop denies registration (registered: false)', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: false });
    // A key IS available; the assertion below must fail for the registered:false
    // gate, not merely because nothing was there to persist.
    pushIdentityState.getPushIdentityPublicKey.mockResolvedValue(new Uint8Array(32).fill(0x99));

    await pushRegistration.registerPushWithDesktop(verbs);

    expect(pushRegistration.getPushRegistrationStatus()).toBe('capability-denied');
    expect(pushIdentityState.getPushIdentityPublicKey).not.toHaveBeenCalled();
    expect(pushKeysState.persistNsePushIdentityPublicKey).not.toHaveBeenCalled();
  });
});

describe('unregisterPushWithDesktop', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
    expoNotificationsState.getExpoPushTokenAsync.mockReset();
    pushIdentityState.getPushIdentityPublicKey.mockReset();
    pushKeysState.persistNsePushIdentityPublicKey.mockReset();
  });

  it('sends the unregister action and resets local status to pending', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });
    await pushRegistration.registerPushWithDesktop(verbs);
    expect(pushRegistration.getPushRegistrationStatus()).toBe('registered');
    registerPush.mockClear();

    registerPush.mockResolvedValue({ registered: false });
    await pushRegistration.unregisterPushWithDesktop(verbs);

    expect(registerPush).toHaveBeenCalledWith({ action: 'unregister' });
    expect(pushRegistration.getPushRegistrationStatus()).toBe('pending');
  });

  it('is a no-op that still resets status when there is no verb client', async () => {
    const { pushRegistration } = await loadHarness();
    await expect(pushRegistration.unregisterPushWithDesktop(null)).resolves.toBeUndefined();
    expect(pushRegistration.getPushRegistrationStatus()).toBe('pending');
  });

  it('never throws even when the desktop rejects the unregister call', async () => {
    const { pushRegistration, verbClientModule, registerPush, verbs } = await loadHarness();
    registerPush.mockRejectedValue(new verbClientModule.CapabilityError('register-push', 'transport closed'));
    await expect(pushRegistration.unregisterPushWithDesktop(verbs)).resolves.toBeUndefined();
  });

  it('resets registeredThisProcess so a same-process re-register hits the wire again', async () => {
    expoNotificationsState.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[alpha]' });
    const { pushRegistration, registerPush, verbs } = await loadHarness();
    registerPush.mockResolvedValue({ registered: true });
    await pushRegistration.registerPushWithDesktop(verbs);
    await pushRegistration.unregisterPushWithDesktop(verbs);
    registerPush.mockClear();
    registerPush.mockResolvedValue({ registered: true });

    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush).toHaveBeenCalledTimes(1); // not skipped by stale "already registered" bookkeeping
  });
});
