import { DeviceIdentityManager } from '@/pairing/deviceIdentity';

/**
 * The phone's static public key is the AAD the desktop seals every push
 * envelope with (openPushEnvelope's recipientStaticPublicKey), so decrypt
 * needs whichever identity the ACTIVE connection actually pairs under -
 * the SecureStore device identity normally, but the dev rig's injected
 * identity in dev-pairing mode and an ephemeral one in mock mode. The
 * connection manager sets it here whenever it resolves an identity; the
 * killed-app decrypt path (where no connection ever opened) falls back to
 * the persistent device identity.
 */

let activeIdentityPublicKey: Uint8Array | null = null;

const fallbackIdentityManager = new DeviceIdentityManager();

export function setActivePushIdentityPublicKey(publicKey: Uint8Array | null): void {
  activeIdentityPublicKey = publicKey;
}

export async function getPushIdentityPublicKey(): Promise<Uint8Array | null> {
  if (activeIdentityPublicKey) return activeIdentityPublicKey;
  try {
    const identity = await fallbackIdentityManager.getIdentity();
    return identity.publicKey;
  } catch {
    // SecureStore unavailable (locked device in a headless context): the
    // caller degrades to the generic placeholder.
    return null;
  }
}
