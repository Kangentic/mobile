import { DeviceIdentityManager } from '@/pairing/deviceIdentity';
import { getNsePushIdentityPublicKeyIfExists } from './pushKeys';

/**
 * The phone's static public key is the AAD the desktop seals every push
 * envelope with (openPushEnvelope's recipientStaticPublicKey), so decrypt
 * needs whichever identity the ACTIVE connection actually pairs under -
 * the SecureStore device identity normally, but the dev rig's injected
 * identity in dev-pairing mode and an ephemeral one in mock mode. The
 * connection manager sets it here whenever it resolves an identity.
 *
 * With no connection open (a killed-app push, an iOS background launch for a
 * sealed clear) there are two fallbacks, in this order:
 *
 * 1. The copy the registration path stored for the iOS Notification Service
 *    Extension (pushKeys.ts). Read first because it is the identity the desktop
 *    actually registered against, and because it is readable while the phone is
 *    locked (`AFTER_FIRST_UNLOCK`). An iOS background launch is usually exactly
 *    that, and the secret below is `WHEN_UNLOCKED`. Absent on Android, where
 *    nothing writes it and the read is skipped.
 * 2. The persistent device identity, whose public key is re-derived from the
 *    stored secret. Android's headless task always lands here.
 */

let activeIdentityPublicKey: Uint8Array | null = null;

const fallbackIdentityManager = new DeviceIdentityManager();

export function setActivePushIdentityPublicKey(publicKey: Uint8Array | null): void {
  activeIdentityPublicKey = publicKey;
}

export async function getPushIdentityPublicKey(): Promise<Uint8Array | null> {
  if (activeIdentityPublicKey) return activeIdentityPublicKey;
  try {
    const sharedCopy = await getNsePushIdentityPublicKeyIfExists();
    if (sharedCopy) return sharedCopy;
  } catch {
    // Unreadable shared copy: fall through to the device identity.
  }
  try {
    const identity = await fallbackIdentityManager.getIdentity();
    return identity.publicKey;
  } catch {
    // SecureStore unavailable (locked device in a headless context): the
    // caller degrades to the generic placeholder.
    return null;
  }
}
