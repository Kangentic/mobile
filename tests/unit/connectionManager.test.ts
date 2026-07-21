/**
 * revokePushRegistrationForUnpair and resyncPushRegistrationCategories are
 * the two lazy-loaded push-registration hooks the connection manager owns
 * (see the doc comments on both in src/connection/connectionManager.ts).
 * This file mocks their heavy imports as inert stubs so the rest of the
 * module (channel, stores, bootstrap) can load for real in the node/vitest
 * tier - the same shape as tests/unit/wipeDesktopContent.test.ts (mocks
 * @/connection/bootstrap) and tests/unit/pushRegistration.test.ts (mocks
 * react-native).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resyncPushRegistrationCategories, revokePushRegistrationForUnpair } from '@/connection/connectionManager';

const pushRegistrationMocks = vi.hoisted(() => ({
  unregisterPushWithDesktop: vi.fn<(verbs: unknown) => Promise<void>>(),
  registerPushWithDesktop: vi.fn<(verbs: unknown) => Promise<void>>(),
}));
const pushKeysMocks = vi.hoisted(() => ({
  clearPushRegistration: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/notifications/pushRegistration', () => ({
  unregisterPushWithDesktop: pushRegistrationMocks.unregisterPushWithDesktop,
  registerPushWithDesktop: pushRegistrationMocks.registerPushWithDesktop,
}));
vi.mock('@/notifications/pushKeys', () => ({
  clearPushRegistration: pushKeysMocks.clearPushRegistration,
}));

// connectionManager.ts imports AppState/Platform statically; neither
// revokePushRegistrationForUnpair nor resyncPushRegistrationCategories
// touches AppState, so a minimal stub is enough to let the module load.
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: { OS: 'android' },
}));

// deviceIdentity.ts and trustAnchor.ts (both statically imported by
// connectionManager.ts) read/write expo-secure-store at module use time,
// never at import time, but they still need the module to resolve.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

/**
 * These tests never call openConnection/startConnectionLifecycle, so the
 * module-level activeConnection singleton stays null throughout - exactly
 * the "unpair before ever reconnecting" and "disconnected settings toggle"
 * shapes both exported functions exist for.
 */
describe('revokePushRegistrationForUnpair', () => {
  beforeEach(() => {
    pushRegistrationMocks.unregisterPushWithDesktop.mockReset();
    pushKeysMocks.clearPushRegistration.mockReset();
  });

  it('still wipes the local push key even when unregisterPushWithDesktop rejects (regression guard: two independent try blocks)', async () => {
    pushRegistrationMocks.unregisterPushWithDesktop.mockRejectedValue(new Error('relay unreachable'));
    pushKeysMocks.clearPushRegistration.mockResolvedValue(undefined);

    await revokePushRegistrationForUnpair();

    // Against the original single-try-block version, a throw from the
    // unregister call would have skipped this entirely and left a usable
    // push key behind on an unpaired phone.
    expect(pushKeysMocks.clearPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('calls unregisterPushWithDesktop before clearPushRegistration', async () => {
    pushRegistrationMocks.unregisterPushWithDesktop.mockResolvedValue(undefined);
    pushKeysMocks.clearPushRegistration.mockResolvedValue(undefined);

    await revokePushRegistrationForUnpair();

    expect(pushRegistrationMocks.unregisterPushWithDesktop).toHaveBeenCalledTimes(1);
    expect(pushKeysMocks.clearPushRegistration).toHaveBeenCalledTimes(1);
    const unregisterCallOrder = pushRegistrationMocks.unregisterPushWithDesktop.mock.invocationCallOrder[0];
    const clearCallOrder = pushKeysMocks.clearPushRegistration.mock.invocationCallOrder[0];
    expect(unregisterCallOrder).toBeLessThan(clearCallOrder);
  });

  it('passes null, not undefined, to unregisterPushWithDesktop when no connection was ever opened', async () => {
    pushRegistrationMocks.unregisterPushWithDesktop.mockResolvedValue(undefined);
    pushKeysMocks.clearPushRegistration.mockResolvedValue(undefined);

    await revokePushRegistrationForUnpair();

    expect(pushRegistrationMocks.unregisterPushWithDesktop).toHaveBeenCalledWith(null);
    // toHaveBeenCalledWith(null) alone would also pass a call with undefined
    // for some matcher implementations; assert the actual argument directly.
    expect(pushRegistrationMocks.unregisterPushWithDesktop.mock.calls[0][0]).toBe(null);
  });
});

describe('resyncPushRegistrationCategories', () => {
  beforeEach(() => {
    pushRegistrationMocks.registerPushWithDesktop.mockReset();
  });

  it('calls registerPushWithDesktop(null) exactly once while disconnected', async () => {
    pushRegistrationMocks.registerPushWithDesktop.mockResolvedValue(undefined);

    await resyncPushRegistrationCategories();

    expect(pushRegistrationMocks.registerPushWithDesktop).toHaveBeenCalledTimes(1);
    expect(pushRegistrationMocks.registerPushWithDesktop.mock.calls[0][0]).toBe(null);
  });

  it('swallows a rejection from registerPushWithDesktop without throwing', async () => {
    pushRegistrationMocks.registerPushWithDesktop.mockRejectedValue(new Error('transport closed'));

    await expect(resyncPushRegistrationCategories()).resolves.toBeUndefined();
  });
});
