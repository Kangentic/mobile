/**
 * On-device push decryption: fixtures are sealed with the REAL protocol
 * sealPushEnvelope, and every failure mode (missing key, tampered blob,
 * wrong recipient AAD, stale sentAt) must return null so the caller shows
 * the generic placeholder - never ciphertext, never plaintext
 * (e2e-notification-privacy.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bytesToHex,
  generateX25519KeyPair,
  randomBytes,
  sealPushEnvelope,
  type PushEnvelopePlaintext,
} from '@kangentic/protocol';

const secureStoreState = vi.hoisted(() => ({ storedValues: new Map<string, string>() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreState.storedValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.storedValues.set(key, value);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

type PushDecryptModule = typeof import('@/notifications/pushDecrypt');
type PushIdentityModule = typeof import('@/notifications/pushIdentity');

async function loadModules(): Promise<{ pushDecrypt: PushDecryptModule; pushIdentity: PushIdentityModule }> {
  const pushDecrypt = await import('@/notifications/pushDecrypt');
  const pushIdentity = await import('@/notifications/pushIdentity');
  return { pushDecrypt, pushIdentity };
}

function plaintextFixture(overrides: Partial<PushEnvelopePlaintext> = {}): PushEnvelopePlaintext {
  return {
    category: 'input-required',
    projectId: 'project-1',
    taskId: 'task-1',
    sessionId: 'sess-1',
    taskTitle: 'Fix the flaky test',
    detail: 'Bash: npm run test',
    sentAt: Date.now(),
    ...overrides,
  };
}

describe('decryptPushBlob', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
  });

  it('opens a real sealed envelope and maps category/title/body/data', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    const decrypted = await pushDecrypt.decryptPushBlob(blob);

    expect(decrypted).not.toBeNull();
    expect(decrypted?.title).toBe('Agent needs your input');
    expect(decrypted?.body).toBe('Fix the flaky test - Bash: npm run test');
    expect(decrypted?.category).toBe('input-required');
    expect(decrypted?.data).toEqual({ taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' });
  });

  it('maps every category to its human title', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const expectedTitles = {
      'input-required': 'Agent needs your input',
      'turn-complete': 'Agent went idle',
      'session-failed': 'Session stopped',
      'plan-complete': 'Plan complete',
      'spawn-stalled': 'Still preparing',
    } as const;
    for (const [category, expectedTitle] of Object.entries(expectedTitles)) {
      const blob = sealPushEnvelope(
        pushKey,
        identity.publicKey,
        plaintextFixture({ category: category as PushEnvelopePlaintext['category'], detail: '' }),
      );
      const decrypted = await pushDecrypt.decryptPushBlob(blob);
      expect(decrypted?.title).toBe(expectedTitle);
      expect(decrypted?.body).toBe('Fix the flaky test');
    }
  });

  it('falls back to the identity persisted in SecureStore when no active identity is set', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    secureStoreState.storedValues.set('device.identity.sk', bytesToHex(identity.secretKey));
    const { pushDecrypt } = await loadModules();

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    const decrypted = await pushDecrypt.decryptPushBlob(blob);
    expect(decrypted?.data.sessionId).toBe('sess-1');
  });

  it('returns null when no push key is stored', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    expect(await pushDecrypt.decryptPushBlob(blob)).toBeNull();
  });

  it('returns null on a tampered blob', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture());
    const tamperIndex = blob.length - 2;
    const replacementChar = blob[tamperIndex] === 'A' ? 'B' : 'A';
    const tamperedBlob = blob.slice(0, tamperIndex) + replacementChar + blob.slice(tamperIndex + 1);
    expect(await pushDecrypt.decryptPushBlob(tamperedBlob)).toBeNull();
    expect(await pushDecrypt.decryptPushBlob('not-a-blob')).toBeNull();
  });

  it('returns null when sealed for a different recipient (AAD mismatch)', async () => {
    const pushKey = randomBytes(32);
    const thisPhone = generateX25519KeyPair();
    const someOtherPhone = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(thisPhone.publicKey);

    const blob = sealPushEnvelope(pushKey, someOtherPhone.publicKey, plaintextFixture());
    expect(await pushDecrypt.decryptPushBlob(blob)).toBeNull();
  });

  it('returns null when sealed with a different push key', async () => {
    const registeredKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(registeredKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const blob = sealPushEnvelope(wrongKey, identity.publicKey, plaintextFixture());
    expect(await pushDecrypt.decryptPushBlob(blob)).toBeNull();
  });

  it('returns null on a stale envelope (sentAt older than the freshness window)', async () => {
    const pushKey = randomBytes(32);
    const identity = generateX25519KeyPair();
    secureStoreState.storedValues.set('push.decrypt.key', bytesToHex(pushKey));
    const { pushDecrypt, pushIdentity } = await loadModules();
    pushIdentity.setActivePushIdentityPublicKey(identity.publicKey);

    const staleSentAt = Date.now() - 25 * 60 * 60 * 1000;
    const blob = sealPushEnvelope(pushKey, identity.publicKey, plaintextFixture({ sentAt: staleSentAt }));
    expect(await pushDecrypt.decryptPushBlob(blob)).toBeNull();
  });

  it('exports the generic placeholder copy the callers degrade to', async () => {
    const { pushDecrypt } = await loadModules();
    expect(pushDecrypt.PUSH_PLACEHOLDER_TITLE).toBe('Kangentic');
    expect(pushDecrypt.PUSH_PLACEHOLDER_BODY).toBe('Agent needs attention');
  });
});
