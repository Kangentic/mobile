/**
 * Push registration over the channel: skips cleanly when FCM is absent
 * (getExpoPushTokenAsync throws without google-services.json), treats a
 * CapabilityError from an old/ungranting desktop as non-fatal, registers
 * the 32-byte push key base64url-encoded, and re-registers only when the
 * Expo token rotates. The status surface feeds the Settings UI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterPushRequestPayload, RegisterPushResponsePayload } from '@kangentic/protocol';

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
  const registerPush = vi.fn<(payload: RegisterPushRequestPayload) => Promise<RegisterPushResponsePayload>>();
  return { pushRegistration, verbClientModule, settingsStoreModule, registerPush, verbs: { registerPush } };
}

describe('registerPushWithDesktop', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
    expoNotificationsState.getExpoPushTokenAsync.mockReset();
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
    // send it without the user having to find the toggle.
    await pushRegistration.registerPushWithDesktop(verbs);
    expect(registerPush.mock.calls[0][0].categories).toEqual(['input-required', 'turn-complete', 'session-failed', 'plan-complete']);

    await settingsStoreModule.useSettingsStore.getState().setPushCategoryEnabled('spawn-stalled', true);
    await pushRegistration.registerPushWithDesktop(verbs);

    expect(registerPush).toHaveBeenCalledTimes(2); // NOT skipped by the token-unchanged idempotence guard
    expect(registerPush.mock.calls[1][0].categories).toEqual([
      'input-required',
      'turn-complete',
      'session-failed',
      'plan-complete',
      'spawn-stalled',
    ]);

    // Revert the toggle: sameCategories compares the CURRENT category list
    // against whatever was registered last (now the 5-category list from the
    // call above), not against some remembered "have I ever seen this exact
    // set" latch. Turning spawn-stalled back off makes the current list (4
    // categories) unequal to the last-registered list (5), so this must hit
    // the wire again - a one-way latch that only re-registers on the FIRST
    // change away from the default would instead skip this call.
    await settingsStoreModule.useSettingsStore.getState().setPushCategoryEnabled('spawn-stalled', false);
    await pushRegistration.registerPushWithDesktop(verbs);

    expect(registerPush).toHaveBeenCalledTimes(3);
    expect(registerPush.mock.calls[2][0].categories).toEqual(['input-required', 'turn-complete', 'session-failed', 'plan-complete']);
  });
});

describe('unregisterPushWithDesktop', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
    expoNotificationsState.getExpoPushTokenAsync.mockReset();
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
