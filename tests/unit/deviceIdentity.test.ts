/**
 * DeviceIdentityManager's in-memory cache, and the hasCachedIdentity()
 * accessor the cold-launch connection trace reads to label its
 * `identity-ready cached=` field.
 *
 * The cache is MODULE scope, not per instance, which is the whole reason
 * that field can read true on a genuinely cold launch (any of the four
 * DeviceIdentityManager instances in the app warms it for all of them). That
 * is asserted here rather than left to the docstring, because it is the
 * property a future refactor to an instance field would silently break while
 * every other test stayed green.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

async function loadDeviceIdentity() {
  return import('@/pairing/deviceIdentity');
}

describe('DeviceIdentityManager.hasCachedIdentity', () => {
  beforeEach(() => {
    secureStoreState.storedValues.clear();
    // The mocked SecureStore functions are created once by the vi.mock
    // factory and survive resetModules, so their call counts accumulate
    // across tests unless cleared here - which is what made the write-count
    // assertion below read 3 instead of 1 on the first run.
    vi.clearAllMocks();
    vi.resetModules();
  });

  /**
   * The ordering contract the trace call site depends on: read it BEFORE
   * getIdentity(), because that call is what populates the cache.
   *
   * Mutation seen failing: changing `hasCachedIdentity` to
   * `return true;` made the first assertion fail - "expected true to be
   * false"; changing it to `return false;` made the second fail -
   * "expected false to be true".
   */
  it('is false before the first getIdentity() and true after it', async () => {
    const { DeviceIdentityManager } = await loadDeviceIdentity();
    const deviceIdentityManager = new DeviceIdentityManager();

    expect(deviceIdentityManager.hasCachedIdentity()).toBe(false);

    await deviceIdentityManager.getIdentity();

    expect(deviceIdentityManager.hasCachedIdentity()).toBe(true);
  });

  /**
   * The shared-cache property the trace's `cached` field inherits: a read
   * through ONE instance is visible through another, because cachedIdentity
   * is module scope. This is why the accessor's docstring says the field
   * reads conservatively and must not be branched on.
   *
   * Mutation seen failing: moving `cachedIdentity` from module scope to a
   * private instance field on DeviceIdentityManager made this fail -
   * "expected false to be true" on the second manager.
   */
  it('reports a cache warmed through a different instance', async () => {
    const { DeviceIdentityManager } = await loadDeviceIdentity();
    const warmingManager = new DeviceIdentityManager();
    const observingManager = new DeviceIdentityManager();

    expect(observingManager.hasCachedIdentity()).toBe(false);

    await warmingManager.getIdentity();

    expect(observingManager.hasCachedIdentity()).toBe(true);
  });

  /**
   * The cache is what SPARES the native round trip, which is the whole
   * reason the trace records `cached`. Asserting on getItemAsync is the only
   * assertion here that actually pins that: a second instance must not read
   * SecureStore again.
   *
   * Written the obvious way first, and it was wrong - worth recording,
   * because it is exactly the failure regression-tests-fail-first.md
   * describes. Asserting `setItemAsync` was called once, plus matching
   * public keys, stayed GREEN with `if (cachedIdentity) return cachedIdentity;`
   * deleted from getIdentity(): without the cache the second call still finds
   * the persisted secret, so it loads rather than generates, writes nothing,
   * and returns the same keypair. That version pinned persistence, not the
   * cache, while reading as though it pinned the cache.
   *
   * Mutation seen failing: deleting `if (cachedIdentity) return cachedIdentity;`
   * from getIdentity() now fails - "expected "vi.fn()" to be called 1 times,
   * but got 2 times" on the getItemAsync assertion (the setItemAsync one
   * above it stays green, which is the point).
   */
  it('resolves through a second instance without a second SecureStore read', async () => {
    const secureStore = await import('expo-secure-store');
    const { DeviceIdentityManager } = await loadDeviceIdentity();
    const firstIdentity = await new DeviceIdentityManager().getIdentity();
    const secondIdentity = await new DeviceIdentityManager().getIdentity();

    expect(Array.from(secondIdentity.publicKey)).toEqual(Array.from(firstIdentity.publicKey));
    expect(vi.mocked(secureStore.setItemAsync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(secureStore.getItemAsync)).toHaveBeenCalledTimes(1);
  });
});
