import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes } from '@kangentic/protocol';

const DESKTOP_STATIC_PUBLIC_KEY_STORAGE_KEY = 'trust.desktopStaticPublicKey';
const PAIRED_AT_STORAGE_KEY = 'trust.pairedAt';

/**
 * Device-bound so the paired-desktop pointer cannot ride an encrypted iOS
 * backup onto new hardware; together with the identity key's own binding
 * (deviceIdentity.ts) this stops a restored backup from reconstituting a
 * working paired client (secure-storage.md, docs/security.md).
 */
const DEVICE_BOUND_STORAGE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface TrustAnchor {
  desktopStaticPublicKey: Uint8Array;
  /** ISO 8601. */
  pairedAt: string;
}

/**
 * The phone's pinned trust anchor from a completed pairing ceremony: the
 * desktop's static public key (from the QR, confirmed by the SAS match),
 * used as the `remoteStatic` for every subsequent Noise KK session
 * handshake. Phase 1 supports exactly one paired desktop, matching the
 * pairing ceremony's own single-active-ceremony model.
 */
export class TrustAnchorStore {
  async save(anchor: TrustAnchor): Promise<void> {
    await SecureStore.setItemAsync(DESKTOP_STATIC_PUBLIC_KEY_STORAGE_KEY, bytesToHex(anchor.desktopStaticPublicKey), DEVICE_BOUND_STORAGE_OPTIONS);
    await SecureStore.setItemAsync(PAIRED_AT_STORAGE_KEY, anchor.pairedAt, DEVICE_BOUND_STORAGE_OPTIONS);
  }

  async load(): Promise<TrustAnchor | null> {
    const desktopStaticPublicKeyHex = await SecureStore.getItemAsync(DESKTOP_STATIC_PUBLIC_KEY_STORAGE_KEY);
    const pairedAt = await SecureStore.getItemAsync(PAIRED_AT_STORAGE_KEY);
    if (!desktopStaticPublicKeyHex || !pairedAt) return null;
    return { desktopStaticPublicKey: hexToBytes(desktopStaticPublicKeyHex), pairedAt };
  }

  async clear(): Promise<void> {
    await SecureStore.deleteItemAsync(DESKTOP_STATIC_PUBLIC_KEY_STORAGE_KEY);
    await SecureStore.deleteItemAsync(PAIRED_AT_STORAGE_KEY);
  }
}
