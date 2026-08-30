/**
 * Push-key storage: 32-byte key generation + SecureStore persistence
 * round trip, the decrypt path's no-generate loader, base64url wire
 * encoding, the last-registered Expo token cache that backs rotation
 * detection, and the migration that moves the key into the Keychain access
 * group the iOS Notification Service Extension reads.
 *
 * THE MOCK IS OPTIONS-AWARE ON PURPOSE. expo-secure-store resolves an item by
 * (keychainService, accessGroup, key), so a mock keyed on the key alone would
 * make the pre-NSE location and the shared one indistinguishable and every
 * migration assertion below would pass vacuously.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@kangentic/protocol';

interface MockSecureStoreOptions {
  keychainService?: string;
  accessGroup?: string;
}

/**
 * Mirrors SecureStoreModule.swift's query builder: the service defaults to
 * "app" and the access group is part of the identity of the item. The backing
 * map lives outside the mock factory (vi.hoisted) so it survives
 * vi.resetModules() - the persistence the round-trip test needs - and is
 * cleared explicitly per test.
 */
const secureStoreState = vi.hoisted(() => {
  const storedValues = new Map<string, string>();
  const locationOf = (key: string, options?: { keychainService?: string; accessGroup?: string }): string =>
    `${options?.keychainService ?? 'app'}|${options?.accessGroup ?? 'default-group'}|${key}`;
  /**
   * Simulates a write that silently goes nowhere. A flag rather than
   * mockImplementationOnce on purpose: vi.clearAllMocks() does NOT drain a
   * once-queue, so an unconsumed stub leaks into a later test and swallows its
   * write. That is not hypothetical - it happened here, and it surfaced only
   * because the migration was mutated to check these tests really fail.
   */
  return { storedValues, locationOf, swallowWrites: false };
});

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(
    async (key: string, options?: MockSecureStoreOptions) =>
      secureStoreState.storedValues.get(secureStoreState.locationOf(key, options)) ?? null,
  ),
  setItemAsync: vi.fn(async (key: string, value: string, options?: MockSecureStoreOptions) => {
    if (secureStoreState.swallowWrites) return;
    secureStoreState.storedValues.set(secureStoreState.locationOf(key, options), value);
  }),
  deleteItemAsync: vi.fn(async (key: string, options?: MockSecureStoreOptions) => {
    secureStoreState.storedValues.delete(secureStoreState.locationOf(key, options));
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
}));

type PushKeysModule = typeof import('@/notifications/pushKeys');
type SharedKeychainModule = typeof import('@/notifications/sharedKeychain');

const SHARED_ACCESS_GROUP = 'ABCDE12345.com.kangentic.mobile.shared';
const SHARED_SERVICE = 'kangentic.push';

async function loadPushKeys(): Promise<PushKeysModule> {
  return import('@/notifications/pushKeys');
}

/** The pre-NSE home: default service, no access group. */
function legacyValue(key: string): string | undefined {
  return secureStoreState.storedValues.get(secureStoreState.locationOf(key));
}

function sharedValue(key: string): string | undefined {
  return secureStoreState.storedValues.get(
    secureStoreState.locationOf(key, { keychainService: SHARED_SERVICE, accessGroup: SHARED_ACCESS_GROUP }),
  );
}

function configureSharedKeychain(): void {
  process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP = SHARED_ACCESS_GROUP;
}

describe('pushKeys', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    secureStoreState.storedValues.clear();
    secureStoreState.swallowWrites = false;
    delete process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP;
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP;
  });

  it('generates a 32-byte key on first use and persists it as hex', async () => {
    const pushKeys = await loadPushKeys();
    const pushKey = await pushKeys.getOrCreatePushKey();
    expect(pushKey).toHaveLength(32);
    expect(legacyValue('push.decrypt.key')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips: a fresh module instance loads the same persisted key', async () => {
    const pushKeys = await loadPushKeys();
    const firstKey = await pushKeys.getOrCreatePushKey();

    vi.resetModules();
    const reloadedPushKeys = await loadPushKeys();
    const secondKey = await reloadedPushKeys.getOrCreatePushKey();
    expect(Array.from(secondKey)).toEqual(Array.from(firstKey));
  });

  it('shares one generation across concurrent first-use callers', async () => {
    const pushKeys = await loadPushKeys();
    const [firstKey, secondKey] = await Promise.all([pushKeys.getOrCreatePushKey(), pushKeys.getOrCreatePushKey()]);
    expect(firstKey).toBe(secondKey);
  });

  it('getPushKeyIfExists never generates: null when nothing is stored', async () => {
    const pushKeys = await loadPushKeys();
    expect(await pushKeys.getPushKeyIfExists()).toBeNull();
    expect(legacyValue('push.decrypt.key')).toBeUndefined();
  });

  it('getPushKeyIfExists rejects a stored key of the wrong length', async () => {
    secureStoreState.storedValues.set(secureStoreState.locationOf('push.decrypt.key'), 'deadbeef');
    const pushKeys = await loadPushKeys();
    expect(await pushKeys.getPushKeyIfExists()).toBeNull();
  });

  it('base64UrlEncode matches the reference base64url encoding for all remainder lengths', async () => {
    const pushKeys = await loadPushKeys();
    for (const length of [1, 2, 3, 31, 32, 33, 48]) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 89 + 251) % 256;
      expect(pushKeys.base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  it('caches and returns the last-registered Expo token (rotation detection source)', async () => {
    const pushKeys = await loadPushKeys();
    expect(await pushKeys.getLastRegisteredExpoToken()).toBeNull();
    await pushKeys.setLastRegisteredExpoToken('ExponentPushToken[first]');
    expect(await pushKeys.getLastRegisteredExpoToken()).toBe('ExponentPushToken[first]');
    await pushKeys.setLastRegisteredExpoToken('ExponentPushToken[rotated]');
    expect(await pushKeys.getLastRegisteredExpoToken()).toBe('ExponentPushToken[rotated]');
  });

  it('clearPushRegistration deletes both secure-store entries and the in-memory key cache', async () => {
    const pushKeys = await loadPushKeys();
    const originalKey = await pushKeys.getOrCreatePushKey();
    await pushKeys.setLastRegisteredExpoToken('ExponentPushToken[old]');
    expect(legacyValue('push.decrypt.key')).toBeDefined();

    await pushKeys.clearPushRegistration();

    expect(legacyValue('push.decrypt.key')).toBeUndefined();
    expect(legacyValue('push.expoToken.lastRegistered')).toBeUndefined();
    expect(await pushKeys.getLastRegisteredExpoToken()).toBeNull();

    // The in-memory cache is cleared too: a fresh key is generated next, not
    // the wiped one (an old desktop must not still be able to seal for it).
    const nextKey = await pushKeys.getOrCreatePushKey();
    expect(Array.from(nextKey)).not.toEqual(Array.from(originalKey));
  });

  it('a key load already in flight when clearPushRegistration runs cannot resurrect the wiped key', async () => {
    // Seed and persist a key, then drop the module so the next call really
    // hits SecureStore instead of the in-memory cache.
    const seedingModule = await loadPushKeys();
    const originalKey = await seedingModule.getOrCreatePushKey();
    const originalKeyHex = legacyValue('push.decrypt.key') ?? null;

    vi.resetModules();
    // Both imports must come from the SAME fresh module graph, or the mock
    // instance this test stubs is not the one pushKeys actually calls.
    const SecureStore = await import('expo-secure-store');
    const pushKeys = await loadPushKeys();

    // Hold the read open so the load is still in flight when the wipe lands.
    let releaseLoad: () => void = () => {};
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          releaseLoad = () => resolve(originalKeyHex);
        }),
    );

    const inFlightLoad = pushKeys.getOrCreatePushKey();
    await pushKeys.clearPushRegistration();
    releaseLoad();
    await inFlightLoad;

    // Without the generation guard the in-flight .then would have written the
    // just-wiped key back into the cache, and this would hand it straight back.
    const nextKey = await pushKeys.getOrCreatePushKey();
    expect(Array.from(nextKey)).not.toEqual(Array.from(originalKey));
  });
});

describe('pushKeys - shared Keychain migration for the iOS NSE', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    secureStoreState.storedValues.clear();
    secureStoreState.swallowWrites = false;
    delete process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP;
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP;
  });

  it('moves an existing key out of the pre-NSE location on first read', async () => {
    // An install that predates the NSE: the key sits under the default service
    // with no access group, where the extension cannot reach it.
    const existingKeyHex = 'a'.repeat(64);
    secureStoreState.storedValues.set(secureStoreState.locationOf('push.decrypt.key'), existingKeyHex);
    configureSharedKeychain();

    const pushKeys = await loadPushKeys();
    const pushKey = await pushKeys.getPushKeyIfExists();

    // Same key, new home. Losing it here would be silent: the desktop still
    // seals against it, so every push would degrade to the placeholder.
    expect(pushKey).not.toBeNull();
    expect(bytesToHex(pushKey as Uint8Array)).toBe(existingKeyHex);
    expect(sharedValue('push.decrypt.key')).toBe(existingKeyHex);
    expect(legacyValue('push.decrypt.key')).toBeUndefined();
  });

  it('keeps the legacy copy when the migrated copy does not read back', async () => {
    // The ordering that makes the migration interruption-safe. If the write
    // lands somewhere unreadable, deleting the old item would take the only
    // copy of the key with it.
    const existingKeyHex = 'b'.repeat(64);
    secureStoreState.storedValues.set(secureStoreState.locationOf('push.decrypt.key'), existingKeyHex);
    configureSharedKeychain();

    const pushKeys = await loadPushKeys();
    secureStoreState.swallowWrites = true;

    const pushKey = await pushKeys.getPushKeyIfExists();

    expect(bytesToHex(pushKey as Uint8Array)).toBe(existingKeyHex);
    expect(legacyValue('push.decrypt.key')).toBe(existingKeyHex);
  });

  it('does not re-migrate once the key already lives in the shared location', async () => {
    const existingKeyHex = 'c'.repeat(64);
    secureStoreState.storedValues.set(secureStoreState.locationOf('push.decrypt.key'), existingKeyHex);
    configureSharedKeychain();

    const firstLoad = await loadPushKeys();
    await firstLoad.getPushKeyIfExists();

    vi.resetModules();
    vi.clearAllMocks();
    const SecureStore = await import('expo-secure-store');
    const secondLoad = await loadPushKeys();
    const pushKey = await secondLoad.getPushKeyIfExists();

    expect(bytesToHex(pushKey as Uint8Array)).toBe(existingKeyHex);
    // One read of the shared location, and no write at all: the legacy probe
    // only runs when the shared read comes back empty.
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
  });

  it('writes a freshly generated key straight into the shared location', async () => {
    configureSharedKeychain();
    const pushKeys = await loadPushKeys();
    await pushKeys.getOrCreatePushKey();

    expect(sharedValue('push.decrypt.key')).toMatch(/^[0-9a-f]{64}$/);
    expect(legacyValue('push.decrypt.key')).toBeUndefined();
  });

  it('never migrates when no access group is configured', async () => {
    // The Android and unsigned-local path: there is no extension to share
    // with, so rewriting every install's key would be pure churn.
    const existingKeyHex = 'd'.repeat(64);
    secureStoreState.storedValues.set(secureStoreState.locationOf('push.decrypt.key'), existingKeyHex);

    const SecureStore = await import('expo-secure-store');
    const pushKeys = await loadPushKeys();
    await pushKeys.getPushKeyIfExists();

    expect(legacyValue('push.decrypt.key')).toBe(existingKeyHex);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('persists the identity public key for the NSE, hex, in the shared location', async () => {
    configureSharedKeychain();
    const pushKeys = await loadPushKeys();
    const identityPublicKey = new Uint8Array(32).fill(7);

    await pushKeys.persistNsePushIdentityPublicKey(identityPublicKey);

    // The AAD the desktop seals with. The NSE cannot derive it: deviceIdentity
    // stores only the SECRET key and re-derives the public one at load.
    expect(sharedValue('push.identity.pk')).toBe(bytesToHex(identityPublicKey));
  });

  it('does not persist the identity public key when there is no NSE to read it', async () => {
    const pushKeys = await loadPushKeys();
    await pushKeys.persistNsePushIdentityPublicKey(new Uint8Array(32).fill(7));
    expect(legacyValue('push.identity.pk')).toBeUndefined();
  });

  it('clearPushRegistration wipes the shared location, the legacy copy, and the identity public key', async () => {
    // An unpair must leave nothing readable behind, including a legacy copy an
    // interrupted migration never got round to deleting.
    const strandedKeyHex = 'e'.repeat(64);
    configureSharedKeychain();
    const pushKeys = await loadPushKeys();
    await pushKeys.getOrCreatePushKey();
    await pushKeys.persistNsePushIdentityPublicKey(new Uint8Array(32).fill(7));
    secureStoreState.storedValues.set(secureStoreState.locationOf('push.decrypt.key'), strandedKeyHex);

    await pushKeys.clearPushRegistration();

    expect(sharedValue('push.decrypt.key')).toBeUndefined();
    expect(legacyValue('push.decrypt.key')).toBeUndefined();
    expect(sharedValue('push.identity.pk')).toBeUndefined();
  });
});

describe('sharedKeychain options', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP;
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP;
  });

  it('uses AFTER_FIRST_UNLOCK plus the explicit service and group when configured', async () => {
    configureSharedKeychain();
    const sharedKeychain: SharedKeychainModule = await import('@/notifications/sharedKeychain');

    // AFTER_FIRST_UNLOCK is what makes the item readable by an extension woken
    // while the phone is locked, which is when almost every push arrives.
    expect(sharedKeychain.sharedPushStorageOptions()).toEqual({
      keychainAccessible: 'afterFirstUnlockThisDeviceOnly',
      keychainService: SHARED_SERVICE,
      accessGroup: SHARED_ACCESS_GROUP,
    });
    expect(sharedKeychain.usesSharedKeychain()).toBe(true);
  });

  it('falls back to the pre-NSE options when no group is configured', async () => {
    const sharedKeychain: SharedKeychainModule = await import('@/notifications/sharedKeychain');

    expect(sharedKeychain.sharedPushStorageOptions()).toEqual({
      keychainAccessible: 'whenUnlockedThisDeviceOnly',
    });
    expect(sharedKeychain.usesSharedKeychain()).toBe(false);
  });

  it('treats an empty group as absent, the shape a CI step output takes when it resolved to nothing', async () => {
    process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP = '';
    const sharedKeychain: SharedKeychainModule = await import('@/notifications/sharedKeychain');
    expect(sharedKeychain.usesSharedKeychain()).toBe(false);
  });
});
