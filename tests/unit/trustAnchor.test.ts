/**
 * Clearing the trust anchor has to reach every part of it. expo-secure-store 58
 * made an iOS delete reject on a Keychain failure, where 57 ignored them all, so
 * a clear that stopped at the first throw would leave the rest of the anchor on
 * disk. `load()` treats a partial anchor as unpaired, but the desktop's static
 * key and relay address would still be sitting in the Keychain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStoreState = vi.hoisted(() => ({
  deletedKeys: [] as string[],
  failingKeys: new Set<string>(),
}));

vi.mock('expo-secure-store', () => ({
  deleteItemAsync: vi.fn(async (key: string) => {
    if (secureStoreState.failingKeys.has(key)) throw new Error(`Keychain delete failed for ${key}`);
    secureStoreState.deletedKeys.push(key);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

import { TrustAnchorStore } from '@/pairing/trustAnchor';

const ANCHOR_KEYS = ['trust.desktopStaticPublicKey', 'trust.relayAddress', 'trust.pairedAt'];

describe('TrustAnchorStore.clear', () => {
  beforeEach(() => {
    secureStoreState.deletedKeys.length = 0;
    secureStoreState.failingKeys.clear();
  });

  it('deletes every part of the anchor', async () => {
    await new TrustAnchorStore().clear();

    expect(secureStoreState.deletedKeys).toEqual(ANCHOR_KEYS);
  });

  it('still deletes the rest when the first delete fails, then reports it', async () => {
    secureStoreState.failingKeys.add(ANCHOR_KEYS[0]);

    await expect(new TrustAnchorStore().clear()).rejects.toThrow(`Keychain delete failed for ${ANCHOR_KEYS[0]}`);

    expect(secureStoreState.deletedKeys).toEqual(ANCHOR_KEYS.slice(1));
  });
});
