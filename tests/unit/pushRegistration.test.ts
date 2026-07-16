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

interface Harness {
  pushRegistration: PushRegistrationModule;
  verbClientModule: VerbClientModule;
  registerPush: ReturnType<typeof vi.fn<(payload: RegisterPushRequestPayload) => Promise<RegisterPushResponsePayload>>>;
  verbs: { registerPush: (payload: RegisterPushRequestPayload) => Promise<RegisterPushResponsePayload> };
}

async function loadHarness(): Promise<Harness> {
  const pushRegistration = await import('@/notifications/pushRegistration');
  // Imported from the SAME fresh module graph so instanceof CapabilityError
  // inside the module matches the class this test constructs.
  const verbClientModule = await import('@/channel/verbClient');
  const registerPush = vi.fn<(payload: RegisterPushRequestPayload) => Promise<RegisterPushResponsePayload>>();
  return { pushRegistration, verbClientModule, registerPush, verbs: { registerPush } };
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
});
