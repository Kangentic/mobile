import * as SecureStore from 'expo-secure-store';
import { bytesToHex, hexToBytes, randomBytes } from '@kangentic/protocol';

const PUSH_DECRYPT_KEY_STORAGE_KEY = 'push.decrypt.key';
const LAST_REGISTERED_EXPO_TOKEN_STORAGE_KEY = 'push.expoToken.lastRegistered';

/** XChaCha20-Poly1305 key length the push envelope requires (the protocol root does not re-export its AEAD key-length constant). */
export const PUSH_KEY_LENGTH = 32;

/**
 * Mirrors src/pairing/deviceIdentity.ts: the push-decrypt key never leaves
 * the device it was generated on. A backup restored onto new hardware must
 * not carry a key the desktop still seals notifications with
 * (secure-storage.md).
 */
const DEVICE_BOUND_STORAGE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let cachedPushKey: Uint8Array | null = null;
let inFlightPushKey: Promise<Uint8Array> | null = null;
/**
 * Bumped by clearPushRegistration so a load that was already in flight when
 * the wipe landed cannot write its now-deleted key back into the cache.
 */
let pushKeyGeneration = 0;

/**
 * Base64url (RFC 4648 section 5, unpadded) - the encoding
 * `RegisterPushRequestPayload.pushKeyBase64` requires on the wire. The
 * protocol package implements the matching decoder internally but does not
 * export it from its root, and Hermes has no Buffer, so this is the one
 * local encoder. Pure and side-effect free for unit testing.
 */
const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64UrlEncode(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const firstByte = bytes[index];
    const secondByte = index + 1 < bytes.length ? bytes[index + 1] : null;
    const thirdByte = index + 2 < bytes.length ? bytes[index + 2] : null;
    encoded += BASE64_URL_ALPHABET[firstByte >> 2];
    encoded += BASE64_URL_ALPHABET[((firstByte & 0x03) << 4) | ((secondByte ?? 0) >> 4)];
    if (secondByte !== null) encoded += BASE64_URL_ALPHABET[((secondByte & 0x0f) << 2) | ((thirdByte ?? 0) >> 6)];
    if (thirdByte !== null) encoded += BASE64_URL_ALPHABET[thirdByte & 0x3f];
  }
  return encoded;
}

/**
 * Loads the 32-byte push-decrypt key from the Keychain/Keystore, generating
 * and persisting one on first use. The desktop receives it (base64url) via
 * the register-push verb and seals every notification envelope with it;
 * only this device can open them. The in-flight promise is shared so two
 * racing first-use callers cannot generate keys that clobber each other.
 */
export async function getOrCreatePushKey(): Promise<Uint8Array> {
  if (cachedPushKey) return cachedPushKey;
  if (!inFlightPushKey) {
    const generationAtLoadStart = pushKeyGeneration;
    inFlightPushKey = loadOrGeneratePushKey()
      .then((pushKey) => {
        // An unpair that landed mid-load wins: caching here unconditionally
        // would resurrect the just-wiped key in memory and hand it back to
        // the next getOrCreatePushKey caller in this process.
        if (generationAtLoadStart === pushKeyGeneration) cachedPushKey = pushKey;
        return pushKey;
      })
      .finally(() => {
        inFlightPushKey = null;
      });
  }
  return inFlightPushKey;
}

/**
 * The decrypt path's loader: returns null instead of generating, because a
 * freshly generated key can never open an envelope the desktop sealed with
 * the registered one - the caller degrades to the generic placeholder.
 */
export async function getPushKeyIfExists(): Promise<Uint8Array | null> {
  if (cachedPushKey) return cachedPushKey;
  const storedKeyHex = await SecureStore.getItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY);
  if (!storedKeyHex) return null;
  const pushKey = hexToBytes(storedKeyHex);
  if (pushKey.length !== PUSH_KEY_LENGTH) return null;
  cachedPushKey = pushKey;
  return pushKey;
}

/**
 * The last Expo push token successfully registered with the desktop, for
 * rotation detection. The token is a per-device bearer secret
 * (docs/architecture.md), so it lives in the secure store like every other
 * long-lived secret (secure-storage.md names it explicitly).
 */
export async function getLastRegisteredExpoToken(): Promise<string | null> {
  return SecureStore.getItemAsync(LAST_REGISTERED_EXPO_TOKEN_STORAGE_KEY);
}

export async function setLastRegisteredExpoToken(expoPushToken: string): Promise<void> {
  await SecureStore.setItemAsync(LAST_REGISTERED_EXPO_TOKEN_STORAGE_KEY, expoPushToken, DEVICE_BOUND_STORAGE_OPTIONS);
}

/**
 * Unpair must leave the old desktop unable to push: without this, the
 * desktop still holds a valid (expoPushToken, pushKey) pair after
 * unpairing and can send notifications this phone will happily decrypt
 * and display. Clears both secure-store entries and the in-memory cache
 * so a subsequent re-pair on this process generates a fresh key rather
 * than reusing the wiped one.
 */
export async function clearPushRegistration(): Promise<void> {
  pushKeyGeneration += 1;
  cachedPushKey = null;
  await SecureStore.deleteItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY);
  await SecureStore.deleteItemAsync(LAST_REGISTERED_EXPO_TOKEN_STORAGE_KEY);
}

async function loadOrGeneratePushKey(): Promise<Uint8Array> {
  const storedKeyHex = await SecureStore.getItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY);
  if (storedKeyHex) {
    const storedKey = hexToBytes(storedKeyHex);
    if (storedKey.length === PUSH_KEY_LENGTH) return storedKey;
  }
  const generatedKey = randomBytes(PUSH_KEY_LENGTH);
  await SecureStore.setItemAsync(PUSH_DECRYPT_KEY_STORAGE_KEY, bytesToHex(generatedKey), DEVICE_BOUND_STORAGE_OPTIONS);
  return generatedKey;
}
