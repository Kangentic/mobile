import * as SecureStore from 'expo-secure-store';
import { bytesToHex, generateX25519KeyPair, hexToBytes, x25519PublicKeyFrom, type X25519KeyPair } from '@kangentic/protocol';

const IDENTITY_SECRET_KEY_STORAGE_KEY = 'device.identity.sk';

/**
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps the identity secret out of any
 * encrypted iOS backup, so it cannot be restored onto different hardware -
 * the per-device assumption in docs/security.md depends on the key never
 * leaving the device it was generated on (secure-storage.md).
 */
const DEVICE_BOUND_STORAGE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let cachedIdentity: X25519KeyPair | null = null;
let inFlightIdentity: Promise<X25519KeyPair> | null = null;

/**
 * Loads the phone's long-lived X25519 identity keypair from the Keychain/
 * Keystore, generating and persisting one on first use. Only the secret is
 * ever stored; the public key is re-derived on every load rather than
 * trusted from storage, so a corrupted or tampered public-key entry can
 * never desync from the secret it is supposed to pair with.
 */
export class DeviceIdentityManager {
  async getIdentity(): Promise<X25519KeyPair> {
    if (cachedIdentity) return cachedIdentity;
    // Share a single load/generate across concurrent callers: without this,
    // two racing first-use calls would each generate a keypair and clobber
    // one another in storage and in the cache.
    if (!inFlightIdentity) {
      inFlightIdentity = loadOrGenerateIdentity()
        .then((identity) => {
          cachedIdentity = identity;
          return identity;
        })
        .finally(() => {
          inFlightIdentity = null;
        });
    }
    return inFlightIdentity;
  }

  /** Hex-encoded public key. Matches the desktop's own roster deviceId derivation. */
  async getDeviceId(): Promise<string> {
    const identity = await this.getIdentity();
    return bytesToHex(identity.publicKey);
  }
}

async function loadOrGenerateIdentity(): Promise<X25519KeyPair> {
  const storedSecretKeyHex = await SecureStore.getItemAsync(IDENTITY_SECRET_KEY_STORAGE_KEY);
  if (storedSecretKeyHex) {
    const secretKey = hexToBytes(storedSecretKeyHex);
    return { secretKey, publicKey: x25519PublicKeyFrom(secretKey) };
  }

  const generated = generateX25519KeyPair();
  await SecureStore.setItemAsync(IDENTITY_SECRET_KEY_STORAGE_KEY, bytesToHex(generated.secretKey), DEVICE_BOUND_STORAGE_OPTIONS);
  return generated;
}
