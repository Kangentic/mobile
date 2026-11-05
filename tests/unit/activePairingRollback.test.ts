/**
 * confirmActivePairing pins the trust anchor and then completes the ceremony. If
 * the ceremony raced to a terminal state in between, it rolls the anchor back
 * and reports why the ceremony failed. That rollback's delete can reject from
 * expo-secure-store 58 on, and it runs inside the catch, so a bare await there
 * would replace the ceremony's error with a Keychain one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateX25519KeyPair, PROTOCOL_VERSION, randomBytes, type PairingQrPayload, type Transport } from '@kangentic/protocol';
import { beginPairing, confirmActivePairing, resetActivePairing } from '@/pairing/activePairing';
import { usePairingStore } from '@/state/pairingStore';

const secureStoreState = vi.hoisted(() => ({ deletesFail: false, deletedKeys: [] as string[] }));

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (secureStoreState.deletesFail) throw new Error('Keychain delete failed');
    secureStoreState.deletedKeys.push(key);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.mock('@/pairing/deviceIdentity', () => ({
  DeviceIdentityManager: class {
    async getIdentity(): Promise<object> {
      return {};
    }
  },
}));

vi.mock('@/pairing/pairingMachine', () => ({
  PairingMachine: class {
    getState(): { status: string } {
      return { status: 'awaiting-sas' };
    }
    onStateChange(): () => void {
      return () => {};
    }
    async start(): Promise<void> {}
    reject(): void {}
    confirm(): void {
      throw new Error('The ceremony already ended');
    }
  },
}));

function buildPayload(): PairingQrPayload {
  return {
    desktopStaticPublicKey: generateX25519KeyPair().publicKey,
    pairingToken: randomBytes(32),
    relayAddress: 'wss://relay.example.test',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    protocolVersion: PROTOCOL_VERSION,
  };
}

describe('confirmActivePairing rollback', () => {
  afterEach(() => {
    resetActivePairing();
    usePairingStore.getState().reset();
    secureStoreState.deletesFail = false;
    secureStoreState.deletedKeys.length = 0;
  });

  it('rolls the anchor back and reports the ceremony failure', async () => {
    await beginPairing(buildPayload(), 'Test Device', { transport: {} as Transport });

    await expect(confirmActivePairing()).rejects.toThrow('The ceremony already ended');

    expect(secureStoreState.deletedKeys).toHaveLength(3);
  });

  it('still reports the ceremony failure when the rollback fails too', async () => {
    secureStoreState.deletesFail = true;
    await beginPairing(buildPayload(), 'Test Device', { transport: {} as Transport });

    await expect(confirmActivePairing()).rejects.toThrow('The ceremony already ended');
  });
});
