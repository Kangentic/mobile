/**
 * Push-key storage: 32-byte key generation + SecureStore persistence
 * round trip, the decrypt path's no-generate loader, base64url wire
 * encoding, and the last-registered Expo token cache that backs rotation
 * detection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The backing map lives outside the mock factory (vi.hoisted) so it
// survives vi.resetModules() - the persistence the round-trip test needs -
// and is cleared explicitly per test.
const secureStoreState = vi.hoisted(() => ({ storedValues: new Map<string, string>() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreState.storedValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.storedValues.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStoreState.storedValues.delete(key);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

type PushKeysModule = typeof import('@/notifications/pushKeys');

async function loadPushKeys(): Promise<PushKeysModule> {
  return import('@/notifications/pushKeys');
}

describe('pushKeys', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
  });

  it('generates a 32-byte key on first use and persists it as hex', async () => {
    const pushKeys = await loadPushKeys();
    const pushKey = await pushKeys.getOrCreatePushKey();
    expect(pushKey).toHaveLength(32);
    const storedHex = secureStoreState.storedValues.get('push.decrypt.key');
    expect(storedHex).toMatch(/^[0-9a-f]{64}$/);
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
    expect(secureStoreState.storedValues.has('push.decrypt.key')).toBe(false);
  });

  it('getPushKeyIfExists rejects a stored key of the wrong length', async () => {
    secureStoreState.storedValues.set('push.decrypt.key', 'deadbeef');
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
    expect(secureStoreState.storedValues.has('push.decrypt.key')).toBe(true);

    await pushKeys.clearPushRegistration();

    expect(secureStoreState.storedValues.has('push.decrypt.key')).toBe(false);
    expect(secureStoreState.storedValues.has('push.expoToken.lastRegistered')).toBe(false);
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
    const originalKeyHex = secureStoreState.storedValues.get('push.decrypt.key') ?? null;

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
